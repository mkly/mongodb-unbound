import { describe, expect, test } from "bun:test";

import { ObjectId } from "mongodb";

import { parseEjson, parseId, stringifyEjson } from "./ejson.ts";
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

describe("parseId", () => {
  test("accepts the bare hex id that insert prints", () => {
    const hex = "64b7f0000000000000000001";

    expect(parseId(hex)).toEqual(new ObjectId(hex));
    expect(parseId(hex.toUpperCase())).toEqual(new ObjectId(hex));
  });

  test("still accepts Extended JSON, for ids that are not ObjectIds", () => {
    expect(parseId('{"$oid":"64b7f0000000000000000001"}')).toEqual(
      new ObjectId("64b7f0000000000000000001"),
    );
    expect(parseId('{"$numberLong":"42"}')).toEqual(
      parseEjson('{"$numberLong":"42"}'),
    );
  });

  test("treats an unparseable argument as the string _id it is", () => {
    // String _ids are legal in MongoDB, so a bare word is a lookup, not an
    // error. Twenty-four non-hex characters must not be mistaken for an ObjectId.
    expect(parseId("task-notes")).toBe("task-notes");
    expect(parseId("zzzzzzzzzzzzzzzzzzzzzzzz")).toBe(
      "zzzzzzzzzzzzzzzzzzzzzzzz",
    );
  });
});
