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

  unbounded insert <collection> <document>     insert one document
  unbounded find <collection> <filter>         find documents; filter required, '{}' matches all
  unbounded get <collection> <id>              get one document by _id
  unbounded update <collection> <id> <document>  update one document by _id
  unbounded delete <collection> <id>           delete one document by _id
  unbounded sample <collection>                bounded random sample of documents
  unbounded inspect <collection>               observed fields, BSON types, and document shapes

Whatever is already stored may have been written by other engineers working in
parallel, and whatever you write remains after you finish. No collection names,
schema, or format are prescribed; `inspect` and `sample` are how you find out
what is there."""


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
