import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./app.ts";
import {
  createServeCommand,
  handleServeRequest,
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
    expect(parseServeOptions([])).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(parseServeOptions(["--host=::1", "--port", "8080"])).toEqual({
      host: "::1",
      port: 8080,
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
    expect(await page.text()).toContain("Unbounded Schema Observatory");

    const write = handleServeRequest(
      new Request("http://localhost/", { method: "POST" }),
    );
    expect(write.status).toBe(405);
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
          return await callback({} as Parameters<typeof callback>[0]);
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
      data: { status: "listening", url: "http://127.0.0.1:4100" },
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
        callback({} as Parameters<typeof callback>[0]),
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
