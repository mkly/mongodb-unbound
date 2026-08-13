import type { Document } from "mongodb";

import type { CommandHandler } from "./command.ts";
import { MEMORY_COLLECTION } from "./crud.ts";
import { CliError } from "./errors.ts";
import { fingerprintDocument } from "./schema-fingerprint.ts";

const DEFAULT_SAMPLE_SIZE = 20;
const DEFAULT_INSPECTION_SIZE = 100;
const MAX_SAMPLE_SIZE = 1_000;

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

function parseSize(args: readonly string[], defaultSize: number): number {
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
    if (sizeSpecified) invalidArguments("Too many arguments");
    size = parseBoundedSize(argument, "sample size");
    sizeSpecified = true;
  }

  return size;
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
    const { fields, fingerprint } = fingerprintDocument(document);

    for (const [field, type] of Object.entries(fields)) {
      fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
      const types = fieldTypes.get(field) ?? new Map<string, number>();
      types.set(type, (types.get(type) ?? 0) + 1);
      fieldTypes.set(field, types);
    }

    const current = shapes.get(fingerprint);
    shapes.set(fingerprint, {
      count: (current?.count ?? 0) + 1,
      fields,
    });
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
  usage: "sample [size|--size SIZE]",
  async run(context, args) {
    const size = parseSize(args, DEFAULT_SAMPLE_SIZE);
    const documents = await context.db
      .collection(MEMORY_COLLECTION)
      .aggregate([{ $sample: { size } }], { promoteValues: false })
      .toArray();

    return {
      collection: MEMORY_COLLECTION,
      documents,
      requested_size: size,
    };
  },
};

export const inspectCommand: CommandHandler = {
  name: "inspect",
  summary: "Describe observed fields, BSON types, and document shapes",
  usage: "inspect [sample-size|--size SAMPLE_SIZE]",
  async run(context, args) {
    const size = parseSize(args, DEFAULT_INSPECTION_SIZE);
    const collection = context.db.collection(MEMORY_COLLECTION);
    const [documents, count] = await Promise.all([
      collection
        .aggregate([{ $sample: { size } }], { promoteValues: false })
        .toArray(),
      collection.estimatedDocumentCount(),
    ]);

    return {
      collection: MEMORY_COLLECTION,
      documents: count,
      ...describeDocuments(documents),
      inspection: { sample_size: size },
    };
  },
};
