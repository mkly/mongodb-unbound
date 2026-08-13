import { describe, expect, test } from "bun:test";
import { Binary, Decimal128, Long, ObjectId } from "mongodb";

import { fingerprintDocument, hashFingerprint } from "./schema-fingerprint.ts";

describe("fingerprintDocument", () => {
  test("canonicalizes nested objects independently of field order and values", () => {
    const left = fingerprintDocument({
      profile: { name: "Ada", stats: { active: true, score: 1 } },
      missingElsewhere: null,
    });
    const right = fingerprintDocument({
      missingElsewhere: null,
      profile: { stats: { score: 99, active: false }, name: "Grace" },
    });

    expect(left).toEqual(right);
    expect(left.fields).toEqual({
      missingElsewhere: "null",
      profile: "object",
      "profile.name": "string",
      "profile.stats": "object",
      "profile.stats.active": "boolean",
      "profile.stats.score": "number",
    });
  });

  test("distinguishes empty, homogeneous, heterogeneous, and object arrays", () => {
    const fields = fingerprintDocument({
      empty: [],
      homogeneous: [1, 2],
      heterogeneous: ["two", 1, null],
      nested: [
        { z: 1, a: "one" },
        { a: "two", z: 2 },
      ],
    }).fields;

    expect(fields).toEqual({
      empty: "array<empty>",
      heterogeneous: "array<union<null|number|string>>",
      "heterogeneous[]": "union<null|number|string>",
      homogeneous: "array<number>",
      "homogeneous[]": "number",
      nested: 'array<object{"a":string,"z":number}>',
      "nested[]": "object",
      "nested[].a": "string",
      "nested[].z": "number",
    });
  });

  test("retains BSON scalar types in fields and arrays", () => {
    const fields = fingerprintDocument({
      id: new ObjectId("64b7f0000000000000000001"),
      count: Long.fromInt(2),
      amount: Decimal128.fromString("2.00"),
      values: [Long.fromInt(1), new Binary(new Uint8Array([1]))],
    }).fields;

    expect(fields).toEqual({
      amount: "decimal128",
      count: "long",
      id: "objectid",
      values: "array<union<binary|long>>",
      "values[]": "union<binary|long>",
    });
  });

  test("only excludes an _id explicitly identified as generated", () => {
    const id = new ObjectId("64b7f0000000000000000001");
    const document = { _id: id, name: "caller-visible" };

    expect(fingerprintDocument(document).fields).toHaveProperty(
      "_id",
      "objectid",
    );
    expect(
      fingerprintDocument(document, {
        generatedId: new ObjectId(id.toHexString()),
      }).fields,
    ).toEqual({ name: "string" });
    expect(
      fingerprintDocument(document, { generatedId: new ObjectId() }).fields,
    ).toHaveProperty("_id", "objectid");
  });

  test("represents missing fields through distinct stable fingerprints", () => {
    const withOptional = fingerprintDocument({ required: 1, optional: true });
    const withoutOptional = fingerprintDocument({ required: 2 });

    expect(withOptional.fingerprint).not.toBe(withoutOptional.fingerprint);
    expect(fingerprintDocument({ required: 999 })).toEqual(withoutOptional);
  });

  test("keeps dotted field names distinct from nested paths", () => {
    expect(fingerprintDocument({ "profile.name": "Ada" }).fingerprint).not.toBe(
      fingerprintDocument({ profile: { name: "Ada" } }).fingerprint,
    );
  });
});

describe("hashFingerprint", () => {
  test("is the fixed-length key the telemetry stream logs in place of the shape", () => {
    const { fingerprint, hash } = fingerprintDocument({
      note: "long enough to matter",
      tags: ["a", "b"],
    });

    expect(hash).toBe(hashFingerprint(fingerprint));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("agrees exactly with itself across documents of the same shape", () => {
    // The whole convergence measurement is a join on this value between the
    // pilot's JSONL and a later pass over MongoDB, so same shape must mean
    // same hash and different shape must mean different hash.
    expect(fingerprintDocument({ a: 1, b: "x" }).hash).toBe(
      fingerprintDocument({ b: "y", a: 2 }).hash,
    );
    expect(fingerprintDocument({ a: 1 }).hash).not.toBe(
      fingerprintDocument({ a: "1" }).hash,
    );
  });
});
