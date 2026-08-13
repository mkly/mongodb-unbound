#!/usr/bin/env python3
"""Experiment launcher for the shared-memory pilot.

Runs three arms over the same SWE-bench Lite instances:

    A  shared    20 agents, all pointed at ONE MongoDB database (``<run_id>_shared``)
    B  isolated  20 agents, each pointed at its own (``<run_id>_agent_NN``)
    C  baseline  1 agent, no memory tool and no database at all

Arms A and B differ in exactly one thing -- the database name handed to the
``unbounded`` binary -- so that the comparison isolates shared memory. The prompt
is byte-identical between them (see ``runner/prompts.py``).

Runs inside the pilot Incus container, from ``/work/unbounded-pilot``:

    .venv/bin/python runner/swarm.py --run-id run-001 --arm A

Secrets (``UNBOUNDED_MONGO_URI``, ``ANTHROPIC_API_KEY``) are read from the
environment or from ``/work/.env``. They are never passed as command-line
arguments, never logged, and never written to disk: the MongoDB URI reaches each
agent container through ``docker run -e UNBOUNDED_MONGO_URI`` with no value,
which makes Docker inherit it from this process's environment.

Scoring is a separate step; this script prints the exact ``run_evaluation``
commands but never invokes them.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import logging
import os
import random
import re
import signal
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from minisweagent.agents.default import DefaultAgent  # noqa: E402
from minisweagent.config import builtin_config_dir, get_config_from_spec  # noqa: E402
from minisweagent.models import get_model  # noqa: E402
from minisweagent.run.benchmarks.swebench import (  # noqa: E402
    DATASET_MAPPING,
    get_sb_environment,
    get_swebench_docker_image_name,
)
from minisweagent.utils.serialize import recursive_merge  # noqa: E402

from telemetry import TelemetryWriter, telemetry_path  # noqa: E402

try:
    from prompts import build_system_prompt
except ImportError:  # pragma: no cover - prompts.py is owned by another agent
    def build_system_prompt(condition: str) -> str:
        """Placeholder used only when ``runner/prompts.py`` is not importable."""
        return (
            "PLACEHOLDER SYSTEM PROMPT -- runner/prompts.py was not importable. "
            f"condition={condition}. Do not run a real experiment with this."
        )

logger = logging.getLogger("swarm")

DEFAULT_INSTANCES: tuple[str, ...] = (
    "pylint-dev__pylint-7228",
    "pallets__flask-4992",
    "pytest-dev__pytest-8365",
)

DEFAULT_SUBSET = "lite"
DEFAULT_SPLIT = "test"
BUILTIN_CONFIG = builtin_config_dir / "benchmarks" / "swebench.yaml"
ENV_FILE = Path(os.getenv("UNBOUNDED_ENV_FILE", "/work/.env"))

#: Compiled CLI and the pilot-only telemetry wrapper that fronts it on PATH.
UNBOUNDED_BINARY = REPO_ROOT / "dist" / "unbounded"
UNBOUNDED_WRAPPER = REPO_ROOT / "runner" / "unbounded-wrapper.sh"
CONTAINER_WRAPPER_PATH = "/usr/local/bin/unbounded"
CONTAINER_BINARY_PATH = "/opt/unbounded/bin/unbounded"

SUBMIT_SENTINEL = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"

#: Exception markers that mean "the provider pushed back", not "the agent failed".
_RATE_LIMIT_STATUS = {408, 409, 425, 429, 500, 502, 503, 504, 529}
_RATE_LIMIT_MARKERS = (
    "rate limit",
    "rate_limit",
    "ratelimit",
    "too many requests",
    "overloaded",
    "overloaded_error",
    "capacity",
    "429",
    "529",
)


@dataclass(frozen=True)
class ArmSpec:
    """Static definition of one experimental arm."""

    arm: str
    condition: str
    n_agents: int
    model_name: str
    cost_limit: float

    def database(self, run_id: str, agent_id: str) -> str | None:
        """Return the MongoDB database for ``agent_id``, or ``None`` for baseline."""
        if self.condition == "shared":
            return f"{run_id}_shared"
        if self.condition == "isolated":
            return f"{run_id}_{agent_id}"
        return None


ARMS: dict[str, ArmSpec] = {
    "A": ArmSpec("A", "shared", 20, "anthropic/claude-haiku-4-5-20251001", 1.5),
    "B": ArmSpec("B", "isolated", 20, "anthropic/claude-haiku-4-5-20251001", 1.5),
    "C": ArmSpec("C", "baseline", 1, "anthropic/claude-sonnet-5", 5.0),
}


@dataclass(frozen=True)
class Job:
    """One agent working one instance in one arm."""

    spec: ArmSpec
    instance: dict[str, Any]
    agent_id: str

    @property
    def task_id(self) -> str:
        return str(self.instance["instance_id"])

    @property
    def label(self) -> str:
        return f"{self.spec.arm}/{self.task_id}/{self.agent_id}"


# --------------------------------------------------------------------------- #
# environment & secrets
# --------------------------------------------------------------------------- #


def load_env_file(path: Path) -> list[str]:
    """Load ``KEY=VALUE`` / ``export KEY=VALUE`` pairs into ``os.environ``.

    Existing environment variables win. Returns the names loaded -- never the
    values, which must not reach the log.
    """
    if not path.exists():
        return []
    loaded: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ").strip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value
            loaded.append(key)
    return loaded


def check_secrets(*, needs_mongo: bool) -> list[str]:
    """Return the names of required secrets that are still missing."""
    required = ["ANTHROPIC_API_KEY"] + (["UNBOUNDED_MONGO_URI"] if needs_mongo else [])
    return [name for name in required if not os.environ.get(name)]


# --------------------------------------------------------------------------- #
# config assembly
# --------------------------------------------------------------------------- #


def build_container_env(job: Job, run_id: str, telemetry_mount: str) -> dict[str, str]:
    """Return the non-secret environment injected into the agent's container.

    The MongoDB URI is deliberately absent: it is inherited by the container at
    creation time (see :func:`build_run_args`) so it never appears in any argv.
    """
    database = job.spec.database(run_id, job.agent_id)
    if database is None:
        return {}
    return {
        "UNBOUNDED_DB": database,
        "UNBOUNDED_BIN": CONTAINER_BINARY_PATH,
        "UNBOUNDED_TELEMETRY": f"{telemetry_mount}/{job.agent_id}.jsonl",
        "UNBOUNDED_RUN_ID": run_id,
        "UNBOUNDED_TASK_ID": job.task_id,
        "UNBOUNDED_AGENT_ID": job.agent_id,
        "UNBOUNDED_CONDITION": job.spec.condition,
    }


def build_run_args(job: Job, telemetry_dir: Path, telemetry_mount: str) -> list[str]:
    """Return the ``docker run`` arguments for this agent's container.

    Arm C gets no mounts and no ``UNBOUNDED_*`` variables at all -- the baseline
    must not be able to reach memory even by accident.
    """
    run_args = ["--rm"]
    if job.spec.condition == "baseline":
        return run_args
    run_args += ["-v", f"{telemetry_dir}:{telemetry_mount}"]
    if UNBOUNDED_WRAPPER.exists():
        # The wrapper occupies `unbounded` on PATH, appends telemetry, then execs
        # the real executable at CONTAINER_BINARY_PATH.
        run_args += [
            "-v", f"{UNBOUNDED_WRAPPER}:{CONTAINER_WRAPPER_PATH}:ro",
            "-v", f"{UNBOUNDED_BINARY}:{CONTAINER_BINARY_PATH}:ro",
        ]
    else:
        logger.warning("telemetry wrapper %s missing; mounting the binary bare", UNBOUNDED_WRAPPER)
        run_args += ["-v", f"{UNBOUNDED_BINARY}:{CONTAINER_WRAPPER_PATH}:ro"]
    # `-e NAME` with no value makes Docker inherit NAME from this process, so the
    # secret never lands in argv or on disk.
    run_args += ["-e", "UNBOUNDED_MONGO_URI"]
    return run_args


def build_config(job: Job, run_id: str, telemetry_dir: Path, *, step_limit: int, wall_time_limit: int,
                 telemetry_mount: str = "/telemetry") -> dict[str, Any]:
    """Merge this agent's overrides over mini-swe-agent's builtin ``swebench.yaml``."""
    overrides: dict[str, Any] = {
        "agent": {
            "system_template": build_system_prompt(job.spec.condition),
            "cost_limit": job.spec.cost_limit,
            "step_limit": step_limit,
            "wall_time_limit_seconds": wall_time_limit,
        },
        "model": {"model_name": job.spec.model_name},
        "environment": {
            "env": build_container_env(job, run_id, telemetry_mount),
            "run_args": build_run_args(job, telemetry_dir, telemetry_mount),
        },
    }
    return recursive_merge(get_config_from_spec(BUILTIN_CONFIG), overrides)


# --------------------------------------------------------------------------- #
# dataset
# --------------------------------------------------------------------------- #


def load_instances(instance_ids: list[str], subset: str, split: str) -> list[dict[str, Any]]:
    """Load the named SWE-bench instances, preserving the requested order."""
    from datasets import load_dataset

    dataset_path = DATASET_MAPPING.get(subset, subset)
    logger.info("loading dataset %s split %s", dataset_path, split)
    wanted = set(instance_ids)
    found = {
        str(inst["instance_id"]): dict(inst)
        for inst in load_dataset(dataset_path, split=split)
        if str(inst["instance_id"]) in wanted
    }
    if missing := wanted - set(found):
        raise SystemExit(f"instances not found in {dataset_path}/{split}: {sorted(missing)}")
    return [found[iid] for iid in instance_ids]


# --------------------------------------------------------------------------- #
# concurrency governor
# --------------------------------------------------------------------------- #


def is_rate_limit_error(exc: BaseException) -> bool:
    """Heuristically decide whether ``exc`` is provider back-pressure.

    The account returns no ``ratelimit-*`` headers, so this is the only signal
    available: HTTP status if the exception carries one, otherwise the message.
    """
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    try:
        if int(status) in _RATE_LIMIT_STATUS:  # type: ignore[arg-type]
            return True
    except (TypeError, ValueError):
        pass
    names = " ".join(t.__name__ for t in type(exc).__mro__).lower()
    if any(marker in names for marker in ("ratelimit", "overloaded", "serviceunavailable", "internalserver")):
        return True
    text = str(exc).lower()
    return any(marker in text for marker in _RATE_LIMIT_MARKERS)


class ConcurrencyGovernor:
    """Adaptive admission control: ramp up while healthy, back off on 429/529.

    Starts below ``max_limit`` and adds a slot after ``ramp_after`` consecutive
    clean finishes. A rate-limit signal halves the limit and parks every worker
    behind an exponential backoff with jitter.
    """

    def __init__(self, max_limit: int, *, start: int | None = None, ramp_after: int = 2,
                 base_backoff: float = 5.0, max_backoff: float = 300.0) -> None:
        self.max_limit = max(1, max_limit)
        self.limit = max(1, min(start if start is not None else 2, self.max_limit))
        self.ramp_after = ramp_after
        self.base_backoff = base_backoff
        self.max_backoff = max_backoff
        self._active = 0
        self._successes = 0
        self._penalties = 0
        self._resume_at = 0.0
        self._cv = threading.Condition()

    def acquire(self, stop: threading.Event) -> bool:
        """Block until a slot is free and any backoff has elapsed.

        Returns ``False`` if ``stop`` was set while waiting.
        """
        with self._cv:
            while not stop.is_set():
                now = time.monotonic()
                if self._active < self.limit and now >= self._resume_at:
                    self._active += 1
                    return True
                wait = max(0.1, self._resume_at - now) if self._resume_at > now else 1.0
                self._cv.wait(timeout=wait)
            return False

    def release(self) -> None:
        with self._cv:
            self._active = max(0, self._active - 1)
            self._cv.notify_all()

    def record_success(self) -> None:
        """Note a clean finish; widen the gate once enough have accumulated."""
        with self._cv:
            self._penalties = max(0, self._penalties - 1)
            self._successes += 1
            if self._successes >= self.ramp_after and self.limit < self.max_limit:
                self.limit += 1
                self._successes = 0
                logger.info("ramping concurrency up to %d", self.limit)
                self._cv.notify_all()

    def record_rate_limit(self) -> float:
        """Note provider back-pressure; halve the gate and park workers. Returns the pause."""
        with self._cv:
            self._successes = 0
            self._penalties += 1
            delay = min(self.base_backoff * (2 ** (self._penalties - 1)), self.max_backoff)
            delay *= 0.5 + random.random()  # full-ish jitter; avoid lockstep retries
            self._resume_at = max(self._resume_at, time.monotonic() + delay)
            if self.limit > 1:
                self.limit = max(1, self.limit // 2)
            logger.warning("rate limited: concurrency now %d, pausing %.1fs", self.limit, delay)
            return delay

    def wake(self) -> None:
        """Wake every waiter, e.g. after a stop request."""
        with self._cv:
            self._cv.notify_all()


# --------------------------------------------------------------------------- #
# running one agent
# --------------------------------------------------------------------------- #


class TelemetryAgent(DefaultAgent):
    """``DefaultAgent`` that emits a ``model_call`` record per LM call, as it happens."""

    def __init__(self, model: Any, env: Any, *, writer: TelemetryWriter, model_name: str, **kwargs: Any) -> None:
        super().__init__(model, env, **kwargs)
        self._writer = writer
        self._model_name = model_name

    def query(self) -> dict:
        try:
            message = super().query()
        except Exception as exc:
            # A FormatError still carries a billed response; record it and re-raise.
            messages = getattr(exc, "messages", None)
            if messages:
                self._emit(messages[0])
            raise
        self._emit(message)
        return message

    def _emit(self, message: dict) -> None:
        extra = message.get("extra") or {}
        if "cost" not in extra:
            return
        response = extra.get("response")
        usage = response.get("usage") or {} if isinstance(response, dict) else {}
        self._writer.emit(
            "model_call",
            model=self._model_name,
            input_tokens=int(usage.get("prompt_tokens") or 0),
            output_tokens=int(usage.get("completion_tokens") or 0),
            estimated_cost=float(extra.get("cost") or 0.0),
            step=self.n_calls,
        )


def extract_patch(info: dict[str, Any], agent: DefaultAgent | None) -> str:
    """Return the agent's submitted diff.

    ``DockerEnvironment`` already strips the ``COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT``
    sentinel when it raises ``Submitted``, so ``info["submission"]`` is normally
    the patch. The final-message scan is the fallback for agents that exited by
    another path.
    """
    submission = (info or {}).get("submission") or ""
    if not submission and agent is not None:
        for message in reversed(agent.messages):
            content = message.get("content")
            if isinstance(content, str) and SUBMIT_SENTINEL in content:
                submission = content.split(SUBMIT_SENTINEL, 1)[1].lstrip("\n")
                break
    submission = submission.strip()
    if submission and not re.search(r"^(diff --git|--- )", submission, re.MULTILINE):
        logger.warning("submission does not look like a diff (%d chars)", len(submission))
    return submission + "\n" if submission else ""


def result_path(results_dir: Path, job: Job) -> Path:
    """Per-agent result file. Its existence is what makes the run resumable."""
    return results_dir / job.spec.arm / job.task_id / f"{job.agent_id}.json"


def run_job(job: Job, run_id: str, results_dir: Path, telemetry_root: Path, *, step_limit: int,
            wall_time_limit: int) -> dict[str, Any]:
    """Run one agent to completion and write its result file. Never raises."""
    telemetry_dir = telemetry_root / run_id
    telemetry_dir.mkdir(parents=True, exist_ok=True)
    config = build_config(job, run_id, telemetry_dir, step_limit=step_limit, wall_time_limit=wall_time_limit)

    writer = TelemetryWriter(
        telemetry_path(telemetry_root, run_id, job.agent_id),
        run_id=run_id,
        task_id=job.task_id,
        agent_id=job.agent_id,
        condition=job.spec.condition,
    )

    started = time.monotonic()
    agent: TelemetryAgent | None = None
    env = None
    info: dict[str, Any] = {}
    error = ""
    try:
        model = get_model(config=config.get("model", {}))
        env = get_sb_environment(config, job.instance)
        agent = TelemetryAgent(
            model, env, writer=writer, model_name=job.spec.model_name, **config.get("agent", {})
        )
        info = agent.run(str(job.instance["problem_statement"]))
    except Exception as exc:  # one agent's failure must never kill the run
        error = f"{type(exc).__name__}: {exc}"
        logger.error("%s failed: %s", job.label, error)
        logger.debug("%s traceback:\n%s", job.label, traceback.format_exc())
        if not info:
            info = {"exit_status": type(exc).__name__, "submission": ""}
        raise JobFailed(job, exc, _finalize(job, run_id, results_dir, writer, agent, info, error, started)) from exc
    finally:
        if env is not None:
            env.cleanup()

    return _finalize(job, run_id, results_dir, writer, agent, info, error, started)


class JobFailed(Exception):
    """Raised by :func:`run_job` so the caller can inspect the cause and back off."""

    def __init__(self, job: Job, cause: BaseException, result: dict[str, Any]) -> None:
        super().__init__(f"{job.label}: {cause}")
        self.job = job
        self.cause = cause
        self.result = result


def _finalize(job: Job, run_id: str, results_dir: Path, writer: TelemetryWriter,
              agent: DefaultAgent | None, info: dict[str, Any], error: str, started: float) -> dict[str, Any]:
    """Emit the ``run_summary`` record and persist the per-agent result file."""
    wall_clock_ms = int((time.monotonic() - started) * 1000)
    patch = extract_patch(info, agent)
    patch_size_lines = sum(1 for line in patch.splitlines() if line[:1] in ("+", "-") and line[:3] not in ("+++", "---"))

    # resolved / f2p_passed / p2p_passed are backfilled by the separate scoring
    # step; null here means "not yet evaluated", not "failed".
    writer.emit(
        "run_summary",
        wall_clock_ms=wall_clock_ms,
        resolved=None,
        patch_size_lines=patch_size_lines,
        f2p_passed=None,
        p2p_passed=None,
    )
    writer.close()

    result = {
        "run_id": run_id,
        "arm": job.spec.arm,
        "condition": job.spec.condition,
        "instance_id": job.task_id,
        "agent_id": job.agent_id,
        "model_name_or_path": f"{run_id}_{job.spec.arm}_{job.agent_id}",
        "model": job.spec.model_name,
        "model_patch": patch,
        "exit_status": info.get("exit_status", ""),
        "cost": round(getattr(agent, "cost", 0.0), 6),
        "n_calls": getattr(agent, "n_calls", 0),
        "wall_clock_ms": wall_clock_ms,
        "patch_size_lines": patch_size_lines,
        "error": error,
    }
    path = result_path(results_dir, job)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(result, indent=2), encoding="utf-8")
    tmp.replace(path)  # atomic: a half-written file would break resume
    logger.info(
        "%s done exit=%s cost=$%.4f calls=%d patch_lines=%d %.1fs",
        job.label, result["exit_status"], result["cost"], result["n_calls"],
        patch_size_lines, wall_clock_ms / 1000,
    )
    return result


# --------------------------------------------------------------------------- #
# predictions
# --------------------------------------------------------------------------- #


def collect_results(results_dir: Path, arm: str) -> list[dict[str, Any]]:
    """Read every persisted result for ``arm``, including ones from earlier runs."""
    results = []
    for path in sorted((results_dir / arm).glob("*/*.json")):
        try:
            results.append(json.loads(path.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            logger.warning("skipping unreadable result file %s", path)
    return results


def write_predictions(results_dir: Path, arm: str) -> tuple[Path, list[Path]]:
    """Write SWE-bench predictions for ``arm``.

    Two shapes, because the harness keys predictions by ``instance_id`` and would
    silently collapse twenty candidates for the same instance:

    * ``preds_<arm>.json`` -- every candidate, for analysis and archival.
    * ``preds_<arm>_<agent_id>.json`` -- one candidate per instance, which is what
      ``run_evaluation`` actually consumes.
    """
    results = collect_results(results_dir, arm)
    combined_path = results_dir / f"preds_{arm}.json"
    combined = [
        {
            "instance_id": r["instance_id"],
            "model_name_or_path": r["model_name_or_path"],
            "model_patch": r["model_patch"],
        }
        for r in results
    ]
    combined_path.write_text(json.dumps(combined, indent=2), encoding="utf-8")

    per_agent: dict[str, list[dict[str, Any]]] = {}
    for result, prediction in zip(results, combined):
        per_agent.setdefault(result["agent_id"], []).append(prediction)
    agent_paths = []
    for agent_id, predictions in sorted(per_agent.items()):
        path = results_dir / f"preds_{arm}_{agent_id}.json"
        path.write_text(json.dumps(predictions, indent=2), encoding="utf-8")
        agent_paths.append(path)
    logger.info("wrote %d predictions for arm %s to %s", len(combined), arm, combined_path)
    return combined_path, agent_paths


def print_evaluation_commands(run_id: str, arm: str, agent_paths: list[Path], instances: list[str]) -> None:
    """Print the exact scoring commands. Scoring is a separate step; never run here."""
    print(f"\n# scoring for arm {arm} ({len(agent_paths)} candidate sets) -- run these separately:")
    for path in agent_paths:
        agent_id = path.stem.rsplit("_", 2)[-2] + "_" + path.stem.rsplit("_", 1)[-1]
        print(
            "python -m swebench.harness.run_evaluation"
            " --dataset_name princeton-nlp/SWE-bench_Lite"
            f" --predictions_path {path}"
            " --cache_level instance --max_workers 1"
            f" --instance_ids {' '.join(instances)}"
            f" --run_id {run_id}_{arm}_{agent_id}"
        )


# --------------------------------------------------------------------------- #
# orchestration
# --------------------------------------------------------------------------- #


@dataclass
class RunStats:
    """Counters for one invocation."""

    completed: int = 0
    skipped: int = 0
    failed: int = 0
    cost: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, *, completed: int = 0, skipped: int = 0, failed: int = 0, cost: float = 0.0) -> None:
        with self.lock:
            self.completed += completed
            self.skipped += skipped
            self.failed += failed
            self.cost += cost


def build_jobs(spec: ArmSpec, instances: list[dict[str, Any]], n_agents: int) -> list[Job]:
    """Enumerate every (instance, agent) pair for one arm."""
    agents = spec.n_agents if spec.condition == "baseline" else n_agents
    return [
        Job(spec, instance, f"agent_{i:02d}")
        for instance in instances
        for i in range(agents)
    ]


def run_arm(spec: ArmSpec, instances: list[dict[str, Any]], args: argparse.Namespace, run_root: Path,
            telemetry_root: Path, stop: threading.Event) -> RunStats:
    """Run every job for one arm under an adaptive concurrency governor."""
    results_dir = run_root
    jobs = build_jobs(spec, instances, args.agents)
    pending = [job for job in jobs if not result_path(results_dir, job).exists()]
    stats = RunStats(skipped=len(jobs) - len(pending))
    if stats.skipped:
        logger.info("arm %s: skipping %d already-complete agents (resume)", spec.arm, stats.skipped)
    logger.info("arm %s: %d agents to run (%s, %s)", spec.arm, len(pending), spec.condition, spec.model_name)

    governor = ConcurrencyGovernor(args.concurrency)

    def worker(job: Job) -> None:
        for attempt in range(args.max_retries + 1):
            if stop.is_set():
                return
            if args.budget_usd and stats.cost >= args.budget_usd:
                logger.error("global budget $%.2f exhausted; not starting %s", args.budget_usd, job.label)
                return
            if not governor.acquire(stop):
                return
            try:
                result = run_job(
                    job, args.run_id, results_dir, telemetry_root,
                    step_limit=args.step_limit, wall_time_limit=args.wall_time_limit,
                )
            except JobFailed as failure:
                stats.add(cost=float(failure.result.get("cost") or 0.0))
                if is_rate_limit_error(failure.cause) and attempt < args.max_retries and not stop.is_set():
                    governor.release()
                    governor.record_rate_limit()
                    logger.warning("%s hit back-pressure; retry %d/%d", job.label, attempt + 1, args.max_retries)
                    continue
                stats.add(failed=1)
                return
            except BaseException:  # pragma: no cover - defensive; keep the swarm alive
                logger.exception("unexpected error running %s", job.label)
                stats.add(failed=1)
                return
            else:
                stats.add(completed=1, cost=float(result.get("cost") or 0.0))
                governor.record_success()
                return
            finally:
                governor.release()

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = {pool.submit(worker, job): job for job in pending}
        try:
            for future in concurrent.futures.as_completed(futures):
                future.result()
        except KeyboardInterrupt:
            logger.warning("interrupted: cancelling pending agents (^C again to exit hard)")
            stop.set()
            governor.wake()
            for future in futures:
                future.cancel()
            raise
    return stats


def write_run_metadata(run_root: Path, args: argparse.Namespace, specs: list[ArmSpec],
                       instances: list[dict[str, Any]]) -> None:
    """Record what this run was, so later comparisons do not rely on memory."""
    metadata = {
        "run_id": args.run_id,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "instances": [str(i["instance_id"]) for i in instances],
        "images": [get_swebench_docker_image_name(i) for i in instances],
        "arms": [
            {
                "arm": s.arm,
                "condition": s.condition,
                "agents": s.n_agents if s.condition == "baseline" else args.agents,
                "model": s.model_name,
                "cost_limit": s.cost_limit,
            }
            for s in specs
        ],
        "step_limit": args.step_limit,
        "wall_time_limit_seconds": args.wall_time_limit,
        "concurrency": args.concurrency,
        "budget_usd": args.budget_usd,
    }
    path = run_root / "run_metadata.json"
    path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    logger.info("wrote %s", path)


def redact(config: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of ``config`` safe to log (no secrets are stored in it anyway)."""
    safe = json.loads(json.dumps(config, default=str))
    env = safe.get("environment", {}).get("env", {})
    for key in list(env):
        if "URI" in key or "KEY" in key or "TOKEN" in key:
            env[key] = "<redacted>"
    for section in ("agent",):
        template = safe.get(section, {}).get("system_template")
        if isinstance(template, str) and len(template) > 400:
            safe[section]["system_template"] = template[:400] + f"... (+{len(template) - 400} chars)"
    safe.get("agent", {}).pop("instance_template", None)
    safe.get("model", {}).pop("observation_template", None)
    safe.get("model", {}).pop("format_error_template", None)
    return safe


def dry_run(specs: list[ArmSpec], instances: list[dict[str, Any]], args: argparse.Namespace,
            run_root: Path, telemetry_root: Path) -> None:
    """Assemble and print every distinct config without touching Docker or the API."""
    telemetry_dir = telemetry_root / args.run_id
    for spec in specs:
        agents = spec.n_agents if spec.condition == "baseline" else args.agents
        jobs = build_jobs(spec, instances, args.agents)
        print(f"\n===== arm {spec.arm} ({spec.condition}) : {agents} agents x {len(instances)} instances "
              f"= {len(jobs)} runs =====")
        for instance in instances:
            print(f"  image {get_swebench_docker_image_name(instance)}")
        for job in (jobs[0], jobs[-1]):
            config = build_config(
                job, args.run_id, telemetry_dir,
                step_limit=args.step_limit, wall_time_limit=args.wall_time_limit,
            )
            print(f"\n--- {job.label} -> {result_path(run_root, job)} ---")
            print(json.dumps(redact(config), indent=2))
        databases = sorted({spec.database(args.run_id, j.agent_id) or "<none>" for j in jobs})
        print(f"\n  databases: {databases[0]}" + (f" ... {databases[-1]} ({len(databases)} total)"
                                                  if len(databases) > 1 else ""))
    print("\ndry run: no containers started, no API calls made, nothing written.")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run-id", required=True, help="Run identifier; also prefixes the MongoDB database names")
    parser.add_argument("--arm", choices=["A", "B", "C", "all"], default="all", help="Which arm(s) to run")
    parser.add_argument("--instances", nargs="+", default=list(DEFAULT_INSTANCES), help="SWE-bench Lite instance ids")
    parser.add_argument("--agents", type=int, default=20, help="Agents per instance for arms A and B")
    parser.add_argument("--concurrency", type=int, default=4, help="Maximum agents in flight (ramped up to)")
    parser.add_argument("--max-retries", type=int, default=2, help="Retries per agent on provider back-pressure")
    parser.add_argument("--step-limit", type=int, default=60, help="Maximum LM calls per agent")
    parser.add_argument("--wall-time-limit", type=int, default=900, help="Per-agent wall-clock cap in seconds")
    parser.add_argument("--budget-usd", type=float, default=0.0, help="Global spend cap for this invocation (0 = off)")
    parser.add_argument("--subset", default=DEFAULT_SUBSET, help="SWE-bench subset")
    parser.add_argument("--split", default=DEFAULT_SPLIT, help="Dataset split")
    parser.add_argument("--results-root", default=str(REPO_ROOT / "results"), help="Root for per-run results")
    parser.add_argument("--telemetry-root", default=str(REPO_ROOT / "telemetry"), help="Root for per-run telemetry")
    parser.add_argument("--dry-run", action="store_true", help="Assemble configs and exit without running anything")
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    )
    os.environ.setdefault("MSWEA_SILENT_STARTUP", "1")

    if loaded := load_env_file(ENV_FILE):
        logger.info("loaded %d variables from %s: %s", len(loaded), ENV_FILE, ", ".join(sorted(loaded)))

    specs = [ARMS[args.arm]] if args.arm != "all" else [ARMS["A"], ARMS["B"], ARMS["C"]]
    needs_mongo = any(s.condition != "baseline" for s in specs)
    if missing := check_secrets(needs_mongo=needs_mongo):
        message = f"missing required environment variables: {', '.join(missing)}"
        if not args.dry_run:
            raise SystemExit(message)
        logger.warning("%s (tolerated for --dry-run)", message)

    instances = load_instances(args.instances, args.subset, args.split)
    run_root = Path(args.results_root) / args.run_id
    telemetry_root = Path(args.telemetry_root)

    if args.dry_run:
        dry_run(specs, instances, args, run_root, telemetry_root)
        return 0

    run_root.mkdir(parents=True, exist_ok=True)
    (telemetry_root / args.run_id).mkdir(parents=True, exist_ok=True)
    write_run_metadata(run_root, args, specs, instances)

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    exit_code = 0
    totals = RunStats()
    try:
        for spec in specs:
            if stop.is_set():
                break
            # Arms run sequentially: a shared box makes wall-clock time
            # incomparable across conditions, and wall-clock is a reported metric.
            stats = run_arm(spec, instances, args, run_root, telemetry_root, stop)
            totals.add(completed=stats.completed, skipped=stats.skipped, failed=stats.failed, cost=stats.cost)
            _, agent_paths = write_predictions(run_root, spec.arm)
            print_evaluation_commands(args.run_id, spec.arm, agent_paths, [str(i["instance_id"]) for i in instances])
    except KeyboardInterrupt:
        logger.warning("interrupted; writing predictions for whatever finished")
        for spec in specs:
            if (run_root / spec.arm).exists():
                write_predictions(run_root, spec.arm)
        exit_code = 130

    logger.info(
        "run %s: %d completed, %d skipped (resume), %d failed, $%.2f spent",
        args.run_id, totals.completed, totals.skipped, totals.failed, totals.cost,
    )
    print(f"\ntelemetry: {telemetry_root / args.run_id}/agent_*.jsonl")
    print(f"validate:  python runner/telemetry.py {telemetry_root} {args.run_id}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
