# Standard Probe Outputs

Responses to the 4 standard evaluation prompts, each with its Langfuse trace.

## Probes

| # | Prompt | Output file | Trace file |
|---|--------|-------------|------------|
| 1 | "Analyze the existing funnel and surface the most important issues, with the why." | `probe_01_funnel.json` | `probe_01_trace.txt` |
| 2 | "Where are we losing conversions, and for which segments (device / geo / destination)?" | `probe_02_segments.json` | `probe_02_trace.txt` |
| 3 | "Are there any regressions or trends over the last quarter?" | `probe_03_trends.json` | `probe_03_trace.txt` |
| 4 | "Is anything in the base context wrong, stale, or self-contradictory?" | `probe_04_context.json` | `probe_04_trace.txt` |

## How to populate

Run each probe via the Chat UI or CLI and save:
- The full `Insight` JSON response
- The Langfuse trace URL (printed in the SSE stream's `start` event)
