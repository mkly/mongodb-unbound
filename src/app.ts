import { parseArguments } from "./args.ts";
import { createCommandRegistry, type CommandHandler } from "./command.ts";
import { resolveConnectionConfig } from "./config.ts";
import { CliError, toCliError } from "./errors.ts";
import { withMongoConnection } from "./mongo.ts";
import { type OutputWriter, writeError, writeResult } from "./output.ts";

export interface CliRuntime {
  env: Record<string, string | undefined>;
  stderr: OutputWriter;
  stdout: OutputWriter;
}

function helpText(handlers: readonly CommandHandler[]): string {
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

export async function runCli(
  argv: readonly string[],
  handlers: readonly CommandHandler[],
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
    const data = await withMongoConnection(config, ({ client, db }) =>
      handler.run(
        {
          client,
          config,
          db,
          stderr: runtime.stderr,
          stdout: runtime.stdout,
        },
        args.commandArgs,
      ),
    );
    writeResult(runtime.stdout, data);
    return 0;
  } catch (error) {
    const cliError = toCliError(error);
    writeError(runtime.stderr, cliError);
    return cliError.exitCode;
  }
}
