"""JSONL telemetry for the shared-memory pilot: one stream, four record types.

Every record carries the same envelope and is discriminated by ``type``. Files
live at ``telemetry/<run_id>/<agent_id>.jsonl`` -- one per agent, appended
concurrently by the launcher (``model_call``, ``run_summary``) and by the
``unbounded`` wrapper running inside that agent's SWE-bench container
(``unbounded_op``, ``db_write``).

Records MUST stay under ``MAX_RECORD_BYTES`` (4096, Linux ``PIPE_BUF``): an
``O_APPEND`` write is atomic only up to that size, and above it twenty
concurrent writers can interleave and corrupt lines. That is why no record ever
embeds a document, a patch, or model output -- ``document_id`` plus the MongoDB
change stream recovers the content, and the JSONL supplies only the attribution
(``run_id``, ``agent_id``, ``condition``, ``task_id``) the change stream cannot
know.

Readers must skip unknown ``type`` values with a diagnostic rather than failing.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from collections.abc import Iterable, Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("telemetry")

#: Linux PIPE_BUF. Appends at or below this size are atomic.
MAX_RECORD_BYTES = 4096

#: Fields present on every record, regardless of type.
ENVELOPE_FIELDS: tuple[str, ...] = (
    "type",
    "event_id",
    "timestamp",
    "run_id",
    "task_id",
    "agent_id",
    "condition",
)

CONDITIONS: tuple[str, ...] = ("shared", "isolated", "baseline")

#: Required payload fields per record type, in addition to the envelope.
TYPE_FIELDS: dict[str, tuple[str, ...]] = {
    "model_call": ("model", "input_tokens", "output_tokens", "estimated_cost", "step"),
    "unbounded_op": ("operation", "collection", "success", "exit_code", "duration_ms"),
    "db_write": ("operation", "collection", "document_id"),
    "run_summary": ("wall_clock_ms", "resolved", "patch_size_lines", "f2p_passed", "p2p_passed"),
}

#: Optional payload fields per record type. Readers must treat absence as normal.
OPTIONAL_TYPE_FIELDS: dict[str, tuple[str, ...]] = {
    "model_call": (),
    "unbounded_op": (),
    "db_write": ("schema_fingerprint",),
    "run_summary": (),
}

RECORD_TYPES: tuple[str, ...] = tuple(TYPE_FIELDS)

#: run_summary fields that are only known after the separate scoring step.
_NULLABLE_FIELDS: frozenset[str] = frozenset({"resolved", "f2p_passed", "p2p_passed"})

#: Longest string a payload field may hold before an oversized record is shrunk.
_SHRINK_TO = 200


def utc_now() -> str:
    """Return the current UTC time as RFC 3339 with millisecond precision."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def telemetry_path(root: Path | str, run_id: str, agent_id: str) -> Path:
    """Return the JSONL path for one agent: ``<root>/<run_id>/<agent_id>.jsonl``."""
    return Path(root) / run_id / f"{agent_id}.jsonl"


class TelemetryWriter:
    """Append-only JSONL writer for a single agent, safe across threads and processes.

    Each :meth:`emit` performs one ``os.write`` to a file descriptor opened with
    ``O_APPEND``, so writes from the launcher and from the in-container wrapper
    interleave safely as long as records stay under :data:`MAX_RECORD_BYTES`.
    Telemetry is diagnostic: write failures are logged, never raised.
    """

    def __init__(
        self,
        path: Path | str,
        *,
        run_id: str,
        task_id: str,
        agent_id: str,
        condition: str,
        enabled: bool = True,
    ) -> None:
        self.path = Path(path)
        self.run_id = run_id
        self.task_id = task_id
        self.agent_id = agent_id
        self.condition = condition
        self.enabled = enabled
        self._lock = threading.Lock()
        self._fd: int | None = None

    def _ensure_fd(self) -> int:
        if self._fd is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        return self._fd

    def envelope(self, record_type: str) -> dict[str, Any]:
        """Return a fresh envelope for ``record_type`` with a unique ``event_id``."""
        return {
            "type": record_type,
            "event_id": str(uuid.uuid4()),
            "timestamp": utc_now(),
            "run_id": self.run_id,
            "task_id": self.task_id,
            "agent_id": self.agent_id,
            "condition": self.condition,
        }

    def emit(self, record_type: str, **fields: Any) -> dict[str, Any]:
        """Append one record of ``record_type`` and return it.

        Unknown field names are permitted (forward compatibility) but the
        required fields for the type should always be supplied. The returned
        record is the one actually written, after any shrinking.
        """
        if record_type not in RECORD_TYPES:
            raise ValueError(f"unknown record type {record_type!r}; expected one of {RECORD_TYPES}")
        record = {**self.envelope(record_type), **fields}
        if not self.enabled:
            return record
        record, line = _fit(record)
        if line is None:
            logger.error("dropping oversized %s record for %s", record_type, self.agent_id)
            return record
        try:
            with self._lock:
                os.write(self._ensure_fd(), line)
        except OSError as exc:  # telemetry must never take down a run
            logger.error("telemetry write to %s failed: %s", self.path, exc)
        return record

    def close(self) -> None:
        """Close the underlying descriptor. Safe to call more than once."""
        with self._lock:
            if self._fd is not None:
                try:
                    os.close(self._fd)
                finally:
                    self._fd = None

    def __enter__(self) -> TelemetryWriter:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def _encode(record: dict[str, Any]) -> bytes:
    return (json.dumps(record, separators=(",", ":"), default=str) + "\n").encode("utf-8")


def _fit(record: dict[str, Any]) -> tuple[dict[str, Any], bytes | None]:
    """Shrink ``record`` until its encoding fits in :data:`MAX_RECORD_BYTES`.

    Returns the (possibly modified) record and its encoding, or ``None`` for the
    encoding if even the envelope alone does not fit.
    """
    line = _encode(record)
    if len(line) <= MAX_RECORD_BYTES:
        return record, line

    record = dict(record)
    for key, value in record.items():
        if key not in ENVELOPE_FIELDS and isinstance(value, str) and len(value) > _SHRINK_TO:
            record[key] = value[:_SHRINK_TO] + "..."
    line = _encode(record)
    if len(line) <= MAX_RECORD_BYTES:
        logger.warning("truncated oversized %s record fields", record.get("type"))
        return record, line

    record = {k: v for k, v in record.items() if k in ENVELOPE_FIELDS or k in TYPE_FIELDS.get(str(record.get("type")), ())}
    line = _encode(record)
    if len(line) <= MAX_RECORD_BYTES:
        logger.warning("dropped extra fields from oversized %s record", record.get("type"))
        return record, line
    return record, None


def validate_record(record: Any) -> list[str]:
    """Return a list of problems with ``record``. An empty list means it is valid.

    Validates the shared envelope and the payload fields for the record's type.
    An unrecognised ``type`` yields a single diagnostic; callers should skip such
    records rather than treat them as fatal.
    """
    if not isinstance(record, dict):
        return [f"record is {type(record).__name__}, expected object"]

    problems: list[str] = []
    record_type = record.get("type")
    for field in ENVELOPE_FIELDS:
        value = record.get(field)
        if not isinstance(value, str) or not value:
            problems.append(f"envelope field {field!r} missing or not a non-empty string")
    if isinstance(record.get("condition"), str) and record["condition"] not in CONDITIONS:
        problems.append(f"condition {record['condition']!r} not in {CONDITIONS}")

    if not isinstance(record_type, str) or record_type not in RECORD_TYPES:
        problems.append(f"unknown record type {record_type!r}")
        return problems

    for field in TYPE_FIELDS[record_type]:
        if field not in record:
            problems.append(f"{record_type} field {field!r} missing")
            continue
        value = record[field]
        if value is None and field in _NULLABLE_FIELDS:
            continue  # backfilled by the separate scoring step
        if isinstance(value, bool):
            continue
        if not isinstance(value, (str, int, float)):
            problems.append(f"{record_type} field {field!r} has non-scalar type {type(value).__name__}")
    return problems


def read_records(path: Path | str, *, strict: bool = False) -> Iterator[dict[str, Any]]:
    """Yield valid records from one JSONL file.

    Malformed lines and unknown record types are reported as diagnostics and
    skipped. With ``strict=True`` a malformed line raises instead.
    """
    path = Path(path)
    if not path.exists():
        return
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for lineno, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                message = f"{path}:{lineno}: unparseable line ({exc})"
                if strict:
                    raise ValueError(message) from exc
                logger.warning("%s", message)
                continue
            problems = validate_record(record)
            if problems:
                message = f"{path}:{lineno}: {'; '.join(problems)}"
                if strict:
                    raise ValueError(message)
                logger.warning("%s", message)
                continue
            yield record


def read_run(root: Path | str, run_id: str, *, strict: bool = False) -> Iterator[dict[str, Any]]:
    """Yield every valid record for ``run_id``, deduplicated by ``event_id``."""
    seen: set[str] = set()
    directory = Path(root) / run_id
    for path in sorted(directory.glob("*.jsonl")):
        for record in read_records(path, strict=strict):
            event_id = record["event_id"]
            if event_id in seen:
                continue
            seen.add(event_id)
            yield record


def summarize(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate records into per-condition counters, for a quick sanity check."""
    summary: dict[str, Any] = {"records": 0, "by_type": {}, "by_condition": {}}
    for record in records:
        summary["records"] += 1
        summary["by_type"][record["type"]] = summary["by_type"].get(record["type"], 0) + 1
        bucket = summary["by_condition"].setdefault(
            record["condition"],
            {"agents": set(), "tasks": set(), "model_calls": 0, "cost": 0.0, "unbounded_ops": 0, "db_writes": 0},
        )
        bucket["agents"].add(record["agent_id"])
        bucket["tasks"].add(record["task_id"])
        if record["type"] == "model_call":
            bucket["model_calls"] += 1
            bucket["cost"] += float(record.get("estimated_cost") or 0.0)
        elif record["type"] == "unbounded_op":
            bucket["unbounded_ops"] += 1
        elif record["type"] == "db_write":
            bucket["db_writes"] += 1
    for bucket in summary["by_condition"].values():
        bucket["agents"] = len(bucket["agents"])
        bucket["tasks"] = len(bucket["tasks"])
    return summary


def _main() -> None:
    """``python runner/telemetry.py <root> <run_id>`` -- validate and summarize a run."""
    import sys

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    if len(sys.argv) != 3:
        raise SystemExit("usage: telemetry.py <telemetry-root> <run-id>")
    print(json.dumps(summarize(read_run(sys.argv[1], sys.argv[2])), indent=2))


if __name__ == "__main__":
    _main()
