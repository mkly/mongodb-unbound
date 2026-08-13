export const SCHEMA_ANALYSIS_DIMENSIONS = [
  "collection",
  "run_id",
  "task_id",
  "condition",
] as const;

export type SchemaAnalysisDimension =
  (typeof SCHEMA_ANALYSIS_DIMENSIONS)[number];

export interface SchemaObservation {
  agent_id?: string | null;
  collection: string;
  condition: string;
  field_paths?: readonly string[];
  fingerprint: string;
  run_id?: string | null;
  task_id?: string | null;
  timestamp: Date | number | string;
}

export interface SchemaAnalysisFilter {
  agent_id?: string | null | readonly (string | null)[];
  collection?: string | readonly string[];
  condition?: string | readonly string[];
  run_id?: string | null | readonly (string | null)[];
  task_id?: string | null | readonly (string | null)[];
}

export interface SchemaAnalysisOptions {
  end_time?: Date | number | string;
  filters?: SchemaAnalysisFilter;
  group_by?: readonly SchemaAnalysisDimension[];
  start_time?: Date | number | string;
  window_ms: number;
}

export interface AnalysisGroupKey {
  collection?: string;
  condition: string;
  run_id?: string | null;
  task_id?: string | null;
}

export interface WindowMetrics {
  effective_schema_count: number | null;
  end_time: string;
  fingerprint_counts: Record<string, number>;
  fingerprint_frequencies: Record<string, number>;
  observation_count: number;
  shannon_entropy: number | null;
  start_time: string;
  status: "no-data" | "ok";
  temporal_js_divergence: number | null;
  temporal_status: "insufficient-data" | "ok";
}

export interface AgentDistribution {
  agent_id: string;
  fingerprint_counts: Record<string, number>;
  fingerprint_frequencies: Record<string, number>;
  observation_count: number;
}

export interface FieldAgentFrequency {
  agent_id: string;
  field_path: string;
  frequency: number;
  observation_count: number;
  present_count: number;
}

export interface FingerprintAdoption {
  fingerprint: string;
  first_seen: string;
  first_seen_agent_id: string | null;
  subsequent_agents: Array<{ agent_id: string; first_seen: string }>;
}

export interface AttributionMetrics {
  agent_distributions: AgentDistribution[];
  attributed_observations: number;
  average_pairwise_js_divergence: number | null;
  divergence_status: "insufficient-data" | "ok";
  field_by_agent: FieldAgentFrequency[];
  fingerprint_adoption: FingerprintAdoption[];
  unattributed_observations: number;
}

export interface SchemaAnalysisGroup {
  attribution: AttributionMetrics;
  fingerprint_counts: Record<string, number>;
  key: AnalysisGroupKey;
  observation_count: number;
  windows: WindowMetrics[];
}

export interface ConditionComparison {
  conditions: [string, string];
  fingerprint_js_divergence: number | null;
  key: Omit<AnalysisGroupKey, "condition">;
  observation_counts: [number, number];
  status: "insufficient-data" | "ok";
}

export interface SchemaAnalysisResult {
  condition_comparisons: ConditionComparison[];
  group_by: SchemaAnalysisDimension[];
  groups: SchemaAnalysisGroup[];
  window_ms: number;
}

interface NormalizedObservation extends Omit<SchemaObservation, "timestamp"> {
  timestamp: number;
}

function timestamp(value: Date | number | string, label: string): number {
  const result =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isFinite(result))
    throw new TypeError(`${label} must be a valid timestamp`);
  return result;
}

function sortedRecord(
  entries: Iterable<readonly [string, number]>,
): Record<string, number> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countsFor(
  observations: readonly NormalizedObservation[],
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    counts.set(
      observation.fingerprint,
      (counts.get(observation.fingerprint) ?? 0) + 1,
    );
  }
  return sortedRecord(counts);
}

function frequencies(counts: Record<string, number>): Record<string, number> {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) return {};
  return sortedRecord(
    Object.entries(counts).map(([key, count]) => [key, count / total]),
  );
}

export function shannonEntropy(
  distribution: Readonly<Record<string, number>>,
): number | null {
  const values = Object.values(distribution).filter((value) => value > 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total === 0) return null;
  const entropy = -values.reduce((sum, value) => {
    const probability = value / total;
    return sum + probability * Math.log2(probability);
  }, 0);
  return Object.is(entropy, -0) ? 0 : entropy;
}

export function jensenShannonDivergence(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): number | null {
  const leftTotal = Object.values(left).reduce(
    (sum, value) => sum + Math.max(0, value),
    0,
  );
  const rightTotal = Object.values(right).reduce(
    (sum, value) => sum + Math.max(0, value),
    0,
  );
  if (leftTotal === 0 || rightTotal === 0) return null;

  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let divergence = 0;
  for (const key of keys) {
    const p = Math.max(0, left[key] ?? 0) / leftTotal;
    const q = Math.max(0, right[key] ?? 0) / rightTotal;
    const midpoint = (p + q) / 2;
    if (p > 0) divergence += (p * Math.log2(p / midpoint)) / 2;
    if (q > 0) divergence += (q * Math.log2(q / midpoint)) / 2;
  }
  return divergence;
}

function matches(
  value: string | null,
  expected: string | null | readonly (string | null)[],
): boolean {
  return Array.isArray(expected)
    ? expected.includes(value)
    : value === expected;
}

function passesFilters(
  observation: NormalizedObservation,
  filters: SchemaAnalysisFilter,
): boolean {
  const entries = Object.entries(filters) as Array<
    [keyof SchemaAnalysisFilter, string | null | readonly (string | null)[]]
  >;
  return entries.every(([dimension, expected]) => {
    const value = observation[dimension] ?? null;
    return matches(value, expected);
  });
}

function dimensionValue(
  observation: NormalizedObservation,
  dimension: SchemaAnalysisDimension,
): string | null {
  return observation[dimension] ?? null;
}

function groupKey(
  observation: NormalizedObservation,
  dimensions: readonly SchemaAnalysisDimension[],
): AnalysisGroupKey {
  const key = { condition: observation.condition } as AnalysisGroupKey;
  for (const dimension of dimensions) {
    Object.assign(key, { [dimension]: dimensionValue(observation, dimension) });
  }
  return key;
}

function attributionMetrics(
  observations: readonly NormalizedObservation[],
): AttributionMetrics {
  const byAgent = new Map<string, NormalizedObservation[]>();
  for (const observation of observations) {
    if (observation.agent_id) {
      const current = byAgent.get(observation.agent_id) ?? [];
      current.push(observation);
      byAgent.set(observation.agent_id, current);
    }
  }

  const agentDistributions = [...byAgent]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agent_id, values]) => {
      const fingerprint_counts = countsFor(values);
      return {
        agent_id,
        fingerprint_counts,
        fingerprint_frequencies: frequencies(fingerprint_counts),
        observation_count: values.length,
      };
    });

  const divergences: number[] = [];
  for (let left = 0; left < agentDistributions.length; left += 1) {
    for (let right = left + 1; right < agentDistributions.length; right += 1) {
      const divergence = jensenShannonDivergence(
        agentDistributions[left].fingerprint_counts,
        agentDistributions[right].fingerprint_counts,
      );
      if (divergence !== null) divergences.push(divergence);
    }
  }

  const fieldByAgent: FieldAgentFrequency[] = [];
  for (const [agent_id, values] of [...byAgent].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const presentCounts = new Map<string, number>();
    for (const value of values) {
      for (const field of new Set(value.field_paths ?? [])) {
        presentCounts.set(field, (presentCounts.get(field) ?? 0) + 1);
      }
    }
    for (const [field_path, present_count] of [...presentCounts].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      fieldByAgent.push({
        agent_id,
        field_path,
        frequency: present_count / values.length,
        observation_count: values.length,
        present_count,
      });
    }
  }

  const byFingerprint = new Map<string, NormalizedObservation[]>();
  for (const observation of observations) {
    const current = byFingerprint.get(observation.fingerprint) ?? [];
    current.push(observation);
    byFingerprint.set(observation.fingerprint, current);
  }
  const fingerprintAdoption = [...byFingerprint]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fingerprint, values]) => {
      const ordered = [...values].sort(
        (left, right) =>
          left.timestamp - right.timestamp ||
          (left.agent_id ?? "").localeCompare(right.agent_id ?? ""),
      );
      const first = ordered[0];
      const firstAgent = first.agent_id ?? null;
      const seen = new Set(firstAgent ? [firstAgent] : []);
      const subsequent_agents: Array<{ agent_id: string; first_seen: string }> =
        [];
      for (const observation of ordered) {
        if (!observation.agent_id || seen.has(observation.agent_id)) continue;
        seen.add(observation.agent_id);
        subsequent_agents.push({
          agent_id: observation.agent_id,
          first_seen: new Date(observation.timestamp).toISOString(),
        });
      }
      return {
        fingerprint,
        first_seen: new Date(first.timestamp).toISOString(),
        first_seen_agent_id: firstAgent,
        subsequent_agents,
      };
    });

  const attributed = agentDistributions.reduce(
    (sum, distribution) => sum + distribution.observation_count,
    0,
  );
  return {
    agent_distributions: agentDistributions,
    attributed_observations: attributed,
    average_pairwise_js_divergence:
      divergences.length === 0
        ? null
        : divergences.reduce((sum, value) => sum + value, 0) /
          divergences.length,
    divergence_status: divergences.length === 0 ? "insufficient-data" : "ok",
    field_by_agent: fieldByAgent,
    fingerprint_adoption: fingerprintAdoption,
    unattributed_observations: observations.length - attributed,
  };
}

function windowMetrics(
  observations: readonly NormalizedObservation[],
  start: number,
  end: number,
  windowMs: number,
): WindowMetrics[] {
  const windows: WindowMetrics[] = [];
  let previousCounts: Record<string, number> | null = null;
  for (let windowStart = start; windowStart < end; windowStart += windowMs) {
    const windowEnd = Math.min(windowStart + windowMs, end);
    const values = observations.filter(
      (observation) =>
        observation.timestamp >= windowStart &&
        observation.timestamp < windowEnd,
    );
    const fingerprint_counts = countsFor(values);
    const entropy = shannonEntropy(fingerprint_counts);
    const divergence = previousCounts
      ? jensenShannonDivergence(previousCounts, fingerprint_counts)
      : null;
    windows.push({
      effective_schema_count: entropy === null ? null : 2 ** entropy,
      end_time: new Date(windowEnd).toISOString(),
      fingerprint_counts,
      fingerprint_frequencies: frequencies(fingerprint_counts),
      observation_count: values.length,
      shannon_entropy: entropy,
      start_time: new Date(windowStart).toISOString(),
      status: values.length === 0 ? "no-data" : "ok",
      temporal_js_divergence: divergence,
      temporal_status: divergence === null ? "insufficient-data" : "ok",
    });
    previousCounts = fingerprint_counts;
  }
  return windows;
}

function conditionComparisons(
  groups: readonly SchemaAnalysisGroup[],
): ConditionComparison[] {
  const buckets = new Map<string, SchemaAnalysisGroup[]>();
  for (const group of groups) {
    const { condition: _condition, ...key } = group.key;
    const serialized = JSON.stringify(key);
    const current = buckets.get(serialized) ?? [];
    current.push(group);
    buckets.set(serialized, current);
  }

  const comparisons: ConditionComparison[] = [];
  for (const bucket of buckets.values()) {
    const ordered = [...bucket].sort((left, right) =>
      left.key.condition.localeCompare(right.key.condition),
    );
    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = left + 1; right < ordered.length; right += 1) {
        const divergence = jensenShannonDivergence(
          ordered[left].fingerprint_counts,
          ordered[right].fingerprint_counts,
        );
        const { condition: _condition, ...key } = ordered[left].key;
        comparisons.push({
          conditions: [
            ordered[left].key.condition,
            ordered[right].key.condition,
          ],
          fingerprint_js_divergence: divergence,
          key,
          observation_counts: [
            ordered[left].observation_count,
            ordered[right].observation_count,
          ],
          status: divergence === null ? "insufficient-data" : "ok",
        });
      }
    }
  }
  return comparisons;
}

export function analyzeSchemaObservations(
  observations: readonly SchemaObservation[],
  options: SchemaAnalysisOptions,
): SchemaAnalysisResult {
  if (!Number.isSafeInteger(options.window_ms) || options.window_ms <= 0) {
    throw new RangeError("window_ms must be a positive safe integer");
  }

  const dimensions = [
    ...new Set(options.group_by ?? SCHEMA_ANALYSIS_DIMENSIONS),
  ];
  if (!dimensions.includes("condition")) dimensions.push("condition");
  const normalized = observations
    .map((observation) => ({
      ...observation,
      timestamp: timestamp(observation.timestamp, "observation timestamp"),
    }))
    .filter((observation) => passesFilters(observation, options.filters ?? {}));

  const requestedStart =
    options.start_time === undefined
      ? null
      : timestamp(options.start_time, "start_time");
  const requestedEnd =
    options.end_time === undefined
      ? null
      : timestamp(options.end_time, "end_time");
  if (
    requestedStart !== null &&
    requestedEnd !== null &&
    requestedEnd <= requestedStart
  ) {
    throw new RangeError("end_time must be later than start_time");
  }

  const inRange = normalized.filter(
    (observation) =>
      (requestedStart === null || observation.timestamp >= requestedStart) &&
      (requestedEnd === null || observation.timestamp < requestedEnd),
  );
  const buckets = new Map<
    string,
    { key: AnalysisGroupKey; values: NormalizedObservation[] }
  >();
  for (const observation of inRange) {
    const key = groupKey(observation, dimensions);
    const serialized = JSON.stringify(key);
    const bucket = buckets.get(serialized) ?? { key, values: [] };
    bucket.values.push(observation);
    buckets.set(serialized, bucket);
  }

  const groups = [...buckets.values()]
    .sort((left, right) =>
      JSON.stringify(left.key).localeCompare(JSON.stringify(right.key)),
    )
    .map(({ key, values }) => {
      const first = Math.min(...values.map((value) => value.timestamp));
      const last = Math.max(...values.map((value) => value.timestamp));
      const start =
        requestedStart ??
        Math.floor(first / options.window_ms) * options.window_ms;
      const end =
        requestedEnd ??
        Math.floor(last / options.window_ms) * options.window_ms +
          options.window_ms;
      return {
        attribution: attributionMetrics(values),
        fingerprint_counts: countsFor(values),
        key,
        observation_count: values.length,
        windows: windowMetrics(values, start, end, options.window_ms),
      };
    });

  return {
    condition_comparisons: conditionComparisons(groups),
    group_by: dimensions,
    groups,
    window_ms: options.window_ms,
  };
}
