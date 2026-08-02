# How to Run Clickwright

## Prerequisites

- **Node.js 20+** (`nvm use` reads `.nvmrc`)
- **ClickHouse Cloud** instance with HTTPS endpoint
- **Langfuse Cloud** account (free tier works)
- **Anthropic API key** (or Claude Code OAuth login)

## Setup

```bash
# 1. Clone and install
git clone https://github.com/bjpadhy/Clickwright.git
cd Clickwright/backend
npm install

# 2. Configure environment
cp .env.example .env
# Fill in your credentials:
#   CLICKHOUSE_URL      — https://xxxxx.region.clickhouse.cloud:8443
#   CLICKHOUSE_PASSWORD — from ClickHouse Cloud console
#   LANGFUSE_PUBLIC_KEY — from Langfuse project settings
#   LANGFUSE_SECRET_KEY — from Langfuse project settings
#   ANTHROPIC_API_KEY   — from Anthropic console

# 3. Verify everything connects
npm run check-env
# All three (ClickHouse, LLM, Langfuse) must show green ✓

# 4. Seed the knowledge store (one-time)
npm run seed
```

## Single-Command Pipeline Run

```bash
# Run one spec end-to-end (auto-approve both human gates):
npx tsx scripts/run-instrumentation.ts ../specs/01_express_checkout --yes
```

This executes the full pipeline: **profile → design schema → create tables → load data → verify row counts → update context store** — with every step traced in Langfuse.

## Run All 6 Specs

```bash
for spec in ../specs/0{1,2,3,4,5,6}_*; do
  echo "═══ Running $(basename $spec) ═══"
  npx tsx scripts/run-instrumentation.ts "$spec" --yes
done
```

## Start the Web UI

```bash
# Terminal 1 — backend
cd backend && npm run serve    # http://localhost:8787

# Terminal 2 — frontend
cd webapp && npm install && npm run dev   # http://localhost:5173
```

The webapp proxies `/api` requests to the backend. Use `npm run serve` (not `npm run dev`) for long runs — `dev` restarts on file changes which would abandon an active run.

## Analytics Agent (Chat)

Once tables are instrumented, open the Chat screen in the webapp and ask questions. Example probes:

1. *"What are the critical funnel drop-off points and what's causing them?"*
2. *"Where are we losing conversion — break down by device, geography, and destination"*
3. *"Are there any regressions or emerging trends in the data?"*
4. *"How does Express Checkout conversion compare to standard checkout?"*

Each answer runs the full pipeline: plan → SQL → execute → verify → narrate — with every number citation-checked against SQL results.

## CLI Analytics (headless)

```bash
# Ask a question without the UI:
curl -N -X POST http://localhost:8787/api/conversations \
  -H 'Content-Type: application/json' -d '{"title":"probe"}' | jq -r '.id'

# Then stream the answer:
curl -N -X POST "http://localhost:8787/api/conversations/<CONV_ID>/messages" \
  -H 'Content-Type: application/json' \
  -d '{"question":"What are the critical funnel drop-off points?"}'
```

## Langfuse Traces

Every run and every chat answer creates a Langfuse trace. To access:

1. Open your Langfuse dashboard at `LANGFUSE_BASE_URL`
2. Traces are named `pipeline:<spec>` (instrumentation) and `chat:<question>` (analytics)
3. To share: click a trace → Share → toggle Public → copy URL

Trace URLs are also stored in `runs_log` and shown in the UI run history.

## Useful Commands

| Command | What it does |
|---|---|
| `npm run check-env` | Verify all connections |
| `npm run seed` | Seed context_store from base_context.md |
| `npm run serve` | Start backend (stable, no hot-reload) |
| `npm run dev` | Start backend (hot-reload on .ts + prompt changes) |
| `npm run reset -- --all` | Full reset (tables + context + history + chat) |
| `npm run reset -- --dry-run` | Preview what reset would do |
| `npm test` | Run unit tests |
| `npm run typecheck` | TypeScript check |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CLICKHOUSE_URL` | Yes | ClickHouse Cloud HTTPS endpoint |
| `CLICKHOUSE_USER` | No | Default: `default` |
| `CLICKHOUSE_PASSWORD` | Yes | ClickHouse password |
| `CLICKHOUSE_DATABASE` | No | Default: `default` |
| `LANGFUSE_PUBLIC_KEY` | Yes | Langfuse project public key |
| `LANGFUSE_SECRET_KEY` | Yes | Langfuse project secret key |
| `LANGFUSE_BASE_URL` | No | Default: `https://cloud.langfuse.com` |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key (*or use Claude Code OAuth) |
| `CLICKWRIGHT_MODEL` | No | Default: `claude-sonnet-5` |
