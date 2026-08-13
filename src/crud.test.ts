import { describe, expect, mock, test } from "bun:test";
import { Long, ObjectId, type Collection, type Db, type Document } from "mongodb";

import type { CommandContext } from "./command.ts";
import {
  deleteCommand,
  findCommand,
  getCommand,
  insertCommand,
  updateCommand,
} from "./crud.ts";
import type { CliError } from "./errors.ts";
import { fingerprintDocument } from "./schema-fingerprint.ts";

function contextWith(
  collection: Partial<Collection<Document>>,
): CommandContext {
  return {
    client: {} as CommandContext["client"],
    config: { db: "test", uri: "mongodb://example" },
    db: {
      collection: mock(() => collection as Collection<Document>),
    } as unknown as Db,
    stderr: { write() {} },
    stdout: { write() {} },
  };
}

describe("CRUD commands", () => {
  test("insert uses the default collection and preserves Extended JSON", async () => {
    const insertOne = mock(async (_document: Document) => ({
      acknowledged: true,
      insertedId: new ObjectId("64b7f0000000000000000001"),
    }));
    const context = contextWith({ insertOne } as never);

    const result = await insertCommand.run(context, [
      '{"value":{"$numberLong":"42"}}',
    ]);

    expect(context.db.collection).toHaveBeenCalledWith("default");
    expect(insertOne.mock.calls[0][0].value._bsontype).toBe("Long");
    expect(result).toMatchObject({
      acknowledged: true,
      collection: "default",
      insertedId: new ObjectId("64b7f0000000000000000001"),
      schemaFingerprint: fingerprintDocument({
        value: Long.fromString("42"),
      }).hash,
    });
  });

  test("find accepts an explicit collection and bounded limit", async () => {
    const toArray = mock(async () => [{ value: 1 }]);
    const limit = mock(() => ({ toArray }));
    const find = mock(() => ({ limit }));
    const context = contextWith({ find } as never);

    const result = await findCommand.run(context, [
      "findings",
      '{"kind":"bug"}',
      "--limit",
      "12",
    ]);

    expect(context.db.collection).toHaveBeenCalledWith("findings");
    expect(find).toHaveBeenCalledWith(
      { kind: "bug" },
      { promoteValues: false },
    );
    expect(limit).toHaveBeenCalledWith(12);
    expect(result).toEqual([{ value: 1 }]);
  });

  test("find and get keep BSON types unpromoted so output round-trips", async () => {
    const toArray = mock(async () => []);
    const limit = mock(() => ({ toArray }));
    const find = mock((_filter: Document, _options?: unknown) => ({ limit }));
    const findOne = mock(async (_filter: Document, _options?: unknown) => null);
    const context = contextWith({ find, findOne } as never);

    await findCommand.run(context, ["{}"]);
    await getCommand.run(context, ['{"$oid":"64b7f0000000000000000001"}']);

    expect(find.mock.calls[0][1]).toEqual({ promoteValues: false });
    expect(findOne.mock.calls[0][1]).toEqual({ promoteValues: false });
  });

  test("find rejects limits above the runtime bound", async () => {
    try {
      await findCommand.run(contextWith({}), ["{}", "--limit=1001"]);
      throw new Error("expected find to reject the limit");
    } catch (error) {
      const cliError = error as CliError;
      expect(cliError.code).toBe("INVALID_ARGUMENTS");
      expect(cliError.exitCode).toBe(2);
      expect(cliError.message).toBe("--limit must be between 1 and 1000");
    }
  });

  test("get parses an Extended JSON _id", async () => {
    const document = { _id: new ObjectId("64b7f0000000000000000001") };
    const findOne = mock(async (_filter: Document) => document);
    const context = contextWith({ findOne } as never);

    const result = await getCommand.run(context, [
      '{"$oid":"64b7f0000000000000000001"}',
    ]);

    expect(context.db.collection).toHaveBeenCalledWith("default");
    expect(findOne.mock.calls[0][0]._id).toEqual(document._id);
    expect(result).toEqual(document);
  });

  test("update and delete use updateOne and deleteOne", async () => {
    const updateOne = mock(async () => ({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null,
    }));
    const deleteOne = mock(async () => ({
      acknowledged: true,
      deletedCount: 1,
    }));
    const context = contextWith({ deleteOne, updateOne } as never);

    await updateCommand.run(context, [
      "items",
      '"key-1"',
      '{"$set":{"done":true}}',
    ]);
    const result = await deleteCommand.run(context, ["items", '"key-1"']);

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "key-1" },
      { $set: { done: true } },
    );
    expect(deleteOne).toHaveBeenCalledWith({ _id: "key-1" });
    expect(result).toEqual({
      acknowledged: true,
      collection: "items",
      deletedCount: 1,
    });
  });

  test("get, update and delete accept the bare id insert prints", async () => {
    const findOne = mock(async (_filter: Document) => null);
    const updateOne = mock(async () => ({ acknowledged: true }));
    const deleteOne = mock(async () => ({ acknowledged: true }));
    const context = contextWith({ deleteOne, findOne, updateOne } as never);
    const hex = "64b7f0000000000000000001";

    await getCommand.run(context, [hex]);
    await updateCommand.run(context, [hex, "{}"]);
    await deleteCommand.run(context, [hex]);

    for (const call of [findOne, updateOne, deleteOne]) {
      expect(call.mock.calls[0][0]).toEqual({ _id: new ObjectId(hex) });
    }
  });

  test("update wraps an operator-free document so it sets rather than replaces", async () => {
    const updateOne = mock(async () => ({ acknowledged: true }));
    const context = contextWith({ updateOne } as never);

    await updateCommand.run(context, ['"key-1"', '{"done":true}']);

    expect(updateOne.mock.calls[0][1]).toEqual({ $set: { done: true } });
  });

  test("update fingerprints the fields it writes, however they were spelled", async () => {
    const updateOne = mock(async () => ({ acknowledged: true }));
    const context = contextWith({ updateOne } as never);

    const plain = await updateCommand.run(context, [
      '"key-1"',
      '{"done":true}',
    ]);
    const operators = await updateCommand.run(context, [
      '"key-1"',
      '{"$set":{"done":true}}',
    ]);
    const removal = await updateCommand.run(context, [
      '"key-1"',
      '{"$unset":{"done":""}}',
    ]);

    expect((plain as Document).schemaFingerprint).toBe(
      (operators as Document).schemaFingerprint,
    );
    // An update that writes no fields describes no shape, so it reports none
    // rather than a fingerprint of `{}` that would cluster with empty inserts.
    expect((removal as Document).schemaFingerprint).toBeUndefined();
  });
});
