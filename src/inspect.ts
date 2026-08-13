import type { Document } from "mongodb";

import type { CommandContext, CommandHandler } from "./command.ts";
import { CliError } from "./errors.ts";

const DEFAULT_COLLECTION = "default";
const DEFAULT_SAMPLE_SIZE = 20;
const DEFAULT_INSPECTION_SIZE = 100;
const MAX_SAMPLE_SIZE = 1_000;
const MAX_INSPECTION_COLLECTIONS = 100;

interface FieldObservation {
  frequency: number;
  types: Record<string, number>;
}

interface ShapeObservation {
  count: number;
  fields: Record<string, string>;
  frequency: number;
}

export interface DocumentDescription {
  common_fields: Record<string, FieldObservation>;
  common_shapes: ShapeObservation[];
  sampled_documents: number;
}

function invalidArguments(message: string): never {
  throw new CliError(message, {
    code: "INVALID_ARGUMENTS",
    exitCode: 2,
  });
}

function parseBoundedSize(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    invalidArguments(`${label} must be an integer`);
  }

  const size = Number(value);
  if (size < 1 || size > MAX_SAMPLE_SIZE) {
    invalidArguments(`${label} must be between 1 and ${MAX_SAMPLE_SIZE}`);
  }
  return size;
}

function parseCollectionAndSize(
  args: readonly string[],
  defaultSize: number,
): { collection: string; collectionSpecified: boolean; size: number } {
  let collection: string | undefined;
  let size = defaultSize;
  let sizeSpecified = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--size" || argument === "--limit") {
      if (sizeSpecified)
        invalidArguments("Sample size may only be specified once");
      const value = args[index + 1];
      if (value === undefined) {
        invalidArguments(`${argument} requires a value`);
      }
      size = parseBoundedSize(value, argument);
      sizeSpecified = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--size=") || argument.startsWith("--limit=")) {
      if (sizeSpecified)
        invalidArguments("Sample size may only be specified once");
      const [flag, value = ""] = argument.split("=", 2);
      size = parseBoundedSize(value, flag);
      sizeSpecified = true;
      continue;
    }
    if (argument.startsWith("-")) {
      invalidArguments(`Unknown option: ${argument}`);
    }
    if (collection === undefined) {
      if (/^\d+$/.test(argument)) {
        if (sizeSpecified)
          invalidArguments("Sample size may only be specified once");
        size = parseBoundedSize(argument, "sample size");
        sizeSpecified = true;
      } else {
        collection = argument;
      }
      continue;
    }
    if (!sizeSpecified) {
      size = parseBoundedSize(argument, "sample size");
      sizeSpecified = true;
      continue;
    }
    invalidArguments("Too many arguments");
  }

  return {
    collection: collection ?? DEFAULT_COLLECTION,
    collectionSpecified: collection !== undefined,
    size,
  };
}

function bsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";

  if (typeof value === "object") {
    const bsonName = (value as { _bsontype?: unknown })._bsontype;
    if (typeof bsonName === "string") return bsonName.toLowerCase();
    return "object";
  }

  return typeof value;
}

function ratio(count: number, total: number): number {
  return Number((count / total).toFixed(4));
}

export function describeDocuments(
  documents: readonly Document[],
): DocumentDescription {
  const fieldCounts = new Map<string, number>();
  const fieldTypes = new Map<string, Map<string, number>>();
  const shapes = new Map<
    string,
    { count: number; fields: Record<string, string> }
  >();

  for (const document of documents) {
    const fields = Object.fromEntries(
      Object.keys(document)
        .sort()
        .map((field) => [field, bsonType(document[field])]),
    );

    for (const [field, type] of Object.entries(fields)) {
      fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
      const types = fieldTypes.get(field) ?? new Map<string, number>();
      types.set(type, (types.get(type) ?? 0) + 1);
      fieldTypes.set(field, types);
    }

    const key = JSON.stringify(fields);
    const current = shapes.get(key);
    shapes.set(key, { count: (current?.count ?? 0) + 1, fields });
  }

  const total = documents.length;
  const commonFields = Object.fromEntries(
    [...fieldCounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, count]) => [
        field,
        {
          frequency: total === 0 ? 0 : ratio(count, total),
          types: Object.fromEntries(
            [...(fieldTypes.get(field) ?? [])].sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        },
      ]),
  );
  const commonShapes = [...shapes.values()]
    .sort(
      (left, right) =>
        right.count - left.count ||
        JSON.stringify(left.fields).localeCompare(JSON.stringify(right.fields)),
    )
    .map(({ count, fields }) => ({
      count,
      fields,
      frequency: total === 0 ? 0 : ratio(count, total),
    }));

  return {
    common_fields: commonFields,
    common_shapes: commonShapes,
    sampled_documents: total,
  };
}

export const sampleCommand: CommandHandler = {
  name: "sample",
  summary: "Return a bounded random sample of documents",
  usage: "sample [collection] [size|--size SIZE]",
  async run(context, args) {
    const { collection, size } = parseCollectionAndSize(
      args,
      DEFAULT_SAMPLE_SIZE,
    );
    const documents = await context.db
      .collection(collection)
      .aggregate([{ $sample: { size } }], { promoteValues: false })
      .toArray();

    return { collection, documents, requested_size: size };
  },
};

async function inspectCollection(
  context: CommandContext,
  collectionName: string,
  sampleSize: number,
) {
  const collection = context.db.collection(collectionName);
  const [documents, count] = await Promise.all([
    collection
      .aggregate([{ $sample: { size: sampleSize } }], { promoteValues: false })
      .toArray(),
    collection.estimatedDocumentCount(),
  ]);

  return {
    documents: count,
    ...describeDocuments(documents),
  };
}

export const inspectCommand: CommandHandler = {
  name: "inspect",
  summary: "Describe observed fields, BSON types, and document shapes",
  usage: "inspect [collection] [sample-size|--size SAMPLE_SIZE]",
  async run(context, args) {
    const parsed = parseCollectionAndSize(args, DEFAULT_INSPECTION_SIZE);
    const inspectAll = !parsed.collectionSpecified;

    let names: string[];
    let truncated = false;
    if (inspectAll) {
      const listed = await context.db
        .listCollections({ type: "collection" }, { nameOnly: true })
        .toArray();
      const userCollections = listed
        .map(({ name }) => name)
        .filter((name) => !name.startsWith("system."))
        .sort();
      truncated = userCollections.length > MAX_INSPECTION_COLLECTIONS;
      names = userCollections.slice(0, MAX_INSPECTION_COLLECTIONS);
    } else {
      names = [parsed.collection];
    }

    const entries = await Promise.all(
      names.map(
        async (name) =>
          [name, await inspectCollection(context, name, parsed.size)] as const,
      ),
    );

    return {
      collections: Object.fromEntries(entries),
      inspection: {
        collection_limit: MAX_INSPECTION_COLLECTIONS,
        sample_size: parsed.size,
        truncated,
      },
    };
  },
};
