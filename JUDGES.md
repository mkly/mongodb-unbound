# Judge guide

**Unbounded** gives coding agents a MongoDB-backed shared memory with no schema,
no prescribed fields, and no collection to name. The claim under test: agents
that share that store coordinate better than agents that don't — and the
*schema they invent* is observable evidence of the coordination.

This is not agents appending markdown to a scratchpad. Every write is a
queryable document. Every read is a real query. The fields are the agents' own.

---

## 1. One command

Requires [Bun](https://bun.sh) 1.3+. No database, no API key, no network.

```sh
bun install --frozen-lockfile && bun test && bun run build
```

Expect **67 passing tests** and a native `./dist/unbounded` executable. This
compiles for your machine; `bun run build:linux` produces the binary that gets
mounted into agent containers.

The tests are the honest part of the demo: they cover the schema fingerprint
algorithm, the Extended JSON round-trip, the activity correlation that joins
MongoDB change-stream events to agent telemetry, and the read/write accounting.

## 2. Drive the store yourself

With a MongoDB URI (Atlas or local):

```sh
export UNBOUNDED_MONGO_URI='mongodb+srv://…'
export UNBOUNDED_DB=judge_demo

./dist/unbounded insert '{"issue":"pytest tmpdir","status":"open","confidence":0.6}'
./dist/unbounded find '{"status":"open"}'
./dist/unbounded inspect
```

`inspect` is the point. It reports the fields actually present, their BSON
types, and the distinct document *shapes* — each identified by a 16-hex
fingerprint. That fingerprint is the only join key in the system: the agent
telemetry stream and a post-hoc pass over MongoDB cluster documents by the same
value, so "these two agents converged on the same shape" is a fact you can
verify, not a claim we assert.

There is deliberately no way to name a collection. Everything lands in one.
See "Why one collection" below — the reason is a result, not a simplification.

## 3. The three prompts

### "Run 5–20 agents against the same bug."

```sh
python runner/swarm.py --run-id demo --arm A --agents 8 \
  --concurrency 6 --step-limit 70 --wall-time-limit 600 --budget-usd 12
```

Each agent gets its own SWE-bench Docker container and solves the same instance
independently. Arm A points all of them at one shared database.

*Prerequisites are real:* Docker, the SWE-bench images, a MongoDB URI, and an
Anthropic key. If you only have Bun, sections 1 and 2 plus the live observatory
in section 4 are the parts you can run yourself.

### "Compare shared MongoDB vs. isolated agents."

Same command, `--arm B`. The only difference is the database each agent is
handed:

| Arm | Database | Prompt |
|---|---|---|
| A — shared | `<run_id>_shared`, one for all agents | identical |
| B — isolated | `<run_id>_<agent_id>`, one per agent | identical |

The prompts are byte-identical by construction — both arms use the same
`MEMORY_PROMPT` constant, which is why it lives in exactly one place in
`runner/prompts.py`. Nothing but connectivity distinguishes the arms. If shared
memory does nothing, the arms come out the same.

### "Inspect the resulting collections and see which schema fields emerged."

```sh
UNBOUNDED_DB=demo_shared ./dist/unbounded inspect
```

or open the observatory (below) and read the **Schema** tab, which clusters
every document written during the run by fingerprint and shows which agents
contributed to each cluster.

## 4. The observatory

```sh
./dist/unbounded --db <run>_shared serve --host 0.0.0.0 --port 3000 \
  --telemetry telemetry/<run>/agent_00.jsonl   # repeatable, one per agent
```

A read-only page. It is `GET`-only by construction — a `POST` returns 405 — and
it streams live over SSE as agents write.

Five tabs:

- **Activity** — a timeline of every store operation, attributed to the agent
  that made it. Each row is either a MongoDB change-stream event, an agent
  telemetry record, or the two *correlated* into one.
- **Schema** — documents clustered by fingerprint, with the field paths and BSON
  types that define each cluster. This is where convergence is visible.
- **Operations** — the read/write balance. Reads leave no document behind, so
  they are invisible to every other view, yet "did the shared arm ever *look*
  before writing" is the question the pilot exists to answer.
- **Adoption** — which fields spread from the agent that invented them to
  others.
- **Trends** — how the shape of the store changed over the run.

**No private agent reasoning is exposed.** This is enforced, not promised:
telemetry records never contain document content, only operation, collection,
success, duration, and the fingerprint hash. Records are held under `PIPE_BUF`
(4096 bytes) so concurrent appends from twenty agents stay atomic — and keeping
model-authored text out is what makes that bound hold.

## Why one collection

An earlier pilot let agents name their own collections. They promptly invented a
different name each for the same concept — `tmpdir_issue`,
`pytest_tmpdir_issue`, `tmpdir_fix`, `tmpdir`, and separately `pylint_issue`,
`pylint_issues`, `pylint_bugs`, `pylint_bug` — producing a scatter of
one-document collections.

That is fatal, not untidy. The shared arm's entire mechanism is one agent's
`find` reaching another agent's write, and a `find` scoped to a name nobody else
guessed reaches nothing. The two arms become identical by construction.

So the collection argument was removed from the CLI outright. Convergence is
still measured, and measured on the better signal: document *shape*, via the
fingerprint. Collection names were a noisier proxy for the same thing that
happened to also break retrieval.

## What is measured, and what is not yet

See `RESULTS.md`. Comparisons still running are labelled **in progress** there
rather than being quietly omitted.
