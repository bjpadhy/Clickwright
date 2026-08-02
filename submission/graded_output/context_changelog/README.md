# Context Layer Changelog

Before/after changelog demonstrating how `context_store` updates when new tables are added.

## How to populate

Export the changelog after running specs:

```bash
# Markdown export via the API
curl http://localhost:8787/api/observe/changelog/export -o changelog.md

# Or JSON
curl http://localhost:8787/api/observe/changelog -o changelog.json
```

The changelog merges two sources:
- `context_store` — who changed which definition, when, and why (with version numbers)
- `runs_log` — which run created which tables, who approved it, trace URL

Each entry shows:
- Context version (v1.0, v1.1, ...)
- Which entities were created or superseded
- Whether any contradiction was surfaced
- Link to the Langfuse trace
