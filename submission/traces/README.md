# Langfuse Traces

Shared or exported traces for each agent execution.

## Required traces

| Trace | Status |
|-------|--------|
| Spec 01–05 instrumentation runs | TODO |
| Spec 06 (surprise round) — **mandatory** | TODO |
| Standard probes (4 analytics runs) | TODO |

## How to export

**Option 1: Public URL (easiest)**
1. Open Langfuse dashboard → Traces → click the trace
2. Click Share → toggle "Make public" → copy URL
3. Save the URL in a `.txt` file here

**Option 2: JSON export**
```bash
curl -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/traces/<TRACE_ID>" -o spec_01_trace.json
```

## Finding trace IDs

Trace URLs are printed when running specs:
```
▶ run run_xyz · trace https://cloud.langfuse.com/trace/abc123
```

Or query from ClickHouse:
```sql
SELECT run_id, name,
       JSONExtractString(payload, 'traceUrl') AS trace_url
FROM runs_log
WHERE type = 'status' AND name = 'running'
ORDER BY ts DESC
```
