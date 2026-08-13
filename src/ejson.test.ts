import { describe, expect, test } from "bun:test";

import { parseEjson, stringifyEjson } from "./ejson.ts";
import type { CliError } from "./errors.ts";

describe("parseEjson", () => {
  test("preserves explicit Extended JSON type wrappers", () => {
    const input =
      '{"id":{"$oid":"64b7f0000000000000000001"},"n":{"$numberLong":"42"}}';

    expect(stringifyEjson(parseEjson(input))).toBe(input);
  });

  test("round-trips its own output", () => {
    const once = stringifyEjson(parseEjson('{"n":{"$numberDecimal":"1.5"}}'));

    expect(stringifyEjson(parseEjson(once))).toBe(once);
  });

  test("reports invalid input as a usage error", () => {
    try {
      parseEjson("{bad", "filter");
      throw new Error("expected parseEjson to throw");
    } catch (error) {
      const cliError = error as CliError;
      expect(cliError.code).toBe("INVALID_EJSON");
      expect(cliError.exitCode).toBe(2);
      expect(cliError.message).toBe("Invalid Extended JSON for filter");
    }
  });
});
