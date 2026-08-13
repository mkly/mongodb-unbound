import { describe, expect, test } from "bun:test";

import {
  correlateActivity,
  createActivityStream,
  type JsonlFileAdapter,
  type MongoActivityAdapter,
  type MongoChange,
  streamJsonlActivity,
  streamJsonlFile,
  streamMongoActivity,
} from "./activity.ts";

async function collect<T>(
  source: AsyncIterable<T>,
  count?: number,
): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
    if (count !== undefined && values.length >= count) break;
  }
  return values;
}

function telemetry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "db_write",
    event_id: "event-1",
    timestamp: "2026-08-13T20:00:00Z",
    run_id: "run-1",
    task_id: "task-1",
    agent_id: "agent-1",
    condition: "shared",
    operation: "insert",
    collection: "notes",
    document_id: "doc-1",
    ...overrides,
  });
}

class ChunkFile implements JsonlFileAdapter {
  private index = 0;

  constructor(
    private readonly chunks: string[],
    private readonly abort?: AbortController,
  ) {}

  async readFrom(_path: string, offset: number) {
    const text = this.chunks[this.index] ?? "";
    this.index += 1;
    return { text, nextOffset: offset + text.length };
  }

  async waitForChange() {
    if (this.index >= this.chunks.length) this.abort?.abort();
  }
}

describe("streamJsonlFile", () => {
  test("holds a partial final line until an appended chunk completes it", async () => {
    const controller = new AbortController();
    const line = telemetry();
    const adapter = new ChunkFile(
      [line.slice(0, 30), `${line.slice(30)}\n`],
      controller,
    );

    const records = await collect(
      streamJsonlFile("agent.jsonl", {
        fileAdapter: adapter,
        follow: true,
        signal: controller.signal,
      }),
      1,
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "activity", id: "event-1" });
  });

  test("deduplicates event ids and diagnoses malformed and unknown records", async () => {
    const contents = [
      telemetry(),
      telemetry(),
      "not-json",
      telemetry({ event_id: "event-2", type: "future_type" }),
      telemetry({ event_id: "event-3", document_id: undefined }),
      "",
    ].join("\n");
    const records = await collect(
      streamJsonlFile("agent.jsonl", {
        fileAdapter: new ChunkFile([contents]),
      }),
    );

    expect(records.filter((record) => record.kind === "activity")).toHaveLength(
      1,
    );
    expect(
      records.filter((record) => record.kind === "diagnostic"),
    ).toHaveLength(3);
  });

  test("reads multiple per-agent files concurrently", async () => {
    const fileAdapter: JsonlFileAdapter = {
      async readFrom(path, offset) {
        const text = `${telemetry({ event_id: path, agent_id: path })}\n`;
        return offset === 0
          ? { text, nextOffset: text.length }
          : { text: "", nextOffset: offset };
      },
      async waitForChange() {},
    };
    const records = await collect(
      streamJsonlActivity(["b.jsonl", "a.jsonl"], { fileAdapter }),
    );

    expect(
      records.map((record) => record.kind === "activity" && record.id).sort(),
    ).toEqual(["a.jsonl", "b.jsonl"]);
  });
});

describe("streamMongoActivity", () => {
  test("opens live observation before snapshot and suppresses repeated resume tokens", async () => {
    const calls: string[] = [];
    const adapter: MongoActivityAdapter = {
      async snapshot() {
        calls.push("snapshot");
        return [{ _id: "existing", value: 1 }];
      },
      async *watch() {
        calls.push("watch");
        yield {
          token: "token-1",
          operation: "insert",
          collection: "notes",
          documentId: "new",
          document: { _id: "new" },
        };
        yield {
          token: "token-1",
          operation: "insert",
          collection: "notes",
          documentId: "new",
          document: { _id: "new" },
        };
      },
    };

    const records = await collect(
      streamMongoActivity(adapter, { collections: ["notes"] }),
    );

    expect(calls).toEqual(["watch", "snapshot"]);
    expect(records.filter((record) => record.kind === "activity")).toHaveLength(
      2,
    );
    expect(records[0]).toMatchObject({
      kind: "activity",
      operation: "snapshot",
    });
  });

  test("reconnects with the last token and stops on cancellation", async () => {
    const controller = new AbortController();
    const resumes: unknown[] = [];
    let attempts = 0;
    const adapter: MongoActivityAdapter = {
      async snapshot() {
        return [];
      },
      watch(_collections, options) {
        resumes.push(options.resumeAfter);
        attempts += 1;
        return (async function* (): AsyncGenerator<MongoChange> {
          if (attempts === 1) {
            yield { token: "one", operation: "insert", collection: "notes" };
            throw new Error("network reset");
          }
          controller.abort();
        })();
      },
    };

    const records = await collect(
      streamMongoActivity(adapter, {
        collections: ["notes"],
        reconnectDelayMs: 0,
        signal: controller.signal,
      }),
    );

    expect(resumes).toEqual([undefined, "one"]);
    expect(records.some((record) => record.kind === "diagnostic")).toBe(true);
  });
});

describe("activity correlation", () => {
  test("uses MongoDB content and JSONL attribution for a matching write", async () => {
    async function* records() {
      yield {
        kind: "activity" as const,
        id: "event-1",
        timestamp: "2026-08-13T20:00:00.000Z",
        provenance: "telemetry" as const,
        telemetryType: "db_write" as const,
        operation: "insert",
        collection: "notes",
        documentId: "doc-1",
        attribution: { agentId: "agent-1", condition: "shared" },
      };
      yield {
        kind: "activity" as const,
        id: "mongodb:token-1",
        timestamp: "2026-08-13T20:00:01.000Z",
        provenance: "mongodb" as const,
        operation: "insert",
        collection: "notes",
        documentId: "doc-1",
        document: { _id: "doc-1", body: "authoritative" },
      };
    }

    const [record] = await collect(correlateActivity(records()));

    expect(record).toMatchObject({
      kind: "activity",
      provenance: "correlated",
      id: "mongodb:token-1",
      document: { body: "authoritative" },
      attribution: { agentId: "agent-1", condition: "shared" },
    });
  });

  test("preserves unattributed MongoDB activity", async () => {
    const mongo: MongoActivityAdapter = {
      async snapshot() {
        return [];
      },
      async *watch() {
        yield {
          token: "one",
          operation: "delete",
          collection: "notes",
          documentId: "orphan",
        };
      },
    };

    const records = await collect(
      createActivityStream({
        mongo: { adapter: mongo, options: { collections: ["notes"] } },
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "activity",
      provenance: "mongodb",
    });
  });

  test("flushes an unmatched live event after the bounded correlation window", async () => {
    async function* records() {
      yield {
        kind: "activity" as const,
        id: "event-1",
        timestamp: "2026-08-13T20:00:00.000Z",
        provenance: "telemetry" as const,
        telemetryType: "db_write" as const,
        operation: "insert",
        collection: "notes",
        documentId: "doc-1",
      };
      await new Promise(() => {});
    }

    const [record] = await collect(correlateActivity(records(), 1), 1);

    expect(record).toMatchObject({ kind: "activity", id: "event-1" });
  });
});
