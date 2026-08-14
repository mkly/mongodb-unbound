┌───────────┬────────────────────────────┬──────────────────────────────────────────────────────────┐
│   Time    │             Do             │                           Say                            │
├───────────┼────────────────────────────┼──────────────────────────────────────────────────────────┤
│ 0:00–0:10 │ docker ps command          │ "Twenty agents, same bug, running right now. Each one    │
│           │                            │ isolated in its own container."                          │
├───────────┼────────────────────────────┼──────────────────────────────────────────────────────────┤
│           │ Switch to browser,         │ "They share one MongoDB database. Every row here is a    │
│ 0:10–0:25 │ Activity tab, live rows    │ real write or a real query — agent by agent, live."      │
│           │ appearing                  │                                                          │
├───────────┼────────────────────────────┼──────────────────────────────────────────────────────────┤
│           │ unbounded inspect in       │ "Nobody gave them a schema. These field names are theirs │
│ 0:25–0:42 │ terminal, scroll the field │  — and three-quarters of them independently chose the    │
│           │  list                      │ same ones."                                              │
├───────────┼────────────────────────────┼──────────────────────────────────────────────────────────┤
│ 0:42–0:55 │ Browser, Schema tab        │ "The database reveals the structure they converged on."  │
├───────────┼────────────────────────────┼──────────────────────────────────────────────────────────┤
│ 0:55–1:00 │ Stop on Schema tab         │ "Not agents appending to a scratchpad. Queryable         │
│           │                            │ documents, and an emergent schema."                      │
└───────────┴────────────────────────────┴──────────────────────────────────────────────────────────┘
