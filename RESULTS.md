# Results

What has actually been measured, what is still running, and what has not been
measured at all. Per-run tables regenerate with:

```sh
python runner/report.py --run-id pilot-003
```

## The one honest caveat, up front

**No SWE-bench resolution rate appears anywhere in this document.** The grading
harness (`swebench.harness.run_evaluation`) has not been run against any pilot.
Every "success"-shaped number below is either *Submitted* (the agent chose to
stop rather than being cut off) or *non-empty patch* (it produced a diff). Both
are upper bounds on success. An agent can submit a confident, well-formed,
completely wrong patch, and several certainly did.

This is a coordination experiment that happens to use SWE-bench as a workload,
and the coordination signal — what the agents wrote to each other, and whether
they converged — is measured properly. Resolution rate is **in progress**.

## Measured: the step limit matters, a lot

Both pilots ran the same model (`anthropic/claude-haiku-4-5-20251001`) on the
same instances in the shared arm, so the step limit is the clean variable.

| | pilot-001 A (limit 40) | pilot-002 A (limit 70) |
|---|---|---|
| Submitted | 6/12 | **9/12** |
| Cut off by the limit | 6/12 | 3/12 |
| Model calls, median / mean | 40 / 35.2 | 38 / 44.5 |
| Cost | $1.60 | $2.24 |

Raw call counts show why this is a real effect and not slack in the budget:

- pilot-001 A: `[24, 26, 28, 30, 35, 39, 40, 40, 40, 40, 40, 40]`
- pilot-002 A: `[24, 29, 30, 34, 34, 34, 38, 49, 52, 70, 70, 70]`

Six agents pinned at exactly 40 in the first pilot. Raising the ceiling rescued
three of them, and they finished at 49 and 52 calls — work that was really there
and really being truncated. But three agents then pinned at exactly 70, so 70 is
still a live ceiling, not headroom. The median barely moved (40 → 38) because
the agents that were already finishing were unaffected; the gain is entirely in
the tail.

Cost rose 40% for a 50% reduction in truncation.

## Measured: agents invent field names, and that broke retrieval

The finding that changed the design. An early pilot let agents name their own
collections. Independently, for the same concept, they produced:

- `tmpdir_issue`, `pytest_tmpdir_issue`, `tmpdir_fix`, `tmpdir`
- `pylint_issue`, `pylint_issues`, `pylint_bugs`, `pylint_bug`

A scatter of one-document collections. This is the emergent-schema phenomenon
the project is about — but it landed on the *container* name rather than the
document, where it was actively destructive. The shared arm's whole mechanism is
one agent's `find` reaching another agent's write, and a `find` scoped to a name
nobody else guessed reaches nothing. Arms A and B become identical by
construction, and the experiment measures nothing.

The collection argument was removed from the CLI outright. Convergence is still
measured, on the better signal: document *shape*, via a 16-hex
`hashFingerprint()`. Collection names were a noisier proxy for the same thing
that happened to also break the retrieval path.

**This is a design change driven by a measurement, and it invalidates the
earlier pilots as A-vs-B comparisons.** pilot-001 and pilot-002 remain valid for
the step-limit result above, which does not depend on cross-agent retrieval.

## Measured: the shared store gets read, not just written

pilot-002 arm A, from telemetry (121 operations, 6 failures):

| | Count |
|---|---|
| `insert` | 39 |
| `find` | 33 |
| `sample` | 19 |
| `update` | 16 |
| `inspect` | 14 |

Read:write **1.20 : 1**.

This is the number that distinguishes a shared memory from a log. Reads leave no
document behind, so they are invisible in the database itself — without
telemetry there is no way to tell "agents wrote to a store" from "agents used a
store". Agents issued slightly more reads than writes, and `inspect` and
`sample` (14 + 19 = 33 calls) are pure schema discovery: an agent asking what
shape the existing knowledge is in before adding to it.

## In progress: pilot-003, shared vs isolated

First head-to-head under the single-collection CLI. 4 agents per arm,
`--step-limit 70`, `--wall-time-limit 600`, both arms running concurrently.

Snapshot at the time of writing — two agents complete, six still running:

| Arm | Complete | Submitted | Hit step ceiling | Non-empty patch | Cost/agent | Median calls |
|---|---|---|---|---|---|---|
| A — shared | 1/4 | 0 | 1 | 1 | $0.342 | 70 |
| B — isolated | 1/4 | 0 | 1 | 1 | $0.290 | 70 |

| Condition | Reads | Writes | Read:write | Distinct shapes |
|---|---|---|---|---|
| shared | 4 | 3 | 1.33 : 1 | 3 |
| isolated | 3 | 4 | 0.75 : 1 | 4 |

Directionally consistent with pilot-002 — the shared arm reads more than it
writes, the isolated arm writes more than it reads, which is what you would
expect when there is nothing to read but your own notes. **With one agent per
arm complete, this is not yet a result.**

### Wall-clock numbers from pilot-003 are not comparable between arms

Both arms are running concurrently against one API account and are being
throttled asymmetrically: at last count 56 `RateLimitError` retries on arm A
against 47 on arm B ("Number of concurrent connections has exceeded your rate
limit"). Wall clock therefore measures queueing at least as much as it measures
the agent, and the `--wall-time-limit` ticks during backoff.

**Time-to-first-fix and wall-clock are contaminated for pilot-003 and are
reported as *in progress*.** Task success, model-call counts, cost, and schema
convergence are unaffected — none of them depend on elapsed time.

The arms were run in parallel deliberately, trading clean timing for finishing
both arms before the deadline. That was the right trade for the coordination
question and the wrong one for the latency question, and the latency question is
the one being dropped rather than quietly reported.

## Not measured

| | Status |
|---|---|
| SWE-bench resolution rate, any arm | **not run** — harness never invoked |
| Time-to-first-fix, pilot-003 | **contaminated** — see above |
| Duplicate work across agents | **in progress** — needs completed arms; measured as one shape written by >1 agent |
| Arm C (frontier baseline) | **not run**, deliberately |
| Whether shared memory improves task success | **open.** This is the actual research question and it is not yet answered. |

## Reproducing

```sh
python runner/report.py --run-id <run_id>          # tables above
UNBOUNDED_DB=<run_id>_shared ./dist/unbounded inspect   # emergent fields
```

`report.py` prints `in progress` rather than `0` for any cell with no data, so a
run that is still going and a run that produced nothing never look the same.
