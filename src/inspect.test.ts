import { describe, expect, test } from "bun:test";
import { Long, ObjectId } from "mongodb";

import type { CommandContext } from "./command.ts";
import { describeDocuments, inspectCommand, sampleCommand } from "./inspect.ts";

describe("describeDocuments", () => {
  test("reports nested field frequencies, BSON types, and common shapes", () => {
    const description = describeDocuments([
      {
        _id: new ObjectId("64b7f0000000000000000001"),
        value: Long.fromInt(1),
        profile: { enabled: true },
      },
      {
        _id: new ObjectId("64b7f0000000000000000002"),
        value: Long.fromInt(2),
        profile: { enabled: false },
      },
      { _id: new ObjectId("64b7f0000000000000000003"), value: "one" },
      { _id: new ObjectId("64b7f0000000000000000004"), tags: ["a"] },
    ]);

    expect(description.sampled_documents).toBe(4);
    expect(description.common_fields._id).toEqual({
      frequency: 1,
      types: { objectid: 4 },
    });
    expect(description.common_fields.value).toEqual({
      frequency: 0.75,
      types: { long: 2, string: 1 },
    });
    expect(description.common_fields["profile.enabled"]).toEqual({
      frequency: 0.5,
      types: { boolean: 2 },
    });
    expect(description.common_shapes).toHaveLength(3);
    expect(description.common_shapes[0]).toEqual({
      count: 2,
      fields: {
        _id: "objectid",
        profile: "object",
        "profile.enabled": "boolean",
        value: "long",
      },
      frequency: 0.5,
    });
  });
});

describe("sampleCommand", () => {
  test("samples the single memory collection and enforces the requested bound", async () => {
    let collectionName = "";
    let pipeline: unknown;
    const context = {
      db: {
        collection(name: string) {
          collectionName = name;
          return {
            aggregate(value: unknown) {
              pipeline = value;
              return { toArray: async () => [{ value: 1 }] };
            },
          };
        },
      },
    } as unknown as CommandContext;

    const result = await sampleCommand.run(context, ["--size", "7"]);

    expect(collectionName).toBe("memory");
    expect(pipeline).toEqual([{ $sample: { size: 7 } }]);
    expect(result).toEqual({
      collection: "memory",
      documents: [{ value: 1 }],
      requested_size: 7,
    });
  });

  test("rejects an unbounded sample size", async () => {
    await expect(
      sampleCommand.run({} as CommandContext, ["1001"]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
      exitCode: 2,
    });
  });
});

describe("inspectCommand", () => {
  test("describes the single memory collection without listing any others", async () => {
    let collectionName = "";
    const context = {
      db: {
        // Present and deliberately unused: with one fixed collection there is
        // nothing to enumerate, and calling this would reintroduce the
        // per-collection walk the store no longer has.
        listCollections() {
          throw new Error("inspect must not enumerate collections");
        },
        collection(name: string) {
          collectionName = name;
          return {
            aggregate() {
              return { toArray: async () => [{ note: "kept" }] };
            },
            estimatedDocumentCount: async () => 3,
          };
        },
      },
    } as unknown as CommandContext;

    const result = (await inspectCommand.run(context, [])) as {
      collection: string;
      common_fields: Record<string, unknown>;
      documents: number;
      inspection: { sample_size: number };
      sampled_documents: number;
    };

    expect(collectionName).toBe("memory");
    expect(result).toMatchObject({
      collection: "memory",
      documents: 3,
      inspection: { sample_size: 100 },
      sampled_documents: 1,
    });
    expect(Object.keys(result.common_fields)).toEqual(["note"]);
  });
});
