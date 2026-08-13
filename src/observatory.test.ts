import { describe, expect, test } from "bun:test";

import {
  type ObservatoryFixture,
  observatoryFixture,
  renderSchemaObservatory,
} from "./observatory.ts";

describe("schema observatory browser interface", () => {
  test("renders deterministic, self-contained fixture HTML", () => {
    const first = renderSchemaObservatory(observatoryFixture);
    const second = renderSchemaObservatory(observatoryFixture);

    expect(first).toBe(second);
    expect(first).toStartWith("<!doctype html>");
    expect(first).not.toContain("https://");
    expect(first).not.toContain("http://");
    expect(first).toContain('id="observatory-data"');
    expect(first).toContain("project-core");
    expect(first).toContain("unknown attribution");
    expect(first).toContain("insufficient data");
  });

  test("provides accessible views, filters, and non-color labels", () => {
    const html = renderSchemaObservatory();

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-controls="panel-activity"');
    expect(html).toContain('id="collection-filter"');
    expect(html).toContain('id="run-filter"');
    expect(html).toContain("Live schema activity");
    expect(html).toContain("Fingerprint clusters");
    expect(html).toContain("Schema-adoption timeline");
    expect(html).toContain("Field-by-agent frequencies");
    expect(html).toContain("Inter-agent divergence");
    expect(html).toContain('event.key === "ArrowRight"');
  });

  test("colors fingerprint clusters by contributing agents", () => {
    const html = renderSchemaObservatory();

    expect(html).toContain("--agent-color:' + agentColor(row.agents) +");
    expect(html).toContain(
      "const agentKey = (agents) => agents.slice().sort()",
    );
    expect(html).toContain("agentKeys.indexOf(agentKey(agents))");
    expect(html).not.toContain("colors[index % colors.length]");
  });

  test("rebuilds filter options from every live snapshot without losing a selection", () => {
    const html = renderSchemaObservatory();

    expect(html).toContain(
      "replaceSnapshot(snapshot) { Object.assign(data, snapshot); syncFilters(); render(); }",
    );
    expect(html).toContain(
      "data.activity.push(event); syncFilters(); renderActivity();",
    );
    expect(html).toContain(
      'select.value = values.includes(selected) ? selected : "";',
    );
    expect(html).toContain('typeof EventSource === "function"');
  });

  test("escapes fixture payloads and never requires document values", () => {
    const hostileFixture: ObservatoryFixture = {
      activity: [],
      adoption: [],
      field_agent: [],
      fingerprints: [
        {
          agents: [],
          collection: "</script><script>alert(1)</script>",
          condition: "shared",
          count: 1,
          fields: ["name:string"],
          fingerprint: "safe-shape",
          run_id: "run-1",
          task_id: "task-1",
        },
      ],
      generated_at: "2026-08-13T20:00:00.000Z",
      trends: [],
    };

    const html = renderSchemaObservatory(hostileFixture);
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script>");
    expect(JSON.stringify(observatoryFixture)).not.toContain("document_value");
  });
});
