import type { Document, Filter, UpdateFilter } from "mongodb";

import type { CommandHandler } from "./command.ts";
import { parseEjson, parseId } from "./ejson.ts";
import { CliError } from "./errors.ts";
import { fingerprintDocument } from "./schema-fingerprint.ts";

export const DEFAULT_COLLECTION = "default";
export const DEFAULT_FIND_LIMIT = 100;
export const MAX_FIND_LIMIT = 1_000;

function invalidArguments(message: string): never {
  throw new CliError(message, {
    code: "INVALID_ARGUMENTS",
    exitCode: 2,
  });
}

function parseDocument(input: string, label: string): Document {
  const value = parseEjson<unknown>(input, label);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalidArguments(`${label} must be an Extended JSON document`);
  }
  return value as Document;
}

// `updateOne` rejects a plain document -- it requires atomic operators. But the
// command is documented as `update [collection] <id> <update>`, so a plain
// document is the obvious thing to pass, and rejecting it is a worse answer than
// doing what was meant. A document with no top-level `$` key is treated as the
// fields to set; anything using operators is passed through untouched.
function toUpdateFilter(update: Document): Document {
  const usesOperators = Object.keys(update).some((key) => key.startsWith("$"));
  return usesOperators ? update : { $set: update };
}

// The fields an update actually writes, so its shape is comparable with an
// insert's. `{"a":1}` and `{"$set":{"a":1}}` describe the same shape and must
// fingerprint the same; an update that only removes or increments fields
// describes no shape at all.
function updatedFields(update: Document): Document | undefined {
  const usesOperators = Object.keys(update).some((key) => key.startsWith("$"));
  if (!usesOperators) return update;
  const set = update.$set;
  return set !== null && typeof set === "object" && !Array.isArray(set)
    ? (set as Document)
    : undefined;
}

function parseCollectionAndValues(
  args: readonly string[],
  valueCount: number,
  usage: string,
): { collection: string; values: readonly string[] } {
  if (args.length === valueCount) {
    return { collection: DEFAULT_COLLECTION, values: args };
  }
  if (args.length === valueCount + 1 && args[0].length > 0) {
    return { collection: args[0], values: args.slice(1) };
  }
  return invalidArguments(`Usage: ${usage}`);
}

function parseFindArguments(args: readonly string[]): {
  collection: string;
  filter: Document;
  limit: number;
} {
  const positional: string[] = [];
  let limit = DEFAULT_FIND_LIMIT;
  let sawLimit = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let rawLimit: string | undefined;

    if (argument === "--limit") {
      rawLimit = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--limit=")) {
      rawLimit = argument.slice("--limit=".length);
    } else if (argument.startsWith("-")) {
      invalidArguments(`Unknown find option: ${argument}`);
    } else {
      positional.push(argument);
      continue;
    }

    if (sawLimit) {
      invalidArguments("--limit may only be specified once");
    }
    if (rawLimit === undefined || !/^\d+$/.test(rawLimit)) {
      invalidArguments("--limit requires a positive integer");
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_FIND_LIMIT) {
      invalidArguments(`--limit must be between 1 and ${MAX_FIND_LIMIT}`);
    }
    sawLimit = true;
  }

  const parsed = parseCollectionAndValues(
    positional,
    1,
    "unbounded find [collection] <filter> [--limit N]",
  );
  return {
    collection: parsed.collection,
    filter: parseDocument(parsed.values[0], "filter"),
    limit,
  };
}

export const insertCommand: CommandHandler = {
  name: "insert",
  summary: "Insert one Extended JSON document",
  usage: "insert [collection] <document>",
  async run(context, args) {
    const parsed = parseCollectionAndValues(
      args,
      1,
      "unbounded insert [collection] <document>",
    );
    const document = parseDocument(parsed.values[0], "document");
    const result = await context.db
      .collection(parsed.collection)
      .insertOne(document);
    return {
      acknowledged: result.acknowledged,
      collection: parsed.collection,
      insertedId: result.insertedId,
      // Reported so the telemetry wrapper can read the shape off our output
      // instead of re-deriving it from argv with a second implementation.
      schemaFingerprint: fingerprintDocument(document, {
        generatedId: result.insertedId,
      }).hash,
    };
  },
};

export const findCommand: CommandHandler = {
  name: "find",
  summary: "Find documents matching an Extended JSON filter",
  usage: "find [collection] <filter> [--limit N]",
  async run(context, args) {
    const parsed = parseFindArguments(args);
    return await context.db
      .collection(parsed.collection)
      .find(parsed.filter, { promoteValues: false })
      .limit(parsed.limit)
      .toArray();
  },
};

export const getCommand: CommandHandler = {
  name: "get",
  summary: "Get one document by _id",
  usage: "get [collection] <id>",
  async run(context, args) {
    const parsed = parseCollectionAndValues(
      args,
      1,
      "unbounded get [collection] <id>",
    );
    const id = parseId(parsed.values[0]);
    return await context.db
      .collection(parsed.collection)
      .findOne({ _id: id } as Filter<Document>, { promoteValues: false });
  },
};

export const updateCommand: CommandHandler = {
  name: "update",
  summary: "Update one document by _id",
  usage: "update [collection] <id> <update>",
  async run(context, args) {
    const parsed = parseCollectionAndValues(
      args,
      2,
      "unbounded update [collection] <id> <update>",
    );
    const id = parseId(parsed.values[0]);
    const update = parseDocument(parsed.values[1], "update");
    const result = await context.db
      .collection(parsed.collection)
      .updateOne(
        { _id: id } as Filter<Document>,
        toUpdateFilter(update) as UpdateFilter<Document>,
      );
    const fields = updatedFields(update);
    return {
      acknowledged: result.acknowledged,
      collection: parsed.collection,
      ...(fields === undefined
        ? {}
        : { schemaFingerprint: fingerprintDocument(fields).hash }),
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedCount: result.upsertedCount,
      upsertedId: result.upsertedId,
    };
  },
};

export const deleteCommand: CommandHandler = {
  name: "delete",
  summary: "Delete one document by _id",
  usage: "delete [collection] <id>",
  async run(context, args) {
    const parsed = parseCollectionAndValues(
      args,
      1,
      "unbounded delete [collection] <id>",
    );
    const id = parseId(parsed.values[0]);
    const result = await context.db
      .collection(parsed.collection)
      .deleteOne({ _id: id } as Filter<Document>);
    return {
      acknowledged: result.acknowledged,
      collection: parsed.collection,
      deletedCount: result.deletedCount,
    };
  },
};

export const crudCommands: readonly CommandHandler[] = [
  insertCommand,
  findCommand,
  getCommand,
  updateCommand,
  deleteCommand,
];
