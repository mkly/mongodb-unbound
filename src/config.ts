import type { ParsedArguments } from "./args.ts";
import { CliError } from "./errors.ts";

export interface ConnectionConfig {
  db: string;
  uri: string;
}

export function resolveConnectionConfig(
  args: Pick<ParsedArguments, "db" | "uri">,
  env: Record<string, string | undefined>,
): ConnectionConfig {
  const uri = args.uri ?? env.UNBOUNDED_MONGO_URI;
  const db = args.db ?? env.UNBOUNDED_DB;
  const missing = [
    ...(uri ? [] : ["MongoDB URI (--uri or UNBOUNDED_MONGO_URI)"]),
    ...(db ? [] : ["database (--db or UNBOUNDED_DB)"]),
  ];

  if (missing.length > 0) {
    throw new CliError(`Missing ${missing.join(" and ")}`, {
      code: "MISSING_CONFIGURATION",
      exitCode: 2,
    });
  }

  return { db: db as string, uri: uri as string };
}
