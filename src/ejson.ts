import { BSON } from "mongodb";

import { CliError } from "./errors.ts";

export function parseEjson<T = unknown>(input: string, label = "value"): T {
  try {
    return BSON.EJSON.parse(input) as T;
  } catch (error) {
    throw new CliError(`Invalid Extended JSON for ${label}`, {
      code: "INVALID_EJSON",
      exitCode: 2,
      details: {
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export function stringifyEjson(value: unknown): string {
  return BSON.EJSON.stringify(value, { relaxed: false });
}
