import type { LongRunningCommandHandler } from "./command.ts";
import { CliError } from "./errors.ts";
import { writeResult } from "./output.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Unbounded Schema Observatory</title>
  </head>
  <body>
    <main>
      <h1>Unbounded Schema Observatory</h1>
      <p>The observatory interface is ready for schema activity.</p>
    </main>
  </body>
</html>
`;

export interface ServeOptions {
  host: string;
  port: number;
}

interface StartedServer {
  hostname: string;
  port: number;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}

interface ServerOptions extends ServeOptions {
  fetch(request: Request): Response;
}

export type StartServer = (options: ServerOptions) => StartedServer;

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
  if (value === undefined || value.length === 0) {
    invalidArguments(`${flag} requires a value`);
  }
  return { index: equalsAt === -1 ? index + 1 : index, value };
}

export function parseServeOptions(args: readonly string[]): ServeOptions {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const flag = argument.split("=", 1)[0];
    if (flag !== "--host" && flag !== "--port") {
      invalidArguments(`Unknown serve option: ${argument}`);
    }
    if (seen.has(flag)) {
      invalidArguments(`${flag} may only be specified once`);
    }
    seen.add(flag);

    const parsed = takeFlagValue(args, index, flag);
    index = parsed.index;
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

  return { host, port };
}

export function handleServeRequest(request: Request): Response {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed\n", {
      headers: { allow: "GET, HEAD" },
      status: 405,
    });
  }

  if (url.pathname === "/health") {
    return new Response(request.method === "HEAD" ? null : '{"ok":true}\n', {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (url.pathname === "/") {
    return new Response(request.method === "HEAD" ? null : PLACEHOLDER_PAGE, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response(request.method === "HEAD" ? null : "Not Found\n", {
    status: 404,
  });
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

export function createServeCommand(
  startServer: StartServer = startBunServer,
): LongRunningCommandHandler {
  return {
    mode: "long-running",
    name: "serve",
    summary: "Serve the read-only Schema Observatory",
    usage: "serve [--host HOST] [--port PORT]",
    async run(context, args, waitForShutdown) {
      const options = parseServeOptions(args);
      let server: StartedServer;
      try {
        server = startServer({ ...options, fetch: handleServeRequest });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError(
          `Unable to start server on ${options.host}:${options.port}: ${message}`,
          {
            code: "SERVER_START_FAILED",
            details: options,
          },
        );
      }

      writeResult(context.stdout, {
        status: "listening",
        url: listeningUrl(server),
      });

      try {
        await waitForShutdown();
      } finally {
        await server.stop(true);
      }
    },
  };
}

export const serveCommand = createServeCommand();
