import { open, stat } from "node:fs/promises";

import {
  BSON,
  type ChangeStreamDocument,
  type Document,
  type Db,
} from "mongodb";

export const TELEMETRY_TYPES = [
  "model_call",
  "unbounded_op",
  "db_write",
  "run_summary",
] as const;

export type TelemetryType = (typeof TELEMETRY_TYPES)[number];
export type ActivityProvenance = "mongodb" | "telemetry" | "correlated";

const TELEMETRY_PAYLOAD_FIELDS: Record<TelemetryType, readonly string[]> = {
  model_call: [
    "model",
    "input_tokens",
    "output_tokens",
    "estimated_cost",
    "step",
  ],
  unbounded_op: [
    "operation",
    "collection",
    "success",
    "exit_code",
    "duration_ms",
  ],
  db_write: ["operation", "collection", "document_id"],
  run_summary: [
    "wall_clock_ms",
    "resolved",
    "patch_size_lines",
    "f2p_passed",
    "p2p_passed",
  ],
};

export interface ActivityAttribution {
  agentId?: string;
  condition?: string;
  runId?: string;
  taskId?: string;
}

/** A source-independent observation consumed by the observatory analysis layer. */
export interface ActivityEvent {
  kind: "activity";
  id: string;
  timestamp: string;
  provenance: ActivityProvenance;
  operation: string;
  collection?: string;
  documentId?: unknown;
  document?: Document;
  fingerprint?: string;
  success?: boolean;
  telemetryType?: TelemetryType;
  attribution?: ActivityAttribution;
}

/** A recoverable input problem. Diagnostics are data, so one bad record cannot stop a stream. */
export interface ActivityDiagnostic {
  kind: "diagnostic";
  source: "mongodb" | "telemetry";
  message: string;
  path?: string;
  line?: number;
}

export type ActivityRecord = ActivityEvent | ActivityDiagnostic;

export interface MongoActivityAdapter {
  snapshot(collection: string, limit: number): Promise<readonly Document[]>;
  watch(
    collections: readonly string[],
    options: { resumeAfter?: unknown; signal?: AbortSignal },
  ): AsyncIterable<MongoChange>;
}

export interface MongoChange {
  token: unknown;
  operation: "insert" | "replace" | "update" | "delete";
  collection: string;
  documentId?: unknown;
  document?: Document;
  timestamp?: string;
}

export interface MongoActivityOptions {
  collections: readonly string[];
  snapshotLimit?: number;
  reconnectDelayMs?: number;
  signal?: AbortSignal;
}

export interface JsonlReadResult {
  text: string;
  nextOffset: number;
}

export interface JsonlFileAdapter {
  readFrom(path: string, offset: number): Promise<JsonlReadResult>;
  waitForChange(path: string, signal?: AbortSignal): Promise<void>;
}

export interface JsonlActivityOptions {
  follow?: boolean;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  fileAdapter?: JsonlFileAdapter;
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stableValue(value: unknown): string {
  try {
    return BSON.EJSON.stringify(value, { relaxed: false });
  } catch {
    return String(value);
  }
}

function changeId(change: MongoChange): string {
  return `mongodb:${stableValue(change.token)}`;
}

/**
 * Reduce a document id to the form both sources agree on. A change stream
 * reports `_id` as a real ObjectId, while the wrapper writes `document_id` as
 * the bare hex string it scraped from the command's EJSON output, so
 * correlation has to see past that representation difference.
 */
function documentIdKey(documentId: unknown): string {
  if (documentId instanceof BSON.ObjectId) return documentId.toHexString();
  if (typeof documentId === "string") return documentId;
  return stableValue(documentId);
}

function documentKey(
  collection: string | undefined,
  documentId: unknown,
): string | undefined {
  if (!collection || documentId === undefined) return undefined;
  return `${collection}\u0000${documentIdKey(documentId)}`;
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    return undefined;
  return new Date(value).toISOString();
}

function mongoRecord(change: MongoChange): ActivityEvent {
  return {
    kind: "activity",
    id: changeId(change),
    timestamp: change.timestamp ?? new Date().toISOString(),
    provenance: "mongodb",
    operation: change.operation,
    collection: change.collection,
    documentId: change.documentId,
    document: change.document,
  };
}

/**
 * Seed bounded snapshots, then consume the already-open live cursor. The first
 * `next()` starts before snapshot reads, closing the usual snapshot/watch gap.
 */
export async function* streamMongoActivity(
  adapter: MongoActivityAdapter,
  options: MongoActivityOptions,
): AsyncGenerator<ActivityRecord> {
  const collections = [...new Set(options.collections)].sort();
  const snapshotLimit = options.snapshotLimit ?? 1_000;
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  let resumeAfter: unknown;
  const seenTokens = new Set<string>();
  let snapshotsComplete = false;
  let live: AsyncIterator<MongoChange> | undefined;
  let pendingChange: Promise<IteratorResult<MongoChange>> | undefined;

  while (true) {
    throwIfAborted(options.signal);
    try {
      const iterator = adapter
        .watch(collections, { resumeAfter, signal: options.signal })
        [Symbol.asyncIterator]();
      live = iterator;
      let pending = iterator.next();
      pendingChange = pending;

      if (!snapshotsComplete) {
        for (const collection of collections) {
          const documents = await adapter.snapshot(collection, snapshotLimit);
          for (let index = 0; index < documents.length; index += 1) {
            const document = documents[index];
            yield {
              kind: "activity",
              id: `snapshot:${collection}:${stableValue(document._id ?? index)}`,
              timestamp: new Date().toISOString(),
              provenance: "mongodb",
              operation: "snapshot",
              collection,
              documentId: document._id,
              document,
            };
          }
        }
        snapshotsComplete = true;
      }

      while (true) {
        const result = await pending;
        if (result.done) return;
        pending = iterator.next();
        pendingChange = pending;
        const token = stableValue(result.value.token);
        resumeAfter = result.value.token;
        if (seenTokens.has(token)) continue;
        seenTokens.add(token);
        yield mongoRecord(result.value);
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      yield {
        kind: "diagnostic",
        source: "mongodb",
        message: `change stream disconnected; reconnecting: ${error instanceof Error ? error.message : String(error)}`,
      };
      await delay(reconnectDelayMs, options.signal);
    } finally {
      // Whether we are reconnecting or the consumer walked away mid-yield, this
      // cursor is finished: close it so the change stream does not outlive the
      // reader, and absorb the prefetched `next()` so a cursor error arriving
      // after we stop reading cannot surface as an unhandled rejection.
      settle(pendingChange);
      pendingChange = undefined;
      const closing = live;
      live = undefined;
      settle(closing?.return?.());
    }
  }
}

/** Discard a promise's outcome without leaving an unhandled rejection behind. */
function settle(promise: PromiseLike<unknown> | undefined): void {
  void Promise.resolve(promise).catch(() => {});
}

/** Production adapter for the MongoDB Node driver. It performs only reads. */
export class MongoDbActivityAdapter implements MongoActivityAdapter {
  constructor(private readonly db: Db) {}

  async snapshot(
    collection: string,
    limit: number,
  ): Promise<readonly Document[]> {
    return this.db
      .collection(collection)
      .find({}, { promoteValues: false })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
  }

  async *watch(
    collections: readonly string[],
    options: { resumeAfter?: unknown; signal?: AbortSignal },
  ): AsyncGenerator<MongoChange> {
    const cursor = this.db.watch([], {
      fullDocument: "updateLookup",
      maxAwaitTimeMS: 1_000,
      ...(options.resumeAfter === undefined
        ? {}
        : { resumeAfter: options.resumeAfter as Document }),
    });
    try {
      for await (const change of cursor) {
        throwIfAborted(options.signal);
        const normalized = normalizeMongoChange(change);
        if (normalized && collections.includes(normalized.collection))
          yield normalized;
      }
    } finally {
      await cursor.close();
    }
  }
}

function normalizeMongoChange(
  change: ChangeStreamDocument,
): MongoChange | undefined {
  if (
    !["insert", "replace", "update", "delete"].includes(change.operationType)
  ) {
    return undefined;
  }
  const documentChange = change as ChangeStreamDocument<Document> & {
    ns?: { coll?: string };
    documentKey?: { _id?: unknown };
    fullDocument?: Document;
    clusterTime?: { getHighBits(): number; getLowBitsUnsigned(): number };
  };
  const collection = documentChange.ns?.coll;
  if (!collection) return undefined;
  const clusterTime = documentChange.clusterTime;
  const timestamp = clusterTime
    ? new Date(clusterTime.getHighBits() * 1_000).toISOString()
    : undefined;
  return {
    token: change._id,
    operation: change.operationType as MongoChange["operation"],
    collection,
    documentId: documentChange.documentKey?._id,
    document: documentChange.fullDocument ?? undefined,
    timestamp,
  };
}

export class NodeJsonlFileAdapter implements JsonlFileAdapter {
  constructor(private readonly pollIntervalMs = 100) {}

  async readFrom(path: string, offset: number): Promise<JsonlReadResult> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { text: "", nextOffset: offset };
      }
      throw error;
    }
    if (size <= offset) return { text: "", nextOffset: offset };
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return {
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        nextOffset: offset + bytesRead,
      };
    } finally {
      await handle.close();
    }
  }

  async waitForChange(_path: string, signal?: AbortSignal): Promise<void> {
    await delay(this.pollIntervalMs, signal);
  }
}

function nonemptyString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function telemetryRecord(
  value: unknown,
  path: string,
  line: number,
): ActivityRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      kind: "diagnostic",
      source: "telemetry",
      path,
      line,
      message: "record must be an object",
    };
  }
  const record = value as Record<string, unknown>;
  const type = nonemptyString(record, "type");
  if (!type || !(TELEMETRY_TYPES as readonly string[]).includes(type)) {
    return {
      kind: "diagnostic",
      source: "telemetry",
      path,
      line,
      message: `unrecognized telemetry type ${JSON.stringify(record.type)}`,
    };
  }
  const requiredEnvelope = [
    "event_id",
    "timestamp",
    "run_id",
    "task_id",
    "agent_id",
    "condition",
  ];
  const missing = requiredEnvelope.filter(
    (field) => !nonemptyString(record, field),
  );
  const timestamp = toIsoTimestamp(record.timestamp);
  if (missing.length > 0 || !timestamp) {
    return {
      kind: "diagnostic",
      source: "telemetry",
      path,
      line,
      message: `invalid telemetry envelope${missing.length ? `; missing ${missing.join(", ")}` : ""}${timestamp ? "" : "; invalid timestamp"}`,
    };
  }
  const missingPayload = TELEMETRY_PAYLOAD_FIELDS[type as TelemetryType].filter(
    (field) => !(field in record),
  );
  if (missingPayload.length > 0) {
    return {
      kind: "diagnostic",
      source: "telemetry",
      path,
      line,
      message: `incomplete ${type} record; missing ${missingPayload.join(", ")}`,
    };
  }
  return {
    kind: "activity",
    id: nonemptyString(record, "event_id") as string,
    timestamp,
    provenance: "telemetry",
    telemetryType: type as TelemetryType,
    operation: nonemptyString(record, "operation") ?? type,
    collection: nonemptyString(record, "collection"),
    documentId: record.document_id,
    document:
      typeof record.document === "object" && record.document !== null
        ? (record.document as Document)
        : undefined,
    fingerprint:
      nonemptyString(record, "schema_fingerprint") ??
      nonemptyString(record, "fingerprint"),
    success: typeof record.success === "boolean" ? record.success : undefined,
    attribution: {
      runId: nonemptyString(record, "run_id"),
      taskId: nonemptyString(record, "task_id"),
      agentId: nonemptyString(record, "agent_id"),
      condition: nonemptyString(record, "condition"),
    },
  };
}

export async function* streamJsonlFile(
  path: string,
  options: JsonlActivityOptions = {},
): AsyncGenerator<ActivityRecord> {
  const adapter =
    options.fileAdapter ?? new NodeJsonlFileAdapter(options.pollIntervalMs);
  let offset = 0;
  let carry = "";
  let line = 0;
  const seenEventIds = new Set<string>();

  while (true) {
    throwIfAborted(options.signal);
    const result = await adapter.readFrom(path, offset);
    offset = result.nextOffset;
    const parts = (carry + result.text).split("\n");
    carry = parts.pop() ?? "";
    for (const rawLine of parts) {
      line += 1;
      if (!rawLine.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLine);
      } catch (error) {
        yield {
          kind: "diagnostic",
          source: "telemetry",
          path,
          line,
          message: `malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
        continue;
      }
      const normalized = telemetryRecord(parsed, path, line);
      if (normalized.kind === "activity") {
        if (seenEventIds.has(normalized.id)) continue;
        seenEventIds.add(normalized.id);
      }
      yield normalized;
    }
    if (!options.follow) {
      if (carry.trim()) {
        yield {
          kind: "diagnostic",
          source: "telemetry",
          path,
          line: line + 1,
          message: "incomplete final JSONL line",
        };
      }
      return;
    }
    await adapter.waitForChange(path, options.signal);
  }
}

async function* mergeStreams(
  streams: readonly AsyncIterable<ActivityRecord>[],
): AsyncGenerator<ActivityRecord> {
  const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
  const pending = new Map<
    number,
    Promise<{ index: number; result: IteratorResult<ActivityRecord> }>
  >();
  for (let index = 0; index < iterators.length; index += 1) {
    pending.set(
      index,
      iterators[index].next().then((result) => ({ index, result })),
    );
  }
  try {
    while (pending.size > 0) {
      const { index, result } = await Promise.race(pending.values());
      if (result.done) {
        pending.delete(index);
        continue;
      }
      pending.set(
        index,
        iterators[index].next().then((next) => ({ index, result: next })),
      );
      yield result.value;
    }
  } finally {
    // A consumer that stops early leaves each source blocked in its own read.
    // Ask them all to close without waiting for those reads to settle, and
    // absorb the in-flight `next()` rejections they may produce on the way out.
    for (const [index, promise] of pending) {
      settle(promise);
      settle(iterators[index].return?.());
    }
  }
}

/** Replay or follow any number of per-agent telemetry files concurrently. */
export function streamJsonlActivity(
  paths: readonly string[],
  options: JsonlActivityOptions = {},
): AsyncIterable<ActivityRecord> {
  return mergeStreams(
    [...new Set(paths)].sort().map((path) => streamJsonlFile(path, options)),
  );
}

function correlate(
  mongo: ActivityEvent,
  telemetry: ActivityEvent,
): ActivityEvent {
  return {
    ...telemetry,
    id: mongo.id,
    timestamp: mongo.timestamp,
    provenance: "correlated",
    operation: mongo.operation,
    collection: mongo.collection,
    documentId: mongo.documentId,
    document: mongo.document,
    fingerprint: telemetry.fingerprint,
    success: telemetry.success,
    telemetryType: telemetry.telemetryType,
    attribution: telemetry.attribution,
  };
}

/**
 * Correlate database writes with MongoDB changes. Telemetry is buffered for a
 * short bounded window; MongoDB remains authoritative for document content.
 */
export async function* correlateActivity(
  records: AsyncIterable<ActivityRecord>,
  correlationWindowMs = 250,
): AsyncGenerator<ActivityRecord> {
  const pendingTelemetry = new Map<
    string,
    { event: ActivityEvent; expires: number }
  >();
  const pendingMongo = new Map<
    string,
    { event: ActivityEvent; expires: number }
  >();

  function* flush(now: number, all = false): Generator<ActivityEvent> {
    for (const [key, entry] of pendingTelemetry) {
      if (all || entry.expires <= now) {
        pendingTelemetry.delete(key);
        yield entry.event;
      }
    }
    for (const [key, entry] of pendingMongo) {
      if (all || entry.expires <= now) {
        pendingMongo.delete(key);
        yield entry.event;
      }
    }
  }

  const iterator = records[Symbol.asyncIterator]();
  let pendingNext = iterator.next();
  try {
    while (true) {
      const expirations = [
        ...[...pendingTelemetry.values()].map((entry) => entry.expires),
        ...[...pendingMongo.values()].map((entry) => entry.expires),
      ];
      const nextExpiration =
        expirations.length > 0 ? Math.min(...expirations) : undefined;
      const outcome =
        nextExpiration === undefined
          ? { type: "record" as const, result: await pendingNext }
          : await Promise.race([
              pendingNext.then((result) => ({
                type: "record" as const,
                result,
              })),
              delay(Math.max(0, nextExpiration - Date.now())).then(() => ({
                type: "timer" as const,
              })),
            ]);

      if (outcome.type === "timer") {
        yield* flush(Date.now());
        continue;
      }
      if (outcome.result.done) break;
      pendingNext = iterator.next();
      const record = outcome.result.value;
      yield* flush(Date.now());
      if (record.kind === "diagnostic") {
        yield record;
        continue;
      }
      const key = documentKey(record.collection, record.documentId);
      const isTelemetryWrite =
        record.provenance === "telemetry" &&
        record.telemetryType === "db_write";
      const isMongoChange =
        record.provenance === "mongodb" && record.operation !== "snapshot";
      if (!key || (!isTelemetryWrite && !isMongoChange)) {
        yield record;
        continue;
      }
      if (isTelemetryWrite) {
        const mongo = pendingMongo.get(key);
        if (mongo) {
          pendingMongo.delete(key);
          yield correlate(mongo.event, record);
        } else {
          const previous = pendingTelemetry.get(key);
          if (previous) yield previous.event;
          pendingTelemetry.set(key, {
            event: record,
            expires: Date.now() + correlationWindowMs,
          });
        }
      } else {
        const telemetry = pendingTelemetry.get(key);
        if (telemetry) {
          pendingTelemetry.delete(key);
          yield correlate(record, telemetry.event);
        } else {
          const previous = pendingMongo.get(key);
          if (previous) yield previous.event;
          pendingMongo.set(key, {
            event: record,
            expires: Date.now() + correlationWindowMs,
          });
        }
      }
    }
  } finally {
    // Some sources are blocked in an external read. Request cleanup without
    // making this stream's cancellation wait for that read to settle.
    void iterator.return?.();
  }
  yield* flush(Number.POSITIVE_INFINITY, true);
}

export interface ActivityEngineOptions {
  mongo?: { adapter: MongoActivityAdapter; options: MongoActivityOptions };
  telemetry?: { paths: readonly string[]; options?: JsonlActivityOptions };
  correlationWindowMs?: number;
}

/** Compose either or both read-only sources into one normalized stream. */
export function createActivityStream(
  options: ActivityEngineOptions,
): AsyncIterable<ActivityRecord> {
  const sources: AsyncIterable<ActivityRecord>[] = [];
  if (options.mongo)
    sources.push(
      streamMongoActivity(options.mongo.adapter, options.mongo.options),
    );
  if (options.telemetry) {
    sources.push(
      streamJsonlActivity(options.telemetry.paths, options.telemetry.options),
    );
  }
  return correlateActivity(mergeStreams(sources), options.correlationWindowMs);
}
