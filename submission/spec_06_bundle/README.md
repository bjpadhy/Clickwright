# 6th Spec Bundle

The surprise-round spec — schema, insight summary, and trace.

## Contents (to be added after running)

- `schema.sql` — Generated CREATE TABLE DDL for spec 06
- `insight_summary.md` — Agent-written insight summary (product-audience focused)
- `trace.json` — Exported Langfuse trace for the full run

## How to populate

```bash
# 1. Run spec 06
cd backend
npx tsx scripts/run-instrumentation.ts ../specs/06_smart_document_retry --yes
# Note the trace URL printed: ▶ run ... · trace https://cloud.langfuse.com/trace/...

# 2. Export DDL
# Query ClickHouse for CREATE TABLE statements from this spec's tables

# 3. Ask an analytics question about the new tables
# Save the Insight response as insight_summary.md

# 4. Export the trace
curl -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/traces/<TRACE_ID>" -o trace.json
```
