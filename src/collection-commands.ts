import type { CreateIndexesOptions, Db, IndexDirection } from "mongodb";

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
      `${command} expects ${expected} argument${minimum === 1 && maximum === 1 ? "" : "s"}`,
    );
  }
}

function requireCollectionName(value: string, command: string): string {
  if (value.length === 0) {
    invalidArguments(`${command} requires a collection name`);
  }
  return value;
}

function requireDocument<T extends object>(value: unknown, label: string): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidArguments(`${label} must be an Extended JSON document`);
  }
  return value as T;
}

async function listUserCollections(db: Db): Promise<string[]> {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  return collections
    .map(({ name }) => name)
    .filter((name) => !name.startsWith("system."))
    .sort();
}

export const collectionsCommand: CommandHandler = {
  name: "collections",
  summary: "List user collections",
  usage: "collections",
  async run({ db }, args) {
    requireArgumentCount("collections", args, 0);

    return { collections: await listUserCollections(db) };
  },
};

export const createCollectionCommand: CommandHandler = {
  name: "create-collection",
  summary: "Create a named collection",
  usage: "create-collection <collection>",
  async run({ db }, args) {
    requireArgumentCount("create-collection", args, 1);
    const collection = requireCollectionName(args[0], "create-collection");
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
        ? [requireCollectionName(args[0], "indexes")]
        : await listUserCollections(db);
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
    const [collectionInput, keysInput, optionsInput] = args;
    const collection = requireCollectionName(collectionInput, "create-index");
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
