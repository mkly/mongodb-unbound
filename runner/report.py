"""Build the results sheet for one run from its result JSON and telemetry.

Reads only what the pilot already writes -- `results/<run_id>/<arm>/<instance>/
<agent>.json` and `telemetry/<run_id>/<agent>.jsonl` -- and emits a Markdown
table per measured outcome. Nothing here queries MongoDB: the emergent *field
names* live in the database and come from `unbounded inspect`, deliberately, so
this report needs no credentials and can be run by anyone holding the artifacts.

Honesty rules, enforced in code rather than left to the writer:

* Task success is NOT measured here. Only the SWE-bench harness decides whether
  a patch resolves an instance. What this reports is `exit_status` and whether a
  patch is non-empty -- an upper bound on success, labelled as such.
* Any cell with no data prints `in progress`, never a zero. A run that is still
  going and a run that produced nothing must not look the same.

Usage: python runner/report.py --run-id pilot-003 [--out RESULTS.md]
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent

#: `exit_status` values that mean the agent chose to stop, rather than being cut
#: off by the step or wall-time ceiling. Only these can possibly be successes.
SUBMITTED = "Submitted"

ARM_CONDITION = {"A": "shared", "B": "isolated", "C": "baseline"}


def load_results(run_root: Path, run_id: str) -> dict[str, list[dict[str, Any]]]:
    """Return {arm: [result, ...]} for every result file the run has written."""
    by_arm: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for path in sorted((run_root / run_id).glob("*/*/agent_*.json")):
        try:
            record = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            # A file being written as we read it is expected mid-run; skipping
            # it understates the run by one row rather than crashing the report.
            continue
        by_arm[record.get("arm", "?")].append(record)
    return dict(by_arm)


def load_telemetry(
    telemetry_root: Path, run_id: str
) -> dict[str, list[dict[str, Any]]]:
    """Return {condition: [record, ...]}.

    Keyed by condition, not agent: when both arms run in parallel they share one
    JSONL file per agent id, and `condition` is what separates them.
    """
    by_condition: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for path in sorted((telemetry_root / run_id).glob("*.jsonl")):
        for line in path.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                # A torn final line while the run is live. Every complete record
                # before it is still valid; drop only this one.
                continue
            by_condition[record.get("condition", "?")].append(record)
    return dict(by_condition)


def cell(value: Any) -> str:
    return "*in progress*" if value is None else str(value)


def outcomes_table(by_arm: dict[str, list[dict[str, Any]]]) -> list[str]:
    rows = [
        "| Arm | Agents | Submitted | Hit step ceiling | Non-empty patch |",
        "|---|---|---|---|---|",
    ]
    for arm in sorted(by_arm):
        results = by_arm[arm]
        status = Counter(r.get("exit_status", "?") for r in results)
        patched = sum(1 for r in results if (r.get("model_patch") or "").strip())
        rows.append(
            f"| {arm} — {ARM_CONDITION.get(arm, '?')} | {len(results)} "
            f"| {status.get(SUBMITTED, 0)} "
            f"| {sum(count for name, count in status.items() if name != SUBMITTED)} "
            f"| {patched} |"
        )
    return rows


def effort_table(by_arm: dict[str, list[dict[str, Any]]]) -> list[str]:
    rows = [
        "| Arm | Model calls (med) | Cost | Cost/agent | Wall clock (med) |",
        "|---|---|---|---|---|",
    ]
    for arm in sorted(by_arm):
        results = by_arm[arm]
        calls = [r["n_calls"] for r in results if "n_calls" in r]
        wall = [r["wall_clock_ms"] for r in results if "wall_clock_ms" in r]
        cost = sum(r.get("cost", 0.0) for r in results)
        per_agent = f"${cost / len(results):.3f}" if results else "*in progress*"
        rows.append(
            f"| {arm} — {ARM_CONDITION.get(arm, '?')} "
            f"| {cell(round(median(calls)) if calls else None)} "
            f"| ${cost:.2f} | {per_agent} "
            f"| {cell(f'{median(wall) / 1000:.0f}s' if wall else None)} |"
        )
    return rows


def time_to_first_fix(by_arm: dict[str, list[dict[str, Any]]]) -> list[str]:
    rows = [
        "| Arm | Instance | Fastest submitted agent |",
        "|---|---|---|",
    ]
    for arm in sorted(by_arm):
        by_instance: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for record in by_arm[arm]:
            by_instance[record.get("instance_id", "?")].append(record)
        for instance in sorted(by_instance):
            submitted = [
                r
                for r in by_instance[instance]
                if r.get("exit_status") == SUBMITTED and "wall_clock_ms" in r
            ]
            fastest = (
                f"{min(r['wall_clock_ms'] for r in submitted) / 1000:.0f}s"
                if submitted
                else None
            )
            rows.append(
                f"| {arm} — {ARM_CONDITION.get(arm, '?')} | {instance} "
                f"| {cell(fastest)} |"
            )
    return rows


def store_use_table(by_condition: dict[str, list[dict[str, Any]]]) -> list[str]:
    """Reads against writes, and how much of the store was rediscovery."""
    rows = [
        "| Condition | Reads | Writes | Read:write | Distinct shapes | Shapes written by >1 agent |",
        "|---|---|---|---|---|---|",
    ]
    reads = {"aggregate", "count", "distinct", "find", "get", "inspect", "list", "sample"}
    writes = {"delete", "insert", "replace", "update", "upsert"}
    for condition in sorted(by_condition):
        ops = [r for r in by_condition[condition] if r.get("type") == "unbounded_op"]
        read_count = sum(1 for r in ops if r.get("operation") in reads)
        write_count = sum(1 for r in ops if r.get("operation") in writes)
        # Duplicate work, measured on shape: a fingerprint that more than one
        # agent wrote is the same document structure arrived at independently.
        agents_per_shape: dict[str, set[str]] = defaultdict(set)
        for record in by_condition[condition]:
            fingerprint = record.get("schema_fingerprint")
            if fingerprint:
                agents_per_shape[fingerprint].add(record.get("agent_id", "?"))
        shared_shapes = sum(1 for a in agents_per_shape.values() if len(a) > 1)
        ratio = f"{read_count / write_count:.2f} : 1" if write_count else None
        rows.append(
            f"| {condition} | {read_count} | {write_count} | {cell(ratio)} "
            f"| {cell(len(agents_per_shape) or None)} | {cell(shared_shapes if agents_per_shape else None)} |"
        )
    return rows


def build_report(run_id: str, run_root: Path, telemetry_root: Path) -> str:
    by_arm = load_results(run_root, run_id)
    by_condition = load_telemetry(telemetry_root, run_id)

    lines = [
        f"# Results — {run_id}",
        "",
        "Generated by `python runner/report.py --run-id " + run_id + "`.",
        "",
        "## Outcomes",
        "",
        "**Task success is not in this table.** Only the SWE-bench harness "
        "decides whether a patch resolves an instance; run it separately. "
        "*Submitted* means the agent chose to stop, and a non-empty patch means "
        "it produced a diff — together an upper bound on success, not success.",
        "",
        *outcomes_table(by_arm),
        "",
        "## Effort",
        "",
        *effort_table(by_arm),
        "",
        "## Time to first fix",
        "",
        "Fastest *submitted* agent per instance. Treat with suspicion whenever "
        "the arms ran concurrently: API rate limiting is shared, so wall clock "
        "measures queueing as much as it measures the agent.",
        "",
        *time_to_first_fix(by_arm),
        "",
        "## Store use and duplicate work",
        "",
        "Shapes are 16-hex `hashFingerprint()` values. A shape written by more "
        "than one agent is the same document structure arrived at "
        "independently — convergence in the shared condition, redundancy in the "
        "isolated one.",
        "",
        *store_use_table(by_condition),
        "",
        "## Emergent fields",
        "",
        "Field *names* are deliberately absent from telemetry, so they come "
        "from the database rather than this report:",
        "",
        "```sh",
        f"UNBOUNDED_DB={run_id}_shared ./dist/unbounded inspect",
        "```",
        "",
    ]
    if not by_arm:
        lines.insert(3, "**No results yet — this run is still in progress.**\n")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    # Both default to the repo root, matching swarm.py's own `--telemetry-root`
    # default. There is a stale `/work/telemetry` from an early smoke test that
    # is NOT where runs write; pointing at it silently reports an empty run.
    parser.add_argument("--results-root", type=Path, default=REPO_ROOT / "results")
    parser.add_argument("--telemetry-root", type=Path, default=REPO_ROOT / "telemetry")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    report = build_report(args.run_id, args.results_root, args.telemetry_root)
    if args.out:
        args.out.write_text(report)
        print(f"wrote {args.out}")
    else:
        print(report)


if __name__ == "__main__":
    main()
