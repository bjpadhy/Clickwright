# Analytics Agent Report

Autonomous insight report over the 8 base tables — responses to the 4 standard probes.

## Standard Probes

Run these against the existing tables via the Chat UI or CLI:

1. *"Analyze the existing funnel and surface the most important issues, with the why."*
2. *"Where are we losing conversions, and for which segments (device / geo / destination)?"*
3. *"Are there any regressions or trends over the last quarter?"*
4. *"Is anything in the base context wrong, stale, or self-contradictory?"*

## How to populate

1. Start the backend: `cd backend && npm run serve`
2. For each probe, create a conversation and ask the question
3. Save the full Insight JSON response as `probe_01.json`, `probe_02.json`, etc.
4. Save the Langfuse trace URL for each probe

Alternatively, use the CLI:
```bash
curl -X POST http://localhost:8787/api/conversations \
  -H 'Content-Type: application/json' -d '{"title":"probe_01"}'
# Use the returned conv_id to stream the answer
```
