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

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

// `_id` is the one argument users type by hand, usually by copying an id straight
// out of our own output, so it accepts more than strict Extended JSON:
//
//   6a7e41f0a7ffaf01913589f5      bare hex -> ObjectId
//   {"$oid":"6a7e41f0..."}        Extended JSON, any BSON type
//   my-custom-key                 unparseable -> string _id, as stored
//
// Requiring `{"$oid":...}` here made `get`/`update`/`delete` fail with
// INVALID_EJSON on the exact string `insert` had just printed.
export function parseId(input: string): unknown {
  if (OBJECT_ID_PATTERN.test(input)) {
    return new BSON.ObjectId(input);
  }
  try {
    return BSON.EJSON.parse(input, { relaxed: false });
  } catch {
    // Not valid Extended JSON. A bare word is a string _id, which is legal in
    // MongoDB -- reporting a parse error would be wrong and unhelpful.
    return input;
  }
}

export function stringifyEjson(value: unknown): string {
  return BSON.EJSON.stringify(value, { relaxed: false });
}
