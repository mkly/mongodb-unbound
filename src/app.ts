import { parseArguments } from "./args.ts";
import {
  createCommandRegistry,
  type RegisteredCommandHandler,
  type ShutdownSignal,
} from "./command.ts";
import { resolveConnectionConfig } from "./config.ts";
import { CliError, toCliError } from "./errors.ts";
import { type ConnectionRunner, withMongoConnection } from "./mongo.ts";
import { type OutputWriter, writeError, writeResult } from "./output.ts";

export interface CliRuntime {
  connect?: ConnectionRunner;
  env: Record<string, string | undefined>;
  stderr: OutputWriter;
  stdout: OutputWriter;
  waitForShutdown?: () => Promise<ShutdownSignal>;
}

function helpText(handlers: readonly RegisteredCommandHandler[]): string {
  const commands = handlers
    .map((handler) => `  ${handler.name.padEnd(20)} ${handler.summary}`)
    .join("\n");

  return [
    "Usage: unbounded [--uri URI] [--db DATABASE] <command> [arguments]",
    "",
    "Connection options:",
    "  --uri URI            MongoDB URI (or UNBOUNDED_MONGO_URI)",
    "  --db DATABASE        Database name (or UNBOUNDED_DB)",
    ...(commands.length > 0 ? ["", "Commands:", commands] : []),
    "",
  ].join("\n");
}

export function waitForProcessShutdown(): Promise<ShutdownSignal> {
  return new Promise((resolve) => {
    const onInterrupt = () => finish("SIGINT");
    const onTerminate = () => finish("SIGTERM");
    const finish = (signal: ShutdownSignal) => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      resolve(signal);
    };

    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
}

export async function runCli(
  argv: readonly string[],
  handlers: readonly RegisteredCommandHandler[],
  runtime: CliRuntime,
): Promise<number> {
  try {
    const args = parseArguments(argv);
    const registry = createCommandRegistry(handlers);

    if (args.version) {
      runtime.stdout.write("unbounded 0.1.0\n");
      return 0;
    }
    if (args.help || args.command === undefined) {
      runtime.stdout.write(helpText(handlers));
      return args.help ? 0 : 2;
    }

    const handler = registry.get(args.command);
    if (handler === undefined) {
      throw new CliError(`Unknown command: ${args.command}`, {
        code: "UNKNOWN_COMMAND",
        exitCode: 2,
      });
    }

    const config = resolveConnectionConfig(args, runtime.env);
    const connect = runtime.connect ?? withMongoConnection;
    const data = await connect(config, async ({ client, db }) => {
      const context = {
        client,
        config,
        db,
        stderr: runtime.stderr,
        stdout: runtime.stdout,
      };

      if (handler.mode === "long-running") {
        await handler.run(
          context,
          args.commandArgs,
          runtime.waitForShutdown ?? waitForProcessShutdown,
        );
        return undefined;
      }

      return handler.run(context, args.commandArgs);
    });
    if (handler.mode !== "long-running") {
      writeResult(runtime.stdout, data);
    }
    return 0;
  } catch (error) {
    const cliError = toCliError(error);
    writeError(runtime.stderr, cliError);
    return cliError.exitCode;
  }
}
