import { describe, expect, test } from "bun:test";
import type { Db } from "mongodb";

import {
  collectionsCommand,
  createCollectionCommand,
  createIndexCommand,
  indexesCommand,
} from "./collection-commands.ts";
import type { CommandContext } from "./command.ts";
import type { CliError } from "./errors.ts";

interface StubCalls {
  createdCollections: string[];
  createdIndexes: { collection: string; keys: unknown; options: unknown }[];
}

function stubContext(names: readonly string[]): {
  calls: StubCalls;
  context: CommandContext;
} {
  const calls: StubCalls = { createdCollections: [], createdIndexes: [] };
  const db = {
    listCollections: () => ({
      toArray: async () => names.map((name) => ({ name })),
    }),
    createCollection: async (name: string) => {
      calls.createdCollections.push(name);
    },
    collection: (name: string) => ({
      indexes: async () => [{ name: `${name}_id_` }],
      createIndex: async (keys: unknown, options: unknown) => {
        calls.createdIndexes.push({ collection: name, keys, options });
        return `${name}_index`;
      },
    }),
  } as unknown as Db;

  return { calls, context: { db } as unknown as CommandContext };
}

async function expectInvalidArguments(
  run: Promise<unknown>,
): Promise<CliError> {
  try {
    await run;
  } catch (error) {
    const cliError = error as CliError;
    expect(cliError.code).toBe("INVALID_ARGUMENTS");
    expect(cliError.exitCode).toBe(2);
    return cliError;
  }
  throw new Error("expected the command to reject with a usage error");
}

describe("collections", () => {
  test("lists user collections sorted without system namespaces", async () => {
    const { context } = stubContext(["orders", "system.views", "audit"]);

    expect(await collectionsCommand.run(context, [])).toEqual({
      collections: ["audit", "orders"],
    });
  });

  test("rejects extra arguments", async () => {
    const { context } = stubContext([]);

    await expectInvalidArguments(collectionsCommand.run(context, ["orders"]));
  });
});

describe("create-collection", () => {
  test("creates the named collection", async () => {
    const { calls, context } = stubContext([]);

    expect(await createCollectionCommand.run(context, ["orders"])).toEqual({
      collection: "orders",
      created: true,
    });
    expect(calls.createdCollections).toEqual(["orders"]);
  });

  test("rejects an empty collection name", async () => {
    const { calls, context } = stubContext([]);

    await expectInvalidArguments(createCollectionCommand.run(context, [""]));
    expect(calls.createdCollections).toEqual([]);
  });
});

describe("indexes", () => {
  test("covers every user collection when none is named", async () => {
    const { context } = stubContext(["orders", "system.views"]);

    expect(await indexesCommand.run(context, [])).toEqual({
      collections: [
        { collection: "orders", indexes: [{ name: "orders_id_" }] },
      ],
    });
  });

  test("reports a usage error naming the argument range", async () => {
    const { context } = stubContext([]);
    const error = await expectInvalidArguments(
      indexesCommand.run(context, ["orders", "extra"]),
    );

    expect(error.message).toBe("indexes expects 0-1 arguments");
  });
});

describe("create-index", () => {
  test("passes Extended JSON keys and options to the driver", async () => {
    const { calls, context } = stubContext([]);

    expect(
      await createIndexCommand.run(context, [
        "orders",
        '{"placedAt":-1}',
        '{"unique":true}',
      ]),
    ).toEqual({ collection: "orders", index: "orders_index" });
    expect(calls.createdIndexes).toEqual([
      {
        collection: "orders",
        keys: { placedAt: -1 },
        options: { unique: true },
      },
    ]);
  });

  test("omits options when only keys are given", async () => {
    const { calls, context } = stubContext([]);

    await createIndexCommand.run(context, ["orders", '{"sku":1}']);

    expect(calls.createdIndexes[0].options).toBeUndefined();
  });

  test("rejects a non-document key specification", async () => {
    const { context } = stubContext([]);
    const error = await expectInvalidArguments(
      createIndexCommand.run(context, ["orders", "[1]"]),
    );

    expect(error.message).toBe("Index keys must be an Extended JSON document");
  });
});
