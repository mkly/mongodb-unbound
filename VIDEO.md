# 60-second demo — shot list

Narration budget is ~150 words. Every second not spent on evidence is wasted.

**The thesis shot is beat 3**: one agent writes a document, a different agent's
`find` returns it. Structure alone (fields, types, fingerprints) only proves the
writes are documents. Retrieval across agents is what proves the store is
*shared*, which is the entire claim. Everything else is supporting.

## The cut

| # | Time | Visual | Narration |
|---|---|---|---|
| 1 | 0:00–0:07 | Full-screen terminal, `unbounded inspect` output already on screen. Slow scroll over the field names and BSON types. | "Nobody designed this schema. Eight agents invented it while fixing the same bug." |
| 2 | 0:07–0:16 | `swarm.py` launch command typed live, then `docker ps` showing 8 containers. | "Same bug, same prompt, one difference: half share a single MongoDB database, half each get their own." |
| 3 | 0:16–0:32 | Observatory **Activity** tab, streaming, **8× time-lapse**. Cursor rests on an `insert` by `agent_00`, then on a `find` by `agent_02` whose result contains that document. Highlight both rows. | "Every write is a document. Every read is a real query. Here agent 2 finds what agent 0 wrote — no shared prompt, no message passing, just the database." |
| 4 | 0:32–0:45 | **Schema** tab. Zoom on one fingerprint cluster listing two different agents. | "They converged on the same document shape without being told what shape to use. That hash is how we prove it — the same key joins the telemetry and the database." |
| 5 | 0:45–0:53 | **Operations** tab, read:write ratio visible. | "And they read more than they wrote. The store wasn't a log they appended to. They consulted it." |
| 6 | 0:53–1:00 | Static card, `RESULTS.md` open on the "Not measured" table. | "Resolution rate: the grading harness hasn't run yet. We've labelled it in progress rather than guess." |

## Why beat 6 stays

It costs 7 seconds and it is what the brief explicitly asked for ("label
unfinished comparisons honestly as in progress"). A hackathon demo that names
its own unmeasured quantity reads as more credible, not less, and it inoculates
against the first question a technical judge will ask.

## Honesty constraints, non-negotiable

- **Never say "converged on a fix."** The harness has not run. Say "the same
  conclusion about the bug," and show the documents.
- **Label the time-lapse on screen.** Beat 3 is sped up; a visible `8×` caption
  keeps it real footage rather than a misleading edit.
- **No private agent reasoning on screen.** Telemetry carries none by
  construction, so the observatory is safe to film as-is — but any terminal
  showing raw agent trajectories is not. Keep agent stdout out of frame.
- Everything filmed is real output from a real run against real Atlas. Nothing
  is mocked. If a beat can't be filmed, the beat gets cut, not faked.

## Blocker

**Beats 3, 4, and 5 cannot be filmed cleanly until the observatory stops mixing
arms.** `serve` watches per-agent telemetry files that now contain both
conditions, so the Activity and Operations tabs blend arm B into what presents
as a shared-arm view (pilot-003: 11 shared vs 7 isolated ops in one
`--db pilot-003_shared` session). Filming it as-is means either showing
contaminated numbers or narrating around them.

Fix, in preference order:

1. Pre-split telemetry by `condition` into per-arm files and point `serve` at
   the arm A set. No code change. Static rather than live-streaming, which is
   fine because beat 3 is time-lapsed anyway.
2. Add `--condition` to `serve` and rebuild `dist/unbounded-serve` only. Cleaner
   and keeps live SSE. `dist/unbounded-serve` is the safe rebuild target;
   `dist/unbounded` is bind-mounted into running containers and must not be
   touched mid-run.

## Recording setup

- 1920×1080, OBS full-screen capture. One continuous take per beat, cut in post.
- Terminal at **18pt minimum**, dark theme. Small text turns to mush under
  compression and the field names in beat 1 are the whole point of the shot.
- Hide the Atlas connection string and any `.env` from frame.
- Record 90–120 seconds of raw material per beat so the edit has slack.
- Narration recorded separately, not live — a stumble shouldn't cost a take.
