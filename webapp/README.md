# Clickwright — webapp

Frontend for the Clickwright pipeline (design incoming).

Planned screens:
- **Run view** — spec upload, live pipeline stepper, DDL + context approval gates, trap strip
- **Chat** — the Analytics Agent: PM questions in, cited answers out
- **Runs history** — all runs, compare mode, Langfuse deep links
- **Context browser** — versioned knowledge store with per-entity diffs

Talks to `../backend` (thin HTTP/SSE server around the agents — to be added there).
