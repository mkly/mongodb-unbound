import { describe, expect, test } from "bun:test";

import {
  analyzeSchemaObservations,
  jensenShannonDivergence,
  shannonEntropy,
  type SchemaObservation,
} from "./schema-analysis.ts";

const minute = 60_000;
const start = Date.parse("2026-01-01T00:00:00.000Z");

function observation(
  offset: number,
  fingerprint: string,
  overrides: Partial<SchemaObservation> = {},
): SchemaObservation {
  return {
    collection: "records",
    condition: "shared",
    fingerprint,
    timestamp: start + offset,
    ...overrides,
  };
}

describe("distribution metrics", () => {
  test("computes entropy, effective schemas, and disappearing-schema divergence", () => {
    expect(shannonEntropy({ a: 1, b: 1 })).toBe(1);
    expect(jensenShannonDivergence({ a: 1 }, { b: 1 })).toBe(1);

    const result = analyzeSchemaObservations(
      [observation(0, "a"), observation(1, "b"), observation(minute, "a")],
      { start_time: start, end_time: start + 2 * minute, window_ms: minute },
    );

    expect(result.groups[0].windows[0]).toMatchObject({
      effective_schema_count: 2,
      fingerprint_counts: { a: 1, b: 1 },
      shannon_entropy: 1,
      temporal_js_divergence: null,
      temporal_status: "insufficient-data",
    });
    expect(result.groups[0].windows[1].temporal_js_divergence).toBeCloseTo(
      0.311278,
      6,
    );
  });

  test("uses half-open boundaries and distinguishes empty from singleton populations", () => {
    const result = analyzeSchemaObservations(
      [observation(0, "a"), observation(2 * minute, "a")],
      { start_time: start, end_time: start + 3 * minute, window_ms: minute },
    );
    const windows = result.groups[0].windows;

    expect(windows.map((window) => window.observation_count)).toEqual([
      1, 0, 1,
    ]);
    expect(windows[0]).toMatchObject({
      effective_schema_count: 1,
      shannon_entropy: 0,
      status: "ok",
    });
    expect(windows[1]).toMatchObject({
      effective_schema_count: null,
      shannon_entropy: null,
      status: "no-data",
    });
    expect(windows[2].temporal_status).toBe("insufficient-data");
  });
});

describe("grouping and attribution", () => {
  test("groups by explicit condition and dimensions, with filters", () => {
    const result = analyzeSchemaObservations(
      [
        observation(0, "a", { run_id: "run-1", task_id: "task-1" }),
        observation(1, "b", {
          condition: "isolated",
          run_id: "run-2",
          task_id: "task-1",
        }),
        observation(2, "c", { condition: "baseline", task_id: "task-1" }),
        observation(3, "ignored", {
          collection: "ignored",
          condition: "baseline",
          task_id: "task-1",
        }),
      ],
      {
        filters: { collection: "records", task_id: "task-1" },
        group_by: ["collection", "condition"],
        window_ms: minute,
      },
    );

    expect(result.group_by).toEqual(["collection", "condition"]);
    expect(result.groups.map((group) => group.key.condition)).toEqual([
      "baseline",
      "isolated",
      "shared",
    ]);
    expect(result.condition_comparisons).toHaveLength(3);
    expect(result.condition_comparisons).toContainEqual({
      conditions: ["baseline", "isolated"],
      fingerprint_js_divergence: 1,
      key: { collection: "records" },
      observation_counts: [1, 1],
      status: "ok",
    });
  });

  test("treats undefined filter values as unconstrained", () => {
    const result = analyzeSchemaObservations(
      [observation(0, "a", { run_id: "run-1" })],
      {
        filters: { collection: "records", run_id: undefined },
        window_ms: minute,
      },
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].observation_count).toBe(1);
  });

  test("reports per-agent distributions, fields, adoption, and unknown attribution", () => {
    const result = analyzeSchemaObservations(
      [
        observation(0, "a", {
          agent_id: "alpha",
          field_paths: ["name", "name"],
        }),
        observation(1, "a", { agent_id: null, field_paths: ["name"] }),
        observation(2, "b", { agent_id: "alpha", field_paths: ["age"] }),
        observation(3, "a", { agent_id: "beta", field_paths: ["name"] }),
      ],
      { window_ms: minute },
    );
    const attribution = result.groups[0].attribution;

    expect(attribution).toMatchObject({
      attributed_observations: 3,
      divergence_status: "ok",
      unattributed_observations: 1,
    });
    expect(attribution.average_pairwise_js_divergence).toBeCloseTo(
      0.3112781244591328,
    );
    expect(attribution.agent_distributions).toEqual([
      {
        agent_id: "alpha",
        fingerprint_counts: { a: 1, b: 1 },
        fingerprint_frequencies: { a: 0.5, b: 0.5 },
        observation_count: 2,
      },
      {
        agent_id: "beta",
        fingerprint_counts: { a: 1 },
        fingerprint_frequencies: { a: 1 },
        observation_count: 1,
      },
    ]);
    expect(attribution.field_by_agent).toContainEqual({
      agent_id: "alpha",
      field_path: "name",
      frequency: 0.5,
      observation_count: 2,
      present_count: 1,
    });
    expect(attribution.fingerprint_adoption[0]).toEqual({
      fingerprint: "a",
      first_seen: "2026-01-01T00:00:00.000Z",
      first_seen_agent_id: "alpha",
      subsequent_agents: [
        { agent_id: "beta", first_seen: "2026-01-01T00:00:00.003Z" },
      ],
    });
  });

  test("does not fabricate an inter-agent zero when attribution is insufficient", () => {
    const result = analyzeSchemaObservations(
      [observation(0, "a"), observation(1, "a", { agent_id: "only-agent" })],
      { window_ms: minute },
    );

    expect(result.groups[0].attribution).toMatchObject({
      average_pairwise_js_divergence: null,
      divergence_status: "insufficient-data",
      unattributed_observations: 1,
    });
  });
});

describe("validation", () => {
  test("rejects invalid windows and timestamps", () => {
    expect(() => analyzeSchemaObservations([], { window_ms: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      analyzeSchemaObservations(
        [observation(0, "a", { timestamp: "not-a-date" })],
        {
          window_ms: minute,
        },
      ),
    ).toThrow(TypeError);
  });
});
