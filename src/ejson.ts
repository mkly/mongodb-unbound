import { BSON } from "mongodb";

import { CliError } from "./errors.ts";

// Parse canonically so explicit type wrappers survive: relaxed parsing collapses
// $numberLong/$numberDecimal into JS numbers, which changes the BSON type that
// reaches the server and breaks find -> insert round-trips of our own output.
export function parseEjson<T = unknown>(input: string, label = "value"): T {
  try {
    return BSON.EJSON.parse(input, { relaxed: false }) as T;
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
