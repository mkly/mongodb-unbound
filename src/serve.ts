import type { Document } from "mongodb";

import {
  type ActivityDiagnostic,
  type ActivityEvent,
  type ActivityRecord,
  createActivityStream,
  MongoDbActivityAdapter,
} from "./activity.ts";
import type { LongRunningCommandHandler } from "./command.ts";
import { CliError } from "./errors.ts";
import {
  type ObservatoryFixture,
  renderSchemaObservatory,
} from "./observatory.ts";
import { writeResult } from "./output.ts";
import {
  analyzeSchemaObservations,
  type SchemaObservation,
} from "./schema-analysis.ts";
import { fingerprintDocument } from "./schema-fingerprint.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_WINDOW_MS = 60_000;
const MAX_ACTIVITY = 5_000;
const MAX_DIAGNOSTICS = 200;

export interface ServeOptions {
  host: string;
  port: number;
  telemetryPaths: string[];
}

interface StartedServer {
  hostname: string;
  port: number;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}

interface ServerOptions extends Pick<ServeOptions, "host" | "port"> {
  fetch(request: Request): Response | Promise<Response>;
}

export type StartServer = (options: ServerOptions) => StartedServer;

export interface ObservatorySnapshot {
  api_version: "v1";
  diagnostics: ActivityDiagnostic[];
  observatory: ObservatoryFixture;
}

function invalidArguments(message: string): never {
  throw new CliError(message, {
    code: "INVALID_ARGUMENTS",
    exitCode: 2,
  });
}

function takeFlagValue(
  args: readonly string[],
  index: number,
  flag: string,
): { index: number; value: string } {
  const argument = args[index];
  const equalsAt = argument.indexOf("=");
  const value =
    equalsAt === -1 ? args[index + 1] : argument.slice(equalsAt + 1);
  if (value === undefined || value.length === 0)
    invalidArguments(`${flag} requires a value`);
  return { index: equalsAt === -1 ? index + 1 : index, value };
}

export function parseServeOptions(args: readonly string[]): ServeOptions {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  const telemetryPaths: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const flag = argument.split("=", 1)[0];
    if (!["--host", "--port", "--telemetry"].includes(flag)) {
      invalidArguments(`Unknown serve option: ${argument}`);
    }
    if (flag !== "--telemetry" && seen.has(flag)) {
      invalidArguments(`${flag} may only be specified once`);
    }
    seen.add(flag);

    const parsed = takeFlagValue(args, index, flag);
    index = parsed.index;
    if (flag === "--telemetry") {
      telemetryPaths.push(parsed.value);
      continue;
    }
    if (flag === "--host") {
      if (
        parsed.value.trim() !== parsed.value ||
        parsed.value.length === 0 ||
        /[\s/=?#@]/u.test(parsed.value) ||
        parsed.value.includes("[") ||
        parsed.value.includes("]")
      ) {
        invalidArguments("--host must be a hostname or IP address");
      }
      host = parsed.value;
      continue;
    }

    if (!/^\d+$/u.test(parsed.value)) {
      invalidArguments("--port must be an integer between 1 and 65535");
    }
    const parsedPort = Number(parsed.value);
    if (parsedPort < 1 || parsedPort > 65_535) {
      invalidArguments("--port must be an integer between 1 and 65535");
    }
    port = parsedPort;
  }

  return { host, port, telemetryPaths: [...new Set(telemetryPaths)] };
}

function attribution(
  event: ActivityEvent,
  field: "agentId" | "condition" | "runId" | "taskId",
): string {
  return event.attribution?.[field] ?? "";
}

function structuralEvent(event: ActivityEvent): {
  fingerprint: string;
  fields: string[];
} {
  if (event.document) {
    const result = fingerprintDocument(event.document);
    return {
      fingerprint: result.fingerprint,
      fields: Object.entries(result.fields).map(
        ([path, type]) => `${path}:${type}`,
      ),
    };
  }
  return { fingerprint: event.fingerprint ?? "unknown", fields: [] };
}

export class ObservatoryModel {
  private readonly events: ActivityEvent[] = [];
  private readonly diagnostics: ActivityDiagnostic[] = [];
  private readonly listeners = new Set<
    (snapshot: ObservatorySnapshot) => void
  >();

  ingest(record: ActivityRecord): void {
    if (record.kind === "diagnostic") {
      this.diagnostics.push(record);
      if (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.shift();
    } else {
      this.events.push(record);
      if (this.events.length > MAX_ACTIVITY) this.events.shift();
    }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  subscribe(listener: (snapshot: ObservatorySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ObservatorySnapshot {
    const observed = this.events.map((event) => ({
      event,
      ...structuralEvent(event),
    }));
    const schemaObservations: SchemaObservation[] = observed
      .filter(({ fingerprint }) => fingerprint !== "unknown")
      .map(({ event, fingerprint, fields }) => ({
        agent_id: event.attribution?.agentId ?? null,
        collection: event.collection ?? "unknown",
        condition: event.attribution?.condition ?? "unknown",
        field_paths: fields,
        fingerprint,
        run_id: event.attribution?.runId ?? null,
        task_id: event.attribution?.taskId ?? null,
        timestamp: event.timestamp,
      }));
    const analysis = analyzeSchemaObservations(schemaObservations, {
      group_by: ["collection", "run_id", "task_id", "condition"],
      window_ms: DEFAULT_WINDOW_MS,
    });

    const fingerprints = new Map<
      string,
      ObservatoryFixture["fingerprints"][number]
    >();
    const activity: ObservatoryFixture["activity"] = [];
    for (const { event, fingerprint, fields } of observed) {
      const collection = event.collection ?? "unknown";
      const run_id = attribution(event, "runId");
      const task_id = attribution(event, "taskId");
      const agent = attribution(event, "agentId");
      const condition = attribution(event, "condition");
      const agents = agent ? [agent] : [];
      if (["insert", "update", "replace", "delete"].includes(event.operation)) {
        activity.push({
          action: event.operation as "insert" | "update" | "replace" | "delete",
          agents,
          collection,
          condition,
          fingerprint,
          run_id,
          task_id,
          timestamp: event.timestamp,
        });
      }
      if (fingerprint === "unknown") continue;
      const key = JSON.stringify([
        collection,
        run_id,
        task_id,
        condition,
        fingerprint,
      ]);
      const current = fingerprints.get(key);
      if (current) {
        current.count += 1;
        current.agents = [...new Set([...current.agents, ...agents])].sort();
        current.fields = [...new Set([...current.fields, ...fields])].sort();
      } else {
        fingerprints.set(key, {
          agents,
          collection,
          condition,
          count: 1,
          fields,
          fingerprint,
          run_id,
          task_id,
        });
      }
    }

    const adoption: ObservatoryFixture["adoption"] = [];
    const field_agent: ObservatoryFixture["field_agent"] = [];
    const trends: ObservatoryFixture["trends"] = [];
    for (const group of analysis.groups) {
      const collection = group.key.collection ?? "unknown";
      const run_id = group.key.run_id ?? "";
      const task_id = group.key.task_id ?? "";
      const condition = group.key.condition;
      for (const row of group.attribution.fingerprint_adoption) {
        adoption.push({
          agent: row.first_seen_agent_id,
          collection,
          condition,
          fingerprint: row.fingerprint,
          first_seen: row.first_seen,
          run_id,
          task_id,
        });
        for (const subsequent of row.subsequent_agents) {
          adoption.push({
            agent: subsequent.agent_id,
            collection,
            condition,
            fingerprint: row.fingerprint,
            first_seen: subsequent.first_seen,
            run_id,
            task_id,
          });
        }
      }
      for (const row of group.attribution.field_by_agent) {
        field_agent.push({
          agent: row.agent_id,
          collection,
          condition,
          field: row.field_path,
          frequency: row.frequency,
          run_id,
          task_id,
        });
      }
      for (const window of group.windows) {
        trends.push({
          collection,
          condition,
          effective_schemas: window.effective_schema_count,
          inter_agent_divergence:
            group.attribution.average_pairwise_js_divergence,
          run_id,
          task_id,
          temporal_stability:
            window.temporal_js_divergence === null
              ? null
              : 1 - window.temporal_js_divergence,
          timestamp: window.end_time,
        });
      }
    }

    return {
      api_version: "v1",
      diagnostics: [...this.diagnostics],
      observatory: {
        activity,
        adoption,
        field_agent,
        fingerprints: [...fingerprints.values()],
        generated_at: new Date().toISOString(),
        trends,
      },
    };
  }
}

function json(value: unknown, method: string): Response {
  return new Response(method === "HEAD" ? null : `${JSON.stringify(value)}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function createServeRequestHandler(
  model = new ObservatoryModel(),
): (request: Request) => Response {
  return (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed\n", {
        headers: { allow: "GET, HEAD" },
        status: 405,
      });
    }
    if (url.pathname === "/health") return json({ ok: true }, request.method);
    if (url.pathname === "/v1/snapshot")
      return json(model.snapshot(), request.method);
    if (url.pathname === "/v1/events") {
      if (request.method === "HEAD") {
        return new Response(null, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      const encoder = new TextEncoder();
      let unsubscribe = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (snapshot: ObservatorySnapshot) => {
            controller.enqueue(
              encoder.encode(
                `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
              ),
            );
          };
          send(model.snapshot());
          unsubscribe = model.subscribe(send);
        },
        cancel() {
          unsubscribe();
        },
      });
      return new Response(stream, {
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream",
          "x-accel-buffering": "no",
        },
      });
    }
    if (url.pathname === "/") {
      return new Response(
        request.method === "HEAD"
          ? null
          : renderSchemaObservatory(model.snapshot().observatory),
        {
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }
    return new Response(request.method === "HEAD" ? null : "Not Found\n", {
      status: 404,
    });
  };
}

export function handleServeRequest(request: Request): Response {
  return createServeRequestHandler()(request);
}

function listeningUrl(server: StartedServer): string {
  const host = server.hostname.includes(":")
    ? `[${server.hostname}]`
    : server.hostname;
  return `http://${host}:${server.port}`;
}

const startBunServer: StartServer = (options) => {
  const server = Bun.serve({
    fetch: options.fetch,
    hostname: options.host,
    port: options.port,
  });
  return {
    hostname: server.hostname ?? options.host,
    port: server.port ?? options.port,
    stop: (closeActiveConnections) => server.stop(closeActiveConnections),
  };
};

async function userCollections(db: {
  listCollections(
    filter: Document,
    options: Document,
  ): { toArray(): Promise<Array<{ name: string }>> };
}): Promise<string[]> {
  const collections = await db
    .listCollections({}, { nameOnly: true })
    .toArray();
  return collections
    .map(({ name }) => name)
    .filter((name) => !name.startsWith("system."))
    .sort();
}

export function createServeCommand(
  startServer: StartServer = startBunServer,
): LongRunningCommandHandler {
  return {
    mode: "long-running",
    name: "serve",
    summary: "Serve the read-only Schema Observatory",
    usage: "serve [--host HOST] [--port PORT] [--telemetry PATH]...",
    async run(context, args, waitForShutdown) {
      const options = parseServeOptions(args);
      const abort = new AbortController();
      const model = new ObservatoryModel();
      const collections = await userCollections(context.db);
      const records = createActivityStream({
        mongo: {
          adapter: new MongoDbActivityAdapter(context.db),
          options: { collections, signal: abort.signal },
        },
        ...(options.telemetryPaths.length > 0
          ? {
              telemetry: {
                paths: options.telemetryPaths,
                options: { follow: true, signal: abort.signal },
              },
            }
          : {}),
      });
      const reader = (async () => {
        try {
          for await (const record of records) model.ingest(record);
        } catch (error) {
          if (!abort.signal.aborted) {
            model.ingest({
              kind: "diagnostic",
              source: "mongodb",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })();

      let server: StartedServer;
      try {
        server = startServer({
          ...options,
          fetch: createServeRequestHandler(model),
        });
      } catch (error) {
        abort.abort();
        await reader;
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError(
          `Unable to start server on ${options.host}:${options.port}: ${message}`,
          {
            code: "SERVER_START_FAILED",
            details: { host: options.host, port: options.port },
          },
        );
      }

      writeResult(context.stdout, {
        collections,
        status: "listening",
        telemetry: options.telemetryPaths,
        url: listeningUrl(server),
      });

      try {
        await waitForShutdown();
      } finally {
        abort.abort();
        await server.stop(true);
        await reader;
      }
    },
  };
}

export const serveCommand = createServeCommand();
