# Unbounded: 4-Hour Self-Organizing Agent Swarm Pilot

## Objective

Test whether a swarm of small, inexpensive language models can use a shared schemaless memory to self-organize around a software-engineering task, and whether that shared memory improves performance or coordination compared with an otherwise identical isolated-agent population.

We are **not** trying to prove a full research thesis in four hours. We are trying to answer:

1. Will small agents actually use shared memory when it is available?
2. Do they begin converging on useful shared structures without being given a schema?
3. Do they exhibit spontaneous behavioral specialization?
4. Does shared memory improve solve rate, reduce duplicated work, reduce token usage, or improve efficiency compared with isolated agents?
5. How does the small-model swarm compare economically with a single frontier model on the same task?

## Core Thesis

Give agents:

- the same objective;
- awareness that other agents exist;
- a shell;
- their own working copy of the task environment;
- access to a shared `unbounded` CLI;
- freedom to organize memory however they want.

Do **not** give them:

- roles;
- task queues;
- a workflow;
- a predefined schema;
- predefined document types;
- message-passing semantics;
- a planner/critic/researcher hierarchy;
- specialized multi-agent tool calls.

The central idea is:

> **Give agents a database, not a coordination framework.**

The swarm should be allowed to discover both how shared information should be represented and how work should be divided.

---

## Pilot Architecture

```text
                         benchmark task
                              |
                              v
                       swarm launcher
                              |
             +----------------+----------------+
             |                |                |
             v                v                v
          agent 1          agent 2         agent 20
             |                |                |
             v                v                v
        worktree 1       worktree 2       worktree 20
             |                |                |
             +----------------+----------------+
                              |
                              v
                        shared unbounded
                              |
                              v
                           MongoDB
```

Each agent receives its **own Git worktree or container**. Agents must not edit the same filesystem. Their only intentionally shared state is Unbounded.

This keeps the experiment focused on memory and coordination rather than filesystem race conditions.

---

## Runtime Choice

Use a very small existing terminal-agent harness rather than building an agent framework.

A good starting point is **mini-SWE-agent** because its interaction model is essentially:

```text
model
  |
  v
bash command
  |
  v
command output
  |
  v
model
```

The only meaningful addition is making the `unbounded` executable available in the agent's shell.

Do not build:

```text
assign_task()
publish_finding()
claim_job()
review_patch()
ask_agent()
```

Those would impose our own coordination architecture.

---

## Benchmark Choice

Use a small number of **SWE-bench Lite development instances** for the pilot.

Reasons:

- tasks have objective software-engineering outcomes;
- repositories and issue descriptions already exist;
- solutions can be tested automatically;
- the benchmark is established;
- no time needs to be spent inventing synthetic problems;
- contained bug-fix tasks are more appropriate for a short pilot than very difficult terminal-agent benchmarks.

For the first four hours:

> Run only **2–3 benchmark tasks**.

Do not attempt to run an entire benchmark suite. The goal is to detect a signal, not produce a leaderboard score.

---

# Experimental Conditions

For each benchmark problem, run three conditions.

## A. Shared-Memory Small-Model Swarm

```text
20 agents
same small model
same task
separate worktrees
one shared MongoDB database
```

Example:

```text
UNBOUNDED_DB=run_001_shared
```

All twenty agents see the same Unbounded state.

## B. Isolated Small-Model Population

Exactly the same setup, except the launcher assigns each agent a separate
MongoDB database. This provides logical isolation for the pilot. If agents
must not be able to select another database, give each one credentials scoped
to its assigned database.

```text
Agent 1 -> run_002_agent_01
Agent 2 -> run_002_agent_02
...
Agent 20 -> run_002_agent_20
```

Nothing else changes.

This is the most important control. It answers:

> Is shared memory actually contributing anything beyond running twenty independent samples?

## C. Frontier-Model Baseline

Run one strong frontier model using the same task environment and basic terminal-agent harness.

Track:

- task success;
- total tokens;
- wall-clock time;
- estimated dollar cost.

This gives the practical comparison:

```text
20 inexpensive agents
        vs
1 expensive frontier agent
```

---

## Optional Later Conditions

Do **not** add these unless the basic pilot works.

Possible later swarm-size experiments:

```text
1 agent
4 agents
8 agents
20 agents
40 agents
```

Possible later model-size sweeps:

```text
~1B
~3B
~7B
~14B
frontier reference
```

These are outside the four-hour pilot.

---

# Agent Prompt

Keep the prompt minimal.

Do not mention schema convergence, role formation, specialization, or optimal memory organization.

A reasonable starting prompt:

```text
You are one of 20 agents working toward the same objective.

19 other agents are also working on this task.

You each have your own working copy of the repository.

You share persistent memory through the `unbounded` command.

You may inspect and modify this shared memory however you think is useful.

Use your shell and the repository to make progress toward solving the issue.

Decide for yourself what work would most improve the group's chances of success.

You may change your strategy at any time.

The objective is:

<ISSUE TEXT>
```

That is intentionally vague about coordination. The agents should discover the rest.

---

# Unbounded CLI Surface

The CLI should be simple enough for small models while remaining structurally neutral.

Unbounded is a standalone MongoDB CLI that a user can put on any agent's
`$PATH`. It has no concept of experiments, runs, workspaces, swarms, or agent
identities. The caller supplies a MongoDB URI and database name. Collections
and documents remain ordinary MongoDB collections and documents.

The pilot launcher owns experiment concerns. It chooses a database for each
agent process, records the agent and run identifiers, and collects telemetry.
For the shared condition, the launcher gives every agent the same database
name. For the isolated condition, it gives each agent a different database
name.

The reusable CLI accepts the URI and database through flags or environment
variables such as `UNBOUNDED_MONGO_URI` and `UNBOUNDED_DB`. Database selection
is generic connection configuration, not a workspace abstraction.

Suggested v1:

```text
unbounded insert
unbounded find
unbounded get
unbounded update
unbounded delete

unbounded inspect
unbounded sample
unbounded indexes
```

Potentially:

```text
unbounded collections
unbounded create-collection
unbounded create-index
```

Avoid cognitive verbs such as:

```text
remember
recall
forget
publish-finding
create-task
claim-task
assign-role
```

Those imply an ontology.

---

## Example CLI Usage

Insert arbitrary data:

```bash
unbounded insert '{
  "observation": "Authentication failure appears during token refresh",
  "evidence": ["tests/auth/test_refresh.py::test_expired_token"]
}'
```

Search memory:

```bash
unbounded find '{"observation":{"$exists":true}}'
```

Create a collection if the agent decides one is useful:

```bash
unbounded create-collection findings
```

Insert into it:

```bash
unbounded insert findings '{
  "file": "src/auth/token.py",
  "finding": "refresh path does not preserve expiry correctly"
}'
```

The exact syntax can change. The important point is that Unbounded exposes storage primitives, not a coordination protocol.

---

# Schema Introspection

Agents should be able to inspect how memory is currently being used.

This helps small models understand local conventions without us telling them what those conventions should be.

For example:

```bash
unbounded inspect
```

could return:

```json
{
  "collections": {
    "default": {
      "documents": 1842,
      "common_fields": {
        "task": 0.61,
        "status": 0.58,
        "finding": 0.27
      },
      "common_shapes": [
        {
          "count": 913,
          "fields": {
            "task": "string",
            "status": "string"
          }
        },
        {
          "count": 421,
          "fields": {
            "finding": "string",
            "evidence": "array",
            "confidence": "number"
          }
        }
      ]
    }
  }
}
```

This should be **descriptive, not prescriptive**.

Good:

```text
These fields are common.
These shapes exist.
These values are common.
These indexes exist.
```

Bad:

```text
Recommended schema:
You should use:
Best field name:
Suggested role:
```

Unbounded should report facts about the memory state. The model decides what to do with those facts.

---

# What Agents Are Allowed to Discover

Agents may independently decide to invent:

- collections;
- indexes;
- task representations;
- finding representations;
- status fields;
- ownership fields;
- confidence fields;
- cross-references;
- priority conventions;
- agent identities;
- role descriptions;
- coordination structures.

They may also decide that none of these are useful.

That is part of the experiment.

---

# Behavioral Specialization

Do not assign:

```text
researcher
planner
critic
reviewer
executor
coordinator
```

All twenty agents begin with the same model and prompt.

Specialization should be allowed to emerge.

Possible emergent behavior:

```text
some agents investigate
some reproduce the bug
some inspect nearby code
some test hypotheses
some review patches
some consolidate existing findings
some stop duplicating work and search for neglected areas
```

The agent does not need to declare:

```text
role = verifier
```

Behavior matters more than declared identity.

---

# Worktree Strategy

Each agent receives an independent worktree.

Conceptually:

```bash
git worktree add /tmp/run-001/agent-01 <base-commit>
git worktree add /tmp/run-001/agent-02 <base-commit>
...
git worktree add /tmp/run-001/agent-20 <base-commit>
```

Each mini-agent runs from its assigned directory.

At the end:

```text
collect each agent's diff
evaluate each candidate patch
```

Do not require the agents to coordinate patch merging during the first pilot.

For the smoke test, define swarm success as:

> At least one candidate patch produced by the shared-memory population passes the benchmark evaluator.

Later experiments can test whether the swarm can cooperatively construct a single shared patch.

---

# Swarm Launcher

The launcher should be tiny.

Conceptually:

```python
agents = []

for agent_id in range(20):
    worktree = create_worktree(agent_id)

    env = {
        "AGENT_ID": str(agent_id),
        "UNBOUNDED_DB": f"{run_id}_shared",
    }

    agents.append(
        launch_agent(
            model=small_model,
            workspace=worktree,
            env=env,
            prompt=task_prompt,
        )
    )

wait_for_all(agents)
```

For the isolated condition:

```python
"UNBOUNDED_DB": f"{run_id}_agent_{agent_id}"
```

The launcher uses `AGENT_ID` for prompts and telemetry. The Unbounded
executable does not read it. Database assignment should be nearly the only
code difference between the shared and isolated conditions.

---

# Concurrency

Run the agents concurrently.

Twenty sequential agents would:

- take too long;
- expose later agents to a fundamentally different temporal environment;
- weaken the population interpretation.

A concurrent swarm better models multiple agents simultaneously responding to shared state.

---

# Stopping Conditions

Every agent should have hard limits.

For example:

```text
maximum model turns
maximum input tokens
maximum output tokens
maximum wall-clock time
maximum dollar spend
```

At minimum, enforce a global run budget so a malfunctioning swarm cannot produce unlimited inference calls.

Example:

```text
per-agent maximum:      fixed turn cap
per-run wall time:      ~10–15 minutes
global swarm budget:    fixed monetary cap
```

Do not optimize these parameters during the pilot. Pick reasonable values and keep them fixed across comparable runs.

---

# Evaluation

Use the benchmark's normal task evaluator.

For each agent:

1. collect its final repository diff;
2. evaluate the patch;
3. run the relevant tests;
4. mark pass/fail.

For each 20-agent population:

```text
population success = at least one passing candidate
```

Also record:

```text
number of passing candidates
best candidate
time first successful candidate appeared
```

If feasible, record whether successful agents consumed or built upon shared memory written by others.

---

# Telemetry

Do not build an elaborate telemetry platform.

Keep telemetry outside the Unbounded executable. The launcher already knows
the run and agent for each process. It can turn the timestamped agent command
transcript into operation records. If the harness cannot expose those records,
use a pilot-only wrapper script that appends JSONL before it invokes the
standalone executable.

## One stream, four record types

All telemetry is JSONL. Every record carries the same envelope, and `type`
discriminates the payload. A reader that does not recognize a `type` skips the
record and reports it as a diagnostic rather than failing.

Envelope, present on every record:

```text
type            model_call | unbounded_op | db_write | run_summary
event_id        uuid, unique per record, for duplicate suppression
timestamp       RFC 3339, UTC, millisecond precision
run_id
task_id         SWE-bench instance id, e.g. pytest-dev__pytest-8365
agent_id        zero-padded, agent_00 .. agent_19
condition       shared | isolated | baseline
```

`condition` is not optional. Shared-versus-isolated is the experiment, and every
analysis and dashboard filter groups by it. `task_id` is likewise required
everywhere, including database writes and run summaries, so a fingerprint can be
attributed to the problem that produced it.

Per type, in addition to the envelope:

```text
model_call      model, input_tokens, output_tokens, estimated_cost, step
unbounded_op    operation, collection, success, exit_code, duration_ms
db_write        operation, collection, document_id, schema_fingerprint?
run_summary     wall_clock_ms, resolved, patch_size_lines, f2p_passed, p2p_passed
```

## Why writes carry an id, not a document

The earlier draft put the whole written document in the telemetry record. Three
reasons not to:

- The dashboard reads documents from the MongoDB change stream, which is
  authoritative and already carries full content. JSONL is the replay and
  fixture path, not the primary source.
- Records are appended by concurrent writers. On Linux an `O_APPEND` write is
  atomic only up to `PIPE_BUF` (4096 bytes); above that, twenty agents can
  interleave and corrupt lines. Keeping records small keeps appends atomic.
- Agent-authored documents are model output. Replaying them into a browser is a
  content-injection surface, and the interface deliberately does not render
  document values by default.

`document_id` plus the change stream recovers everything a document field would
have provided.

## The schema fingerprint

None of the above blocks logging the *shape* of a write, and shape is what the
pilot is actually trying to observe. `schema_fingerprint` is the first 16 hex
characters of a sha256 over the document's sorted top-level key names, with `_id`
excluded. Key names only; values never, and nested structure is not descended.

It is fixed-length, so it cannot break `PIPE_BUF` atomicity, and it contains no
model-authored text, so it is safe to render. Both objections to logging document
content are therefore answered, and a `db_write` record stays under 300 bytes.

This is what makes schema convergence visible **in the stream**, in real time,
rather than only in a post-hoc pass over MongoDB. Sorting the keys means agents
that chose the same fields in a different order collide to one fingerprint, which
is the definition of convergence worth counting. The distribution of fingerprints
per collection tightening over a run is the signal; comparing that tightening
between the shared and isolated arms is the result.

Field-level detail beyond the fingerprint — which fields, what they contain, how
wording drifted — still comes from reading MongoDB directly afterwards. The
fingerprint is the live indicator, not a replacement for that pass.

It remains optional: unparseable or non-object documents omit the field rather
than losing the record, and readers must treat its absence as normal.

## Correlating the two sources

The dashboard sees the same write twice: once from the change stream, once from
the JSONL. `event_id` deduplicates JSONL against itself on replay; `(collection,
document_id)` correlates a JSONL record to its change-stream counterpart. When
both exist, the change stream wins on content and the JSONL supplies the
attribution the change stream cannot know — `agent_id`, `condition`, `task_id`.

Unattributed change-stream activity is expected and must render as unknown
attribution rather than being dropped or counted as a zero.

## Who writes what

The Unbounded executable writes no telemetry. It has no run, agent, or
experiment concepts, and that stays true.

- `model_call` and `run_summary` come from the launcher, which owns the
  mini-swe-agent loop and reads token and cost counters off the model object.
- `unbounded_op` and `db_write` come from the pilot wrapper that occupies
  `unbounded` on each agent's `PATH`. It timestamps, appends a record, then
  `exec`s the real executable.

The wrapper runs inside the per-agent SWE-bench container, so the container
needs a writable mount for telemetry alongside the read-only mount of the
binary. Each agent appends to its own file, `telemetry/<run_id>/<agent_id>.jsonl`.
Per-agent files remove cross-process interleaving entirely and let the dashboard
accept one or more inputs, which it already does.

---

# Schema Fingerprinting

After the run, convert each stored document into a structural fingerprint.

Example:

```json
{
  "task": "fix auth",
  "skills": ["typescript", "security"],
  "priority": 4
}
```

becomes:

```text
priority:number
skills:array<string>
task:string
```

Ignore:

- values;
- object field ordering.

Retain:

- field path;
- field type;
- nesting structure.

Nested example:

```json
{
  "job": {
    "description": "...",
    "required": ["security"]
  }
}
```

becomes:

```text
job:object
job.description:string
job.required:array<string>
```

This observer is external to the swarm.

---

# Pilot Schema Metrics

For four hours, keep the analysis narrow.

## 1. Effective Number of Schemas

Compute fingerprint frequencies in successive windows.

Use Shannon entropy:

\[
H_t = -\sum_s p_t(s)\log p_t(s)
\]

Then:

\[
N_{\mathrm{effective}} = e^{H_t}
\]

Question:

> Does structural diversity decrease as the shared swarm runs?

## 2. Inter-Agent Divergence

For each agent:

\[
P_i(schema)
\]

Measure pairwise Jensen-Shannon divergence:

\[
JSD(P_i,P_j)
\]

Then average across agent pairs.

Question:

> Do independently operating agents begin using increasingly similar document structures?

This is the strongest basic convergence signal.

## 3. Temporal Stability

Compare the overall schema distribution between adjacent time windows:

\[
JSD(P_t,P_{t+\Delta})
\]

Question:

> Does the representation become more stable later in the run?

---

# Shared vs Isolated Comparison

The critical comparison is:

```text
shared-memory population
        vs
isolated-memory population
```

If both converge equally strongly, the result may simply reflect model priors.

If the shared condition converges substantially more:

```text
shared final JSD << isolated final JSD
```

that is evidence that interaction through shared state is influencing representation.

---

# Detecting Behavioral Specialization

Do not spend the four-hour pilot building a sophisticated behavior classifier.

Start manually.

Inspect:

- shell commands;
- files examined;
- tests run;
- Unbounded writes;
- patches;
- agent reasoning summaries if available.

Look for patterns such as:

```text
agent 3 repeatedly reproduces failures
agent 7 reads others' findings and validates them
agent 11 consolidates state
agent 14 focuses on one subsystem
```

If specialization looks real, automate classification later.

For the pilot, qualitative observation is sufficient.

---

# Core Performance Metrics

| Metric | Why |
|---|---|
| Task success | Fundamental outcome |
| Passing candidates | Population reliability |
| Time to first success | Parallelism value |
| Total input tokens | Retrieval/reasoning cost |
| Total output tokens | Generation cost |
| Total tokens | Overall inference usage |
| Cost per run | Practical spend |
| Cost per successful task | Primary economic metric |
| Wall-clock duration | User-facing latency |
| Unbounded reads | Memory usage |
| Unbounded writes | Coordination activity |
| Duplicate investigations | Coordination quality |
| Schema divergence | Representation convergence |

---

# Economic Comparison

The key practical metric should be:

\[
	ext{cost per successful task}
\]

not raw token count.

Example:

```text
Small swarm

success:     90%
cost/run:    $0.08

cost/success:
$0.08 / 0.90 = $0.089
```

versus:

```text
Frontier model

success:     95%
cost/run:    $0.60

cost/success:
$0.60 / 0.95 = $0.632
```

The frontier model may use fewer tokens while still being much more expensive.

Both token efficiency and economic efficiency should be reported.

---

# What Would Count as an Interesting Result?

The pilot does **not** need to prove statistical significance.

Any of the following would justify further work.

## A — Memory Usage

Agents voluntarily use Unbounded extensively without being told exactly how.

## B — Structural Convergence

Shared agents begin adopting common field names, document structures, collections, or indexes.

## C — Shared Beats Isolated

The shared-memory population solves tasks that the isolated population does not, or solves them with meaningfully less duplicated work.

## D — Emergent Specialization

Agents begin performing observably different functions without assigned roles.

## E — Cost Competitiveness

The small swarm approaches the frontier model's success while remaining substantially cheaper.

## F — Interesting Failure

Twenty agents create enough coordination noise that shared memory performs worse than isolation.

That is still useful. It identifies where self-organization breaks.

---

# Four-Hour Schedule

Keep this strict.

## Hour 1 — Get One Agent Working

Goal:

```text
mini-agent
+
benchmark task
+
shell
+
unbounded command
```

Tasks:

- choose one SWE-bench Lite development task;
- run one small-model agent against it;
- confirm repository/test environment works;
- confirm Unbounded is available in `$PATH`;
- confirm Unbounded can read/write state;
- record model token usage.

Do not proceed until one complete agent loop works end-to-end.

## Hour 2 — Launch the Shared Population

Build the thinnest possible swarm launcher.

Tasks:

- generate independent worktrees;
- launch several agents concurrently;
- scale to 20 if infrastructure allows;
- give them the same MongoDB database name;
- log all Unbounded operations;
- collect final diffs.

Do not build dashboards or advanced analysis.

## Hour 3 — Run Control + Frontier Baseline

Run:

```text
shared-memory population
isolated-memory population
single frontier agent
```

on the same benchmark task.

If this finishes quickly, repeat on a second task.

Only move to a third task if everything is already stable.

## Hour 4 — Evaluate and Inspect

Run benchmark tests against all candidate patches.

Calculate:

```text
success/failure
total tokens
estimated cost
time
Unbounded reads/writes
```

Perform basic structural fingerprinting.

Inspect:

```text
dominant shapes
common fields
schema adoption over time
shared vs isolated differences
obvious behavioral specialization
```

Produce a short result summary.

---

# Scope Guardrails

For the four-hour pilot, **do not build**:

- full product UI;
- authentication;
- billing;
- production multi-tenancy;
- semantic memory retrieval;
- vector databases;
- embeddings;
- automatic role detection;
- sophisticated graph analysis;
- learned model routing;
- dynamic swarm sizing;
- workflow orchestration;
- task assignment;
- patch-merging protocols;
- advanced memory cleanup;
- automatic schema migration;
- formal research statistics;
- generalized benchmark support.

Anything on that list can wait.

---

# Minimum Viable Unbounded

The absolute minimum implementation may be only:

```text
unbounded insert
unbounded find
unbounded inspect
```

Potentially add:

```text
unbounded update
```

if needed.

If MongoDB is directly available, Unbounded can be a small standalone executable
that:

1. reads the caller's MongoDB URI and database name;
2. authenticates;
3. executes the requested operation;
4. returns JSON.

The pilot launcher handles database assignment and usage logging. Unbounded
does not inject workspace fields or experiment metadata into user documents.

Do not overbuild it before seeing whether agents actually use it.

---

# Minimal Repository Layout

```text
unbounded-pilot/
├── src/
│   └── cli.ts
├── dist/
│   └── unbounded
├── package.json
├── bun.lock
├── runner/
│   ├── swarm.py
│   └── worktrees.py
├── analysis/
│   └── fingerprints.py
├── prompts/
│   └── swarm.txt
├── runs/
│   └── .gitkeep
└── README.md
```

Nothing more is necessary initially.

---

# Example Run Metadata

Each experiment should get a run ID.

```json
{
  "run_id": "swe-001-shared",
  "task": "benchmark-instance-id",
  "condition": "shared",
  "model": "small-model-name",
  "agents": 20,
  "started_at": "...",
  "budget_usd": 0.50
}
```

This makes later comparison straightforward.

---

# First Analysis Table

At the end of the pilot, produce one table like:

| Task | Condition | Agents | Success | Passing Patches | Tokens | Cost | Time | Mem Reads | Mem Writes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Task 1 | Shared | 20 | Yes/No | N | N | $N | N | N | N |
| Task 1 | Isolated | 20 | Yes/No | N | N | $N | N | N | N |
| Task 1 | Frontier | 1 | Yes/No | N | N | $N | N | — | — |

Then add:

```text
Shared:
initial pairwise schema JSD: ...
final pairwise schema JSD: ...

Isolated:
initial pairwise schema JSD: ...
final pairwise schema JSD: ...
```

That is enough to decide whether to continue.

---

# Decision Criteria After Four Hours

## Continue aggressively if:

- agents spontaneously use memory;
- repeated conventions appear;
- shared agents reuse other agents' information;
- shared condition beats isolated on at least one meaningful measure;
- costs look favorable;
- emergent specialization is visible.

## Continue cautiously if:

- agents use memory but mostly dump unstructured text;
- convergence exists but task performance is unchanged;
- shared memory creates moderate overhead;
- some models handle the CLI unreliably.

## Reconsider the approach if:

- agents largely ignore memory;
- shared state creates only noise;
- isolated populations consistently outperform shared ones;
- small models cannot reliably operate the CLI;
- memory overhead overwhelms inference savings.

Even negative results are useful because they identify the capability threshold or missing affordance.

---

# What Comes After the Pilot

Only if the pilot shows a signal:

1. run more independent tasks;
2. repeat each condition multiple times;
3. test multiple small-model sizes;
4. test 4/8/20-agent populations;
5. automate schema-convergence analysis;
6. automate behavioral-specialization analysis;
7. test cost-matched and token-matched conditions;
8. evaluate whether Unbounded introspection improves small-model performance;
9. test whether agents create useful indexes or collections on their own;
10. test more general terminal benchmarks.

---

# Long-Term Research Question

> **Can a population of inexpensive language models self-organize a shared schemaless memory and division of labor into an efficient coordination system, and can that emergent organization close the capability gap with frontier models at lower inference cost?**

But the four-hour pilot asks something much smaller:

> **If we give twenty small agents the same software-engineering objective and a shared schemaless memory, do they actually organize around it in a way that appears useful?**

That is the only question the first experiment needs to answer.
