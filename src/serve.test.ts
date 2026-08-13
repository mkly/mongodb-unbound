import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./app.ts";
import {
  createServeCommand,
  createServeRequestHandler,
  handleServeRequest,
  ObservatoryModel,
  parseServeOptions,
} from "./serve.ts";

function memoryWriter() {
  let output = "";
  return {
    read: () => output,
    write: (value: string) => {
      output += value;
    },
  };
}

describe("serve options", () => {
  test("uses loopback defaults and accepts explicit host and port", () => {
    expect(parseServeOptions([])).toEqual({
      host: "127.0.0.1",
      port: 3000,
      telemetryPaths: [],
    });
    expect(
      parseServeOptions([
        "--host=::1",
        "--port",
        "8080",
        "--telemetry",
        "one.jsonl",
        "--telemetry=two.jsonl",
      ]),
    ).toEqual({
      host: "::1",
      port: 8080,
      telemetryPaths: ["one.jsonl", "two.jsonl"],
    });
  });

  test.each([
    [["--port", "0"]],
    [["--port=65536"]],
    [["--port", "3.5"]],
    [["--host", "http://localhost"]],
    [["--host", "[::1]"]],
    [["--host", ""]],
    [["--port", "3000", "extra"]],
  ])("rejects invalid arguments: %p", (args) => {
    expect(() => parseServeOptions(args)).toThrow();
  });
});

describe("serve HTTP surface", () => {
  test("serves health and the embedded placeholder read-only", async () => {
    const health = handleServeRequest(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const page = handleServeRequest(new Request("http://localhost/"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Schema Observatory");

    const write = handleServeRequest(
      new Request("http://localhost/", { method: "POST" }),
    );
    expect(write.status).toBe(405);
  });

  test("publishes versioned snapshots with canonical schema and explicit unknown attribution", async () => {
    const model = new ObservatoryModel();
    model.ingest({
      kind: "activity",
      id: "mongo-1",
      timestamp: "2026-08-13T20:00:00.000Z",
      provenance: "mongodb",
      operation: "insert",
      collection: "records",
      document: { name: "Ada", score: 42 },
    });
    const handler = createServeRequestHandler(model);
    const response = handler(new Request("http://localhost/v1/snapshot"));
    const snapshot = await response.json();

    expect(snapshot.api_version).toBe("v1");
    expect(snapshot.observatory.activity[0]).toMatchObject({
      agents: [],
      collection: "records",
      condition: "",
      run_id: "",
      task_id: "",
    });
    expect(snapshot.observatory.fingerprints[0]).toMatchObject({
      count: 1,
      fields: ["name:string", "score:number"],
      fingerprint: 'document{"name":string,"score":number}',
    });
  });
});

describe("long-running command lifecycle", () => {
  test("reports the URL, waits for shutdown, then stops HTTP before Mongo closes", async () => {
    const events: string[] = [];
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const serve = createServeCommand((options) => {
      expect(options.host).toBe("127.0.0.1");
      expect(options.port).toBe(4100);
      return {
        hostname: options.host,
        port: options.port,
        stop: async (force) => {
          expect(force).toBe(true);
          events.push("http stopped");
        },
      };
    });

    const exitCode = await runCli(["serve", "--port", "4100"], [serve], {
      connect: async (_config, callback) => {
        events.push("mongo opened");
        try {
          return await callback({
            db: {
              listCollections: () => ({ toArray: async () => [] }),
              watch: () => ({
                async close() {},
                async next() {
                  return { done: true as const, value: undefined };
                },
                [Symbol.asyncIterator]() {
                  return this;
                },
              }),
            },
          } as unknown as Parameters<typeof callback>[0]);
        } finally {
          events.push("mongo closed");
        }
      },
      env: { UNBOUNDED_DB: "demo", UNBOUNDED_MONGO_URI: "mongodb://unused" },
      stderr,
      stdout,
      waitForShutdown: async () => {
        events.push("SIGTERM");
        return "SIGTERM";
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    expect(JSON.parse(stdout.read())).toEqual({
      data: {
        collections: [],
        status: "listening",
        telemetry: [],
        url: "http://127.0.0.1:4100",
      },
      ok: true,
    });
    expect(events).toEqual([
      "mongo opened",
      "SIGTERM",
      "http stopped",
      "mongo closed",
    ]);
  });

  test("turns bind failures into a useful nonzero diagnostic", async () => {
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const serve = createServeCommand(() => {
      throw new Error("address already in use");
    });

    const code = await runCli(["serve"], [serve], {
      connect: async (_config, callback) =>
        callback({
          db: {
            listCollections: () => ({ toArray: async () => [] }),
            watch: () => ({
              async close() {},
              async next() {
                return { done: true as const, value: undefined };
              },
              [Symbol.asyncIterator]() {
                return this;
              },
            }),
          },
        } as unknown as Parameters<typeof callback>[0]),
      env: { UNBOUNDED_DB: "demo", UNBOUNDED_MONGO_URI: "mongodb://unused" },
      stderr,
      stdout,
    });

    expect(code).toBe(1);
    expect(stdout.read()).toBe("");
    expect(JSON.parse(stderr.read())).toEqual({
      error: {
        code: "SERVER_START_FAILED",
        details: { host: "127.0.0.1", port: { $numberInt: "3000" } },
        message:
          "Unable to start server on 127.0.0.1:3000: address already in use",
      },
      ok: false,
    });
  });
});

describe("compiled serve command", () => {
  test("is embedded in the standalone executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unbounded-serve-smoke-"));
    const binary = join(directory, "unbounded");

    try {
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "./src/cli.ts",
          "--compile",
          "--target=bun-linux-x64",
          `--outfile=${binary}`,
        ],
        { cwd: join(import.meta.dir, ".."), stderr: "pipe", stdout: "pipe" },
      );
      const buildStderr = new Response(build.stderr).text();
      expect(await build.exited, await buildStderr).toBe(0);

      const smoke = Bun.spawn([binary, "--help"], {
        env: { PATH: "/usr/bin:/bin" },
        stderr: "pipe",
        stdout: "pipe",
      });
      const stdout = new Response(smoke.stdout).text();
      const stderr = new Response(smoke.stderr).text();
      expect(await smoke.exited, await stderr).toBe(0);
      expect(await stdout).toContain(
        "serve                Serve the read-only Schema Observatory",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});
