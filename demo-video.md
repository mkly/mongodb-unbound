# Unbounded: One-Minute Demo Video

## Goal

Show how twenty small AI agents use MongoDB as shared memory, invent their own coordination patterns, and solve a software bug as a swarm.

## Storyboard and voiceover

| Time | On screen | Voiceover |
|---|---|---|
| 0:00–0:06 | Open on a software bug, then pull back to a grid of 20 agent terminals. | “Twenty AI agents get the same software bug.” |
| 0:06–0:15 | Highlight each agent’s separate worktree, shell, and shared MongoDB connection. | “We give each one its own codebase, a shell, and one shared MongoDB database.” |
| 0:15–0:24 | Show the short agent prompt, followed by `unbounded insert`, `find`, and `inspect`. | “We leave roles and workflow open. The agents get raw storage primitives and decide how to work together.” |
| 0:24–0:36 | Cut between live agent activity and MongoDB documents appearing. Zoom in on shared findings, tasks, status fields, and agent IDs. | “Agents write findings, divide work, check hypotheses, and create structure as they go. They choose the schema.” |
| 0:36–0:46 | Show candidate patches arriving, then tests turning green. | “Each agent submits a patch. The benchmark tests every candidate and records the first successful fix.” |
| 0:46–0:55 | Reveal a simple comparison: shared swarm, isolated agents, and one frontier model. Show success, time, and cost. | “We compare shared memory with isolated agents and a frontier model across success, time, token cost, and duplicated work.” |
| 0:55–1:00 | End card: **Unbounded** over a MongoDB document stream connecting the agents. | “Unbounded asks whether small models need a bigger brain, or a place to think together.” |

## Recording notes

- Keep the terminal grid legible by spotlighting two or three agents while the rest remain in motion.
- Use a real MongoDB collection view for the central reveal. Highlight fields that multiple agents adopted without instructions.
- Replace the comparison card with measured run data. If results are pending, label the card **Experiment in progress** and show the metrics being captured.
- Use quick cuts through the setup, then hold on the shared-memory activity long enough for viewers to understand it.
- Finish on the project name, MongoDB, and the repository URL.
