import type { CreateIndexesOptions, IndexDirection } from "mongodb";

import type { CommandHandler } from "./command.ts";
import { parseEjson } from "./ejson.ts";
import { CliError } from "./errors.ts";

function invalidArguments(message: string): never {
  throw new CliError(message, {
    code: "INVALID_ARGUMENTS",
    exitCode: 2,
  });
}

function requireArgumentCount(
  command: string,
  args: readonly string[],
  minimum: number,
  maximum = minimum,
): void {
  if (args.length < minimum || args.length > maximum) {
    const expected =
      minimum === maximum ? `${minimum}` : `${minimum}-${maximum}`;
    invalidArguments(
      `${command} expects ${expected} argument${maximum === 1 ? "" : "s"}`,
    );
  }
}

function requireDocument<T extends object>(value: unknown, label: string): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidArguments(`${label} must be an Extended JSON document`);
  }
  return value as T;
}

export const collectionsCommand: CommandHandler = {
  name: "collections",
  summary: "List user collections",
  usage: "collections",
  async run({ db }, args) {
    requireArgumentCount("collections", args, 0);
    const collections = await db
      .listCollections({}, { nameOnly: true })
      .toArray();

    return {
      collections: collections
        .map(({ name }) => name)
        .filter((name) => !name.startsWith("system."))
        .sort(),
    };
  },
};

export const createCollectionCommand: CommandHandler = {
  name: "create-collection",
  summary: "Create a named collection",
  usage: "create-collection <collection>",
  async run({ db }, args) {
    requireArgumentCount("create-collection", args, 1);
    const collection = args[0];
    await db.createCollection(collection);

    return { collection, created: true };
  },
};

export const indexesCommand: CommandHandler = {
  name: "indexes",
  summary: "List indexes for one or all collections",
  usage: "indexes [collection]",
  async run({ db }, args) {
    requireArgumentCount("indexes", args, 0, 1);

    const collectionNames =
      args.length === 1
        ? [args[0]]
        : (await db.listCollections({}, { nameOnly: true }).toArray())
            .map(({ name }) => name)
            .filter((name) => !name.startsWith("system."))
            .sort();
    const collections = await Promise.all(
      collectionNames.map(async (collection) => ({
        collection,
        indexes: await db.collection(collection).indexes(),
      })),
    );

    return { collections };
  },
};

export const createIndexCommand: CommandHandler = {
  name: "create-index",
  summary: "Create an index from Extended JSON specifications",
  usage: "create-index <collection> <keys-ejson> [options-ejson]",
  async run({ db }, args) {
    requireArgumentCount("create-index", args, 2, 3);
    const [collection, keysInput, optionsInput] = args;
    const keys = requireDocument<Record<string, IndexDirection>>(
      parseEjson(keysInput, "index keys"),
      "Index keys",
    );
    const options =
      optionsInput === undefined
        ? undefined
        : requireDocument<CreateIndexesOptions>(
            parseEjson(optionsInput, "index options"),
            "Index options",
          );
    const index = await db.collection(collection).createIndex(keys, options);

    return { collection, index };
  },
};

export const collectionCommandHandlers: readonly CommandHandler[] = [
  collectionsCommand,
  createCollectionCommand,
  indexesCommand,
  createIndexCommand,
];
