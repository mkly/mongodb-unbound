import { CliError } from "./errors.ts";

export interface ParsedArguments {
  command?: string;
  commandArgs: string[];
  db?: string;
  help: boolean;
  uri?: string;
  version: boolean;
}

const GLOBAL_VALUE_FLAGS = new Map([
  ["--uri", "uri"],
  ["--db", "db"],
] as const);

export function parseArguments(args: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    commandArgs: [],
    help: false,
    version: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--version" || argument === "-v") {
      parsed.version = true;
      continue;
    }

    const equalsAt = argument.indexOf("=");
    const flag = equalsAt === -1 ? argument : argument.slice(0, equalsAt);
    const key = GLOBAL_VALUE_FLAGS.get(flag as "--uri" | "--db");
    if (key !== undefined) {
      let value: string | undefined;
      if (equalsAt === -1) {
        index += 1;
        value = args[index];
      } else {
        value = argument.slice(equalsAt + 1);
      }
      if (value === undefined || value.length === 0) {
        throw new CliError(`${flag} requires a value`, {
          code: "INVALID_ARGUMENTS",
          exitCode: 2,
        });
      }
      if (parsed[key] !== undefined) {
        throw new CliError(`${flag} may only be specified once`, {
          code: "INVALID_ARGUMENTS",
          exitCode: 2,
        });
      }
      parsed[key] = value;
      continue;
    }

    if (parsed.command === undefined) {
      if (argument.startsWith("-")) {
        throw new CliError(`Unknown global option: ${argument}`, {
          code: "INVALID_ARGUMENTS",
          exitCode: 2,
        });
      }
      parsed.command = argument;
      continue;
    }

    parsed.commandArgs.push(argument);
  }

  return parsed;
}
