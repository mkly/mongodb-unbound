export interface ObservatoryActivity {
  action: "delete" | "insert" | "replace" | "update";
  agents: string[];
  collection: string;
  fingerprint: string;
  run_id: string;
  timestamp: string;
}

export interface ObservatoryFingerprint {
  agents: string[];
  collection: string;
  count: number;
  fields: string[];
  fingerprint: string;
  run_id: string;
}

export interface ObservatoryAdoption {
  agent: string | null;
  collection: string;
  fingerprint: string;
  first_seen: string;
  run_id: string;
}

export interface ObservatoryFieldAgent {
  agent: string;
  collection: string;
  field: string;
  frequency: number | null;
  run_id: string;
}

export interface ObservatoryTrend {
  collection: string;
  effective_schemas: number | null;
  inter_agent_divergence: number | null;
  run_id: string;
  timestamp: string;
  temporal_stability: number | null;
}

/**
 * Value-free data contract consumed by the embedded observatory page.
 * `null` means unknown or insufficient data and is never rendered as zero.
 */
export interface ObservatoryFixture {
  activity: ObservatoryActivity[];
  adoption: ObservatoryAdoption[];
  field_agent: ObservatoryFieldAgent[];
  fingerprints: ObservatoryFingerprint[];
  generated_at: string;
  trends: ObservatoryTrend[];
}

export const observatoryFixture: ObservatoryFixture = {
  generated_at: "2026-08-13T20:00:00.000Z",
  activity: [
    {
      action: "insert",
      agents: ["agent-ada"],
      collection: "projects",
      fingerprint: "project-core",
      run_id: "shared-01",
      timestamp: "2026-08-13T19:55:00.000Z",
    },
    {
      action: "update",
      agents: ["agent-babbage"],
      collection: "projects",
      fingerprint: "project-status",
      run_id: "shared-01",
      timestamp: "2026-08-13T19:56:00.000Z",
    },
    {
      action: "replace",
      agents: [],
      collection: "notes",
      fingerprint: "note-basic",
      run_id: "shared-01",
      timestamp: "2026-08-13T19:57:00.000Z",
    },
  ],
  fingerprints: [
    {
      agents: ["agent-ada", "agent-babbage"],
      collection: "projects",
      count: 18,
      fields: ["name:string", "status:string", "tags:array<string>"],
      fingerprint: "project-core",
      run_id: "shared-01",
    },
    {
      agents: ["agent-babbage"],
      collection: "projects",
      count: 7,
      fields: ["name:string", "status:string", "owner:string"],
      fingerprint: "project-status",
      run_id: "shared-01",
    },
    {
      agents: [],
      collection: "notes",
      count: 4,
      fields: ["title:string", "body:string"],
      fingerprint: "note-basic",
      run_id: "shared-01",
    },
  ],
  adoption: [
    {
      agent: "agent-ada",
      collection: "projects",
      fingerprint: "project-core",
      first_seen: "2026-08-13T19:55:00.000Z",
      run_id: "shared-01",
    },
    {
      agent: "agent-babbage",
      collection: "projects",
      fingerprint: "project-core",
      first_seen: "2026-08-13T19:56:30.000Z",
      run_id: "shared-01",
    },
    {
      agent: null,
      collection: "notes",
      fingerprint: "note-basic",
      first_seen: "2026-08-13T19:57:00.000Z",
      run_id: "shared-01",
    },
  ],
  field_agent: [
    {
      agent: "agent-ada",
      collection: "projects",
      field: "name",
      frequency: 1,
      run_id: "shared-01",
    },
    {
      agent: "agent-babbage",
      collection: "projects",
      field: "name",
      frequency: 1,
      run_id: "shared-01",
    },
    {
      agent: "agent-ada",
      collection: "projects",
      field: "owner",
      frequency: null,
      run_id: "shared-01",
    },
    {
      agent: "agent-babbage",
      collection: "projects",
      field: "owner",
      frequency: 0.39,
      run_id: "shared-01",
    },
  ],
  trends: [
    {
      collection: "projects",
      effective_schemas: 1.8,
      inter_agent_divergence: 0.24,
      run_id: "shared-01",
      temporal_stability: 0.82,
      timestamp: "2026-08-13T19:55:00.000Z",
    },
    {
      collection: "projects",
      effective_schemas: 1.5,
      inter_agent_divergence: 0.16,
      run_id: "shared-01",
      temporal_stability: 0.91,
      timestamp: "2026-08-13T19:57:00.000Z",
    },
    {
      collection: "notes",
      effective_schemas: 1,
      inter_agent_divergence: null,
      run_id: "shared-01",
      temporal_stability: null,
      timestamp: "2026-08-13T19:57:00.000Z",
    },
  ],
};

function serializeForHtml(data: ObservatoryFixture): string {
  return JSON.stringify(data).replaceAll("<", "\\u003c");
}

export function renderSchemaObservatory(
  fixture: ObservatoryFixture = observatoryFixture,
): string {
  const data = serializeForHtml(fixture);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Schema Observatory</title>
  <style>
    :root { color-scheme: dark; --ink:#f4f3ed; --muted:#aaaeb6; --panel:#151921; --line:#303642; --accent:#ffd166; --cyan:#76d7c4; --pink:#ef7c8e; --blue:#77a8ff; }
    * { box-sizing:border-box; }
    body { margin:0; background:#0d1016; color:var(--ink); font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
    header, main { width:min(1180px,calc(100% - 32px)); margin:auto; }
    header { padding:32px 0 18px; display:flex; gap:24px; align-items:end; justify-content:space-between; }
    h1,h2,p { margin:0; } h1 { font-size:clamp(24px,4vw,42px); letter-spacing:-.05em; } h2 { font-size:18px; }
    .eyebrow,.muted { color:var(--muted); } .eyebrow { letter-spacing:.12em; text-transform:uppercase; font-size:12px; }
    .filters { display:flex; flex-wrap:wrap; gap:12px; } label { color:var(--muted); font-size:12px; }
    select { display:block; margin-top:4px; min-width:170px; padding:8px 28px 8px 10px; color:var(--ink); background:var(--panel); border:1px solid var(--line); border-radius:4px; }
    nav { display:flex; gap:4px; border-bottom:1px solid var(--line); overflow:auto; }
    nav button { border:0; border-bottom:3px solid transparent; padding:12px 16px; color:var(--muted); background:transparent; font:inherit; white-space:nowrap; cursor:pointer; }
    nav button[aria-selected="true"] { color:var(--ink); border-color:var(--accent); }
    button:focus-visible,select:focus-visible { outline:3px solid var(--blue); outline-offset:2px; }
    section[role="tabpanel"] { padding:24px 0 56px; } [hidden] { display:none!important; }
    .grid { display:grid; grid-template-columns:repeat(12,1fr); gap:14px; margin-top:16px; }
    .card { grid-column:span 6; min-width:0; padding:18px; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .wide { grid-column:1/-1; }
    .stream { max-height:390px; overflow:auto; } .event { display:grid; grid-template-columns:150px 90px 1fr; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); }
    .badge { display:inline-block; padding:2px 7px; border:1px solid currentColor; border-radius:999px; font-size:12px; }
    .insert { color:var(--cyan); } .update { color:var(--accent); } .replace { color:var(--blue); } .delete { color:var(--pink); }
    .clusters { display:flex; gap:14px; flex-wrap:wrap; align-items:center; min-height:250px; }
    .cluster { display:grid; place-content:center; text-align:center; aspect-ratio:1; width:var(--size); max-width:210px; border:2px solid var(--agent-color); border-radius:50%; background:color-mix(in srgb,var(--agent-color) 13%,transparent); }
    .cluster strong { font-size:20px; } .cluster small { color:var(--muted); }
    table { width:100%; border-collapse:collapse; margin-top:14px; } th,td { padding:9px; text-align:left; border-bottom:1px solid var(--line); } th { color:var(--muted); font-size:12px; }
    .heat { background:color-mix(in srgb,var(--cyan) calc(var(--heat) * 80%),transparent); }
    .trend-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-top:14px; }
    .metric { padding:16px; border:1px solid var(--line); border-radius:6px; } .metric strong { display:block; margin-top:8px; font-size:28px; }
    .empty { padding:32px 0; color:var(--muted); text-align:center; }
    @media (max-width:760px) { header { align-items:start; flex-direction:column; } .card { grid-column:1/-1; } .event { grid-template-columns:1fr; gap:3px; } .trend-grid { grid-template-columns:1fr; } }
    @media (prefers-reduced-motion:no-preference) { .cluster { transition:width .2s; } }
  </style>
</head>
<body>
  <header>
    <div><p class="eyebrow">Unbounded / read-only</p><h1>Schema Observatory</h1><p class="muted">Structure, convergence, and adoption — never document values.</p></div>
    <div class="filters" aria-label="Data filters">
      <label>Collection<select id="collection-filter"><option value="">All collections</option></select></label>
      <label>Run<select id="run-filter"><option value="">All runs</option></select></label>
    </div>
  </header>
  <main>
    <nav aria-label="Observatory views" role="tablist">
      <button id="tab-activity" role="tab" aria-controls="panel-activity" aria-selected="true">Activity</button>
      <button id="tab-adoption" role="tab" aria-controls="panel-adoption" aria-selected="false" tabindex="-1">Adoption</button>
      <button id="tab-fields" role="tab" aria-controls="panel-fields" aria-selected="false" tabindex="-1">Field × agent</button>
      <button id="tab-trends" role="tab" aria-controls="panel-trends" aria-selected="false" tabindex="-1">Trends</button>
    </nav>
    <section id="panel-activity" role="tabpanel" aria-labelledby="tab-activity">
      <h2>Live schema activity</h2><p class="muted">Newest structural observations first.</p>
      <div class="grid"><div class="card stream" id="activity"></div><div class="card"><h2>Fingerprint clusters</h2><div class="clusters" id="clusters"></div></div></div>
    </section>
    <section id="panel-adoption" role="tabpanel" aria-labelledby="tab-adoption" hidden><h2>Schema-adoption timeline</h2><div id="adoption"></div></section>
    <section id="panel-fields" role="tabpanel" aria-labelledby="tab-fields" hidden><h2>Field-by-agent frequencies</h2><div id="field-agent"></div></section>
    <section id="panel-trends" role="tabpanel" aria-labelledby="tab-trends" hidden><h2>Convergence trends</h2><div id="trends"></div></section>
  </main>
  <script id="observatory-data" type="application/json">${data}</script>
  <script>
    (() => {
      const data = JSON.parse(document.getElementById("observatory-data").textContent);
      const collectionFilter = document.getElementById("collection-filter");
      const runFilter = document.getElementById("run-filter");
      const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","'":"&#39;"})[char]);
      const filtered = (rows) => rows.filter((row) => (!collectionFilter.value || row.collection === collectionFilter.value) && (!runFilter.value || row.run_id === runFilter.value));
      const unknown = (value, label = "unknown") => value === null || value === undefined ? '<span class="muted">' + label + '</span>' : escapeHtml(value);
      const agentLabel = (agents) => agents.length ? agents.join(", ") : "unknown attribution";
      const agentKey = (agents) => agents.slice().sort().join(", ");
      const agentColors = ["var(--cyan)", "var(--accent)", "var(--pink)", "var(--blue)"];
      const agentKeys = [...new Set(data.fingerprints.map((row) => agentKey(row.agents)))].filter(Boolean).sort();
      const agentColor = (agents) => { const index = agentKeys.indexOf(agentKey(agents)); return index === -1 ? "var(--muted)" : agentColors[index % agentColors.length]; };

      const option = (value) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>';
      const collections = [...new Set([...data.activity, ...data.fingerprints].map((row) => row.collection))].sort();
      const runs = [...new Set([...data.activity, ...data.fingerprints].map((row) => row.run_id))].sort();
      collectionFilter.insertAdjacentHTML("beforeend", collections.map(option).join(""));
      runFilter.insertAdjacentHTML("beforeend", runs.map(option).join(""));

      function renderActivity() {
        const rows = filtered(data.activity).slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        document.getElementById("activity").innerHTML = rows.length ? rows.map((row) => '<article class="event"><time datetime="' + escapeHtml(row.timestamp) + '">' + escapeHtml(new Date(row.timestamp).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})) + '</time><span><span class="badge ' + escapeHtml(row.action) + '">' + escapeHtml(row.action) + '</span></span><div><strong>' + escapeHtml(row.collection) + '</strong> / ' + escapeHtml(row.fingerprint) + '<br><small class="muted">' + escapeHtml(agentLabel(row.agents)) + ' · ' + escapeHtml(row.run_id) + '</small></div></article>').join("") : '<p class="empty">No activity for these filters.</p>';
      }

      function renderClusters() {
        const rows = filtered(data.fingerprints).slice().sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint));
        const maximum = Math.max(1, ...rows.map((row) => row.count));
        document.getElementById("clusters").innerHTML = rows.length ? rows.map((row) => '<article class="cluster" tabindex="0" style="--size:' + (96 + Math.round(100 * Math.sqrt(row.count / maximum))) + 'px;--agent-color:' + agentColor(row.agents) + '" aria-label="' + escapeHtml(row.fingerprint + ", " + row.count + " observations, " + agentLabel(row.agents)) + '"><strong>' + escapeHtml(row.count) + '</strong><span>' + escapeHtml(row.fingerprint) + '</span><small>' + escapeHtml(agentLabel(row.agents)) + '</small></article>').join("") : '<p class="empty">No fingerprints for these filters.</p>';
      }

      function renderAdoption() {
        const rows = filtered(data.adoption).slice().sort((a, b) => a.first_seen.localeCompare(b.first_seen) || a.fingerprint.localeCompare(b.fingerprint));
        document.getElementById("adoption").innerHTML = rows.length ? '<table><thead><tr><th>First seen</th><th>Fingerprint</th><th>Agent</th><th>Collection</th></tr></thead><tbody>' + rows.map((row) => '<tr><td><time datetime="' + escapeHtml(row.first_seen) + '">' + escapeHtml(new Date(row.first_seen).toLocaleString()) + '</time></td><td>' + escapeHtml(row.fingerprint) + '</td><td>' + unknown(row.agent, "unknown attribution") + '</td><td>' + escapeHtml(row.collection) + '</td></tr>').join("") + '</tbody></table>' : '<p class="empty">Insufficient adoption data for these filters.</p>';
      }

      function renderFieldAgent() {
        const rows = filtered(data.field_agent);
        const agents = [...new Set(rows.map((row) => row.agent))].sort();
        const fields = [...new Set(rows.map((row) => row.field))].sort();
        const lookup = new Map(rows.map((row) => [row.field + "\\u0000" + row.agent, row.frequency]));
        document.getElementById("field-agent").innerHTML = rows.length ? '<table><thead><tr><th>Field</th>' + agents.map((agent) => '<th>' + escapeHtml(agent) + '</th>').join("") + '</tr></thead><tbody>' + fields.map((field) => '<tr><th>' + escapeHtml(field) + '</th>' + agents.map((agent) => { const value = lookup.get(field + "\\u0000" + agent); return value === null || value === undefined ? '<td class="muted">unknown</td>' : '<td class="heat" style="--heat:' + value + '">' + Math.round(value * 100) + '%</td>'; }).join("") + '</tr>').join("") + '</tbody></table>' : '<p class="empty">Insufficient field data for these filters.</p>';
      }

      function renderTrends() {
        const rows = filtered(data.trends).slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        if (!rows.length) { document.getElementById("trends").innerHTML = '<p class="empty">Insufficient trend data for these filters.</p>'; return; }
        const latest = rows[rows.length - 1];
        const metric = (label, value) => '<div class="metric"><span class="muted">' + label + '</span><strong>' + unknown(value, "insufficient data") + '</strong></div>';
        document.getElementById("trends").innerHTML = '<div class="trend-grid">' + metric("Effective schemas", latest.effective_schemas) + metric("Inter-agent divergence", latest.inter_agent_divergence) + metric("Temporal stability", latest.temporal_stability) + '</div><table><thead><tr><th>Window</th><th>Collection</th><th>Effective schemas</th><th>Inter-agent divergence</th><th>Temporal stability</th></tr></thead><tbody>' + rows.map((row) => '<tr><td>' + escapeHtml(new Date(row.timestamp).toLocaleString()) + '</td><td>' + escapeHtml(row.collection) + '</td><td>' + unknown(row.effective_schemas, "insufficient") + '</td><td>' + unknown(row.inter_agent_divergence, "insufficient") + '</td><td>' + unknown(row.temporal_stability, "insufficient") + '</td></tr>').join("") + '</tbody></table>';
      }

      function render() { renderActivity(); renderClusters(); renderAdoption(); renderFieldAgent(); renderTrends(); }
      collectionFilter.addEventListener("change", render);
      runFilter.addEventListener("change", render);

      const tabs = [...document.querySelectorAll('[role="tab"]')];
      function selectTab(tab) { for (const item of tabs) { const selected = item === tab; item.setAttribute("aria-selected", String(selected)); item.tabIndex = selected ? 0 : -1; document.getElementById(item.getAttribute("aria-controls")).hidden = !selected; } tab.focus(); }
      tabs.forEach((tab, index) => { tab.addEventListener("click", () => selectTab(tab)); tab.addEventListener("keydown", (event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; selectTab(tabs[next]); }); });

      window.unboundedObservatory = { pushEvent(event) { data.activity.push(event); renderActivity(); } };
      render();
    })();
  </script>
</body>
</html>`;
}
