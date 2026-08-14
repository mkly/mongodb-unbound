"""System prompts for the shared-memory pilot.

Three arms:
  shared   - 20 agents, all pointed at ONE MongoDB database
  isolated - 20 agents, each pointed at its OWN private database
  baseline - a single agent with no memory tool at all

THE INVARIANT: `shared` and `isolated` MUST get a byte-identical prompt.
The only difference between those two arms is which database the launcher
points the `unbounded` binary at (via environment variables). If the prompt
text differs at all, the experiment varies two things at once and the result
is uninterpretable. Never add a "you are sharing with others" / "this is
private" distinction here, and never interpolate an agent id, role, or
database name into the prompt. That is why the memory text lives in a single
constant used by both arms.

SECOND CONSTRAINT: expose storage primitives, not a coordination protocol.
Do not tell agents to coordinate, divide labor, take roles, follow naming
conventions, or write any particular schema. Whether conventions emerge is
what the experiment measures; prescribing them destroys the finding.

The returned string is merged over mini-swe-agent's builtin swebench.yaml as
`agent.system_template`. That file's `instance_template` already carries all
task instructions, workflow, and the submission protocol - do not restate any
of it here. It is a Jinja2 template, so avoid `{{` and `{%` sequences.
"""

from __future__ import annotations

from typing import Final

CONDITIONS: Final[tuple[str, ...]] = ("shared", "isolated", "baseline")

#: Base text, used by every arm. Matches the builtin swebench.yaml system prompt.
BASE_PROMPT: Final[str] = (
    "You are a helpful assistant that can interact with a computer shell to "
    "solve programming tasks."
)

#: Memory section. Appended VERBATIM for both `shared` and `isolated`, omitted
#: for `baseline`. Single edit point - changing this changes both arms at once,
#: which is the only safe way to change it.
MEMORY_PROMPT: Final[str] = """\
You also have `unbounded`, a document store that persists after this task ends.
It is already configured from the environment; never pass --uri or --db.
Documents and filters are MongoDB Extended JSON. Each command prints one line of
JSON: on success {"ok":true,"data":...}, on failure {"ok":false,"error":...}.

Every document goes in one place; there is nothing to name or create first.

  unbounded insert <document>          insert one document
  unbounded find <filter>              find documents; filter required, '{}' matches all
  unbounded get <id>                   get one document by _id
  unbounded update <id> <document>     update one document by _id
  unbounded delete <id>                delete one document by _id
  unbounded sample                     bounded random sample of documents
  unbounded inspect                    observed fields, BSON types, and document shapes

Whatever is already stored may have been written by other engineers working in
parallel, and whatever you write remains after you finish. No schema or format
is prescribed; `inspect` and `sample` are how you find out what is there."""


#: Task-level reminder, appended to `agent.instance_template`. Appended VERBATIM
#: for both `shared` and `isolated`, omitted for `baseline` -- same single edit
#: point discipline as MEMORY_PROMPT.
#:
#: This exists because the builtin swebench.yaml carries a one-line system prompt
#: and puts all workflow direction in the instance template. A memory section
#: stated once at the top and never again is placement a small model will ignore:
#: a 40-step smoke run of qwen3-coder-30b touched `unbounded` zero times. If the
#: agents never use memory, the shared and isolated arms are identical by
#: construction and the pilot measures nothing.
#:
#: It instructs WHEN to reach for memory, never WHAT to store. Document shape and
#: wording are what the experiment measures, so prescribing them would destroy
#: the result.
#:
#: The list of moments is deliberate. An earlier version said only "before you
#: submit, record what you learned", which is a two-write protocol -- read once,
#: write once -- and that is exactly what the agents did: pilot-003 produced ~1
#: document per agent, all of them end-of-run summaries carrying `task`,
#: `analysis`, `solution`, `test_results`. One document per agent is too sparse
#: to show adoption or convergence over time, because nothing is ever written
#: while another agent is still working. Naming the moments raises write
#: frequency without touching document shape: WHEN, still never WHAT.
#:
#: Note the cost -- every `unbounded` call spends one step from `--step-limit`.
#: Raise the limit when raising write frequency, or the extra writes come
#: straight out of the budget for solving the bug.
#:
#: THE READ SIDE NEEDS THE SAME TREATMENT. Naming five write moments against a
#: single read clause weights the prompt 5:1, and a measured ratio follows it
#: closely: an earlier run held 1.20:1 reads:writes, and the run after this list
#: was added inverted to 0.69:1 (42 reads, 61 writes across 20 agents). Every
#: agent used the store and every agent opened with a read -- then went
#: write-only. Reads were front-loaded into the first one or two operations and
#: almost never repeated.
#:
#: Three causes, only the first of which is the 5:1 weighting:
#:
#: 1. The prompt asked for more writes and left reads alone.
#: 2. The opening read returned an empty store. Under concurrency the first wave
#:    all query within seconds of each other, before anyone has written. A read
#:    that costs a step and returns nothing teaches the agent that reading does
#:    not pay, and it never tries again.
#: 3. Re-reading has no cheap trigger. Once an agent has read, it carries the
#:    content in context; a second read only pays if someone else wrote since,
#:    which the agent cannot know without spending a step to find out.
#:
#: Hence the three additions below, each aimed at one cause. All three are
#: WHEN/HOW guidance only -- naming conventions, title formats, and document
#: structure stay out, because prescribing structure manufactures the convergence
#: this pilot exists to observe.
#:
#: * "Finding nothing is a normal result" inoculates against cause 2. Stated
#:   outright because an agent that reads cost-for-nothing once stops entirely.
#: * "Look up the thing that broke, not the task" gives a recurring read trigger
#:   with a DIFFERENT query than the opening one, addressing cause 3. An agent
#:   stuck on an error has a concrete new thing to look up.
#: * The negative write criterion counters the amplification the five moments
#:   introduced; the list had no filter at all, which is how writes came to
#:   outnumber reads.
TASK_MEMORY_PROMPT: Final[str] = """\

Before you begin, check `unbounded` for anything relevant to this task; other
engineers may already have recorded something useful. Finding nothing is a normal
result, not a sign the store is broken or useless -- someone may write the thing
you needed a minute after you looked, so check again as you go.

Check again whenever you change direction, and especially whenever you get stuck.
When something breaks, look up the thing that broke -- the error text, the failing
test, the function you are stuck in -- rather than the task as a whole. Another
engineer who hit the same wall filed it under the wall, not under their task.

Record what you learn as you learn it, rather than saving it all for the end:
when you locate the relevant code, when a hypothesis is ruled out, when a test
fails or passes, when you edit a file, and when you finish. Anything you keep
only in your own context is lost when this task ends. Skip what another engineer
could not act on -- a mistake you corrected a minute later, or anything that only
makes sense inside your own session. Choose the structure and wording yourself."""


def build_instance_prompt(condition: str, base_template: str) -> str:
    """Return the `agent.instance_template` for `condition`.

    `base_template` is mini-swe-agent's builtin template, returned unchanged for
    the baseline arm. "shared" and "isolated" are byte-identical by construction.
    """
    if condition in ("shared", "isolated"):
        return f"{base_template}\n{TASK_MEMORY_PROMPT}\n"
    if condition == "baseline":
        return base_template
    raise ValueError(
        f"unknown condition {condition!r}; expected one of {CONDITIONS}"
    )


def build_system_prompt(condition: str) -> str:
    """Return the complete `agent.system_template` string for `condition`.

    `condition` must be one of "shared", "isolated", or "baseline".
    "shared" and "isolated" return byte-identical strings by construction.
    """
    if condition in ("shared", "isolated"):
        return f"{BASE_PROMPT}\n\n{MEMORY_PROMPT}\n"
    if condition == "baseline":
        return f"{BASE_PROMPT}\n"
    raise ValueError(
        f"unknown condition {condition!r}; expected one of {CONDITIONS}"
    )


def _self_check() -> None:
    shared = build_system_prompt("shared")
    isolated = build_system_prompt("isolated")
    assert shared == isolated, (
        "INVARIANT VIOLATED: the 'shared' and 'isolated' prompts differ. "
        "These two arms must be byte-identical; the only permitted difference "
        "between them is which database the launcher points them at."
    )
    baseline = build_system_prompt("baseline")
    assert "unbounded" not in baseline, "baseline prompt must not mention the memory tool"
    assert "{{" not in shared and "{%" not in shared, "prompt contains Jinja2 syntax"


if __name__ == "__main__":
    _self_check()
    for _condition in CONDITIONS:
        print(f"===== {_condition} =====")
        print(build_system_prompt(_condition))
    print("===== self-check: shared == isolated OK =====")
