"""Split a run's telemetry into per-condition files, for a clean observatory view.

When both arms run concurrently they append to the same
`telemetry/<run_id>/<agent_id>.jsonl`, separated only by each record's
`condition` field. That is fine for analysis -- `report.py` groups by condition
-- but `serve` has no condition filter: it watches whole files while its change
stream sees only the one `--db` it was given. The Activity and Operations tabs
then blend the isolated arm into what presents as a shared-arm view.

This writes `telemetry/<run_id>-<condition>/<agent_id>.jsonl` containing only
that condition's records, so `serve` can be pointed at one arm.

Run it after the arms finish. Running it mid-run produces a partial copy -- the
originals are never modified, so it is safe to simply run again.

Usage: python runner/split_telemetry.py --run-id pilot-003
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def split_run(telemetry_root: Path, run_id: str) -> Counter[str]:
    source = telemetry_root / run_id
    if not source.is_dir():
        raise SystemExit(f"no telemetry directory: {source}")

    written: Counter[str] = Counter()
    for path in sorted(source.glob("*.jsonl")):
        by_condition: dict[str, list[str]] = {}
        for line in path.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                condition = json.loads(line).get("condition")
            except json.JSONDecodeError:
                # A torn last line while the run is live. Dropping it loses one
                # record from a copy; the original file is left untouched.
                continue
            if condition:
                by_condition.setdefault(condition, []).append(line)

        for condition, lines in by_condition.items():
            target = telemetry_root / f"{run_id}-{condition}"
            target.mkdir(parents=True, exist_ok=True)
            # Trailing newline: `serve` and `report.py` both read line-wise, and
            # a missing final newline looks exactly like a torn record.
            (target / path.name).write_text("\n".join(lines) + "\n")
            written[condition] += len(lines)

    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--telemetry-root", type=Path, default=REPO_ROOT / "telemetry")
    args = parser.parse_args()

    written = split_run(args.telemetry_root, args.run_id)
    if not written:
        raise SystemExit("no records carried a `condition` field; nothing written")
    for condition, count in sorted(written.items()):
        directory = args.telemetry_root / f"{args.run_id}-{condition}"
        print(f"{condition}: {count} records -> {directory}/")


if __name__ == "__main__":
    main()
