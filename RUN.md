# How to Run Clickwright

Two ways to run it: **Docker** (whole app, one command) or **Node locally** (two
terminals, plus the CLI for headless runs). Both need the same credentials, so
start with Configure.

## Prerequisites

- **ClickHouse Cloud** instance with an HTTPS endpoint, holding the 8 provided event tables
- **Langfuse Cloud** account (free tier works)
- **A model credential** — a free Google Gemini API key (recommended: fastest, no
  card), an Anthropic API key, or a Claude Code OAuth token
- Then either:
  - **Docker** with Compose v2 (`docker compose version`), or
  - **Node.js 20+** (`nvm use` reads `.nvmrc` → 20.20.2)

## 1. Configure

Credentials live in `backend/.env` for both paths.

```bash
git clone https://github.com/bjpadhy/Clickwright.git
cd Clickwright
cp backend/.env.example backend/.env
```

Fill it in:

```
CLICKHOUSE_URL      — https://xxxxx.region.clickhouse.cloud:8443
CLICKHOUSE_PASSWORD — from the ClickHouse Cloud console
CLICKHOUSE_DATABASE — the database holding the 8 event tables
LANGFUSE_PUBLIC_KEY — from Langfuse project settings
LANGFUSE_SECRET_KEY — from Langfuse project settings
GEMINI_API_KEY      — Google AI Studio → "Get API key" (free, no card)
ANTHROPIC_API_KEY   — from the Anthropic console (alternative to Gemini)
```

**On the model credential.** The backend picks a provider in this order:

1. `LLM_PROVIDER` when you set it explicitly (`gemini` | `anthropic` | `anthropic-oauth`)
2. a real `GEMINI_API_KEY` → **Gemini** over its OpenAI-compatible endpoint
3. a real `ANTHROPIC_API_KEY` → the **Anthropic API**
4. neither → the **Claude Agent SDK**, authenticating with the machine's Claude Code login

A short placeholder like the `sk-ant-` shipped in `.env.example` does not count as
a key. `GET /api/health` reports which backend actually resolved.

Gemini is the recommended default: `gemini-3.1-flash-lite` answers a question in
roughly a quarter of the time the Agent SDK path takes, and the free tier (≈ 15
requests/min, 1,500/day — one question is 5–7 calls) is enough for a demo.
Check `GEMINI_MODEL` before a demo: the newest Gemini models can carry a very low
free-tier **daily** cap that a single run exhausts (measured 21 Sep 2026:
`gemini-3.8-flash` allows 20 requests/day), and the run then dies in rate-limit
retries. Switch `GEMINI_MODEL` to a model on the normal quota if that happens. Google
may use free-tier prompts to improve its models; the pipeline sends schema, SQL
and aggregates, never user PII. Upgrading the key to a paid tier removes the rate
limit if you need two people asking at once.

The Claude Code fallback (option 4) works locally but **not in Docker** — a
container cannot complete an interactive login. For Docker, set `GEMINI_API_KEY`,
a real `ANTHROPIC_API_KEY`, or a `CLAUDE_CODE_OAUTH_TOKEN`, or the app will start
cleanly and then fail on the first agent call.

## 2. Run

### Option A — Docker (one command)

```bash
# from the repo root, with backend/.env filled in
docker compose up --build      # first run; plain `docker compose up` afterwards
```

Open **http://localhost:5173**.

The backend starts first and the webapp waits for it. The health check calls
`/api/health`, which runs `SELECT version()` against ClickHouse, so the UI is
only served once the database is genuinely reachable — if it never goes healthy,
your ClickHouse credentials are wrong and `docker compose logs backend` will say
so. nginx in the webapp container proxies every `/api/*` call to the backend over
the internal network, so the browser talks to one origin and there is no API URL
to configure.

The backend is also published on `localhost:8787` for `curl` and the API docs.

```bash
docker compose logs -f backend    # follow agent output
docker compose down               # stop
```

### Option B — Node locally

```bash
# Terminal 1 — backend
cd backend && npm install && npm run serve     # http://localhost:8787

# Terminal 2 — frontend
cd webapp && npm install && npm run dev        # http://localhost:5173
```

The Vite dev server proxies `/api` to `http://localhost:8787` (override with
`BACKEND_URL`). Use `npm run serve` rather than `npm run dev` for the backend
during long runs — `dev` restarts on file changes, which abandons an active run.

## 3. First-time setup

Run these once, after the backend can reach ClickHouse. Everything below assumes
you are in `backend/`; with Docker, prefix each with
`docker compose exec backend`.

```bash
npm run check-env    # ClickHouse, LLM and Langfuse must all show ✓
npm run seed         # seed context_store from base_context.md
```

`npm run seed` is **required before anything else is useful** — the agents read
every convention, join map and known issue from the context store, and nothing
seeds it automatically at startup. `check-env` also reports which of the 8
provided event tables it can see.

## Instrumentation

Turn a feature spec into live, loaded ClickHouse tables.

### From the UI

Instrumentation screen → pick a spec (or upload a new `spec.md` +
`events.ndjson`) → approve the two gates: the **DDL proposal**, then the
**context update**. Rejecting a gate is not a failure — the agent regenerates
with your feedback and asks again.

### From the CLI

```bash
cd backend
npx tsx scripts/run-instrumentation.ts ../specs/01_express_checkout --yes
```

`--yes` auto-approves both gates. Without it, each proposal is printed and the
run asks `y/N/reason-for-rejection` on stdin.

This executes the full pipeline: **profile → design schema → create tables →
load data → verify row counts → update context store**, every step traced in
Langfuse.

### The specs

Six, each a `spec.md` plus an `events.ndjson`. They are independent — run any
subset, in any order.

| Spec | Feature | Events |
|---|---|---|
| `01_express_checkout` | One-tap checkout for returning travellers | 5,507 |
| `02_group_family` | Group and family applications | 5,453 |
| `03_status_sharing` | Sharing application status | 6,503 |
| `04_abandoned_checkout_recovery` | Recovering abandoned checkouts | 5,919 |
| `05_instant_forex` | Instant forex at checkout | 6,237 |
| `06_unseen_data` | **The sealed sixth spec** — promo / coupon at checkout | 5,363 |

`06_unseen_data` is the held-out spec: same format as the other five, never seen
during development. It is the one to run to show the pipeline generalises, and
its output must be evidenced by a Langfuse trace.

### Run every spec

```bash
cd backend
for spec in ../specs/*/; do
  echo "═══ Running $(basename "$spec") ═══"
  npx tsx scripts/run-instrumentation.ts "$spec" --yes
done
```

A spec whose tables already exist is refused rather than duplicated. Clear one
first with `npx tsx scripts/reset-spec.ts 01_express_checkout`.

## Analytics Agent (Chat)

Once tables are instrumented, open the **Chat** screen and ask questions:

1. *"What are the critical funnel drop-off points and what's causing them?"*
2. *"Where are we losing conversion — break down by device, geography, and destination"*
3. *"Are there any regressions or emerging trends in the data?"*
4. *"How does Express Checkout conversion compare to standard checkout?"*

After running `06_unseen_data`, the questions its spec sets out:

5. *"What's the coupon apply rate, and what are the top reject reasons?"*
6. *"Do coupon users convert better than the no-coupon baseline?"*
7. *"Which codes drive volume, and which erode margin?"*

The empty-state chips are generated from the `Questions the PM will ask`
section of whichever specs you have instrumented, so they change as you run more.

Each answer runs plan → SQL → execute → verify → narrate, and every number is
citation-checked against the SQL results before it reaches you. An answer is
returned as named sections — what's happening, why it happens, the evidence,
what the context store already knew, and a recommended action — with a computed
confidence score and the exact queries behind it.

**Export PDF** in the chat header renders the whole conversation, insight cards
and all, through the browser's print dialog (choose "Save as PDF").

## The screens

| Screen | What it does |
|---|---|
| **Chat** | Ask questions; every answer is traced and citation-checked |
| **Instrumentation** | Run a spec, approve the DDL and context gates, browse run history |
| **Changelog** | Every schema change and context version, one stream, with a markdown export |

## CLI Analytics (headless)

```bash
# 1. create a conversation and capture its id
CONV=$(curl -s -X POST http://localhost:8787/api/conversations \
  -H 'Content-Type: application/json' -d '{"title":"probe"}' | jq -r '.id')

# 2. ask — the answer streams back as SSE (steps, then the insight)
curl -N -X POST "http://localhost:8787/api/conversations/$CONV/messages" \
  -H 'Content-Type: application/json' \
  -d '{"question":"What are the critical funnel drop-off points?"}'
```

A fresh answer takes roughly 40–70s; a repeat of the same question against
unchanged context is served from `insight_cache` in about a second.

## Langfuse Traces

Every run and every chat answer creates one trace.

1. Open your Langfuse project at `LANGFUSE_BASE_URL`
2. Traces are named `pipeline:<spec>` (instrumentation) and `chat:<question>` (analytics)
3. To share one: open it → Share → toggle Public → copy the URL

Trace URLs are also stored in `runs_log` and linked from run history and from
each insight card.

## Useful Commands

Run from `backend/`; with Docker, prefix with `docker compose exec backend`.

| Command | What it does |
|---|---|
| `npm run check-env` | Verify ClickHouse, LLM and Langfuse all connect |
| `npm run seed` | Seed `context_store` from `base_context.md` |
| `npm run serve` | Start the backend (stable, no hot-reload) |
| `npm run dev` | Start the backend (hot-reload on `.ts` + prompt changes) |
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript check |
| `npx tsx scripts/run-instrumentation.ts <specDir> [--yes]` | Run one spec end to end |
| `npx tsx scripts/reset-spec.ts <spec…>` | Drop one spec's tables and context rows |
| `npx tsx scripts/reset-spec.ts --orphans` | Drop tables left behind by a failed run |
| `npm run reset` | Reset every spec's tables + context, sweep orphans |
| `npm run reset -- --runs` | …and clear run history |
| `npm run reset -- --chat` | …and clear conversations, messages, insight cache |
| `npm run reset -- --all` | Everything above |
| `npm run reset -- --dry-run` | Show what a reset would do, change nothing |

The 8 provided event tables are never dropped by any reset.

## Environment Variables

Read by `backend/src/core/env.ts` unless noted.

| Variable | Required | Description |
|---|---|---|
| `CLICKHOUSE_URL` | Yes | ClickHouse Cloud HTTPS endpoint |
| `CLICKHOUSE_PASSWORD` | In practice | Defaults to empty, which no Cloud service accepts |
| `CLICKHOUSE_USER` | No | Default: `default` |
| `CLICKHOUSE_DATABASE` | No | Default: `default` |
| `CLICKHOUSE_CLUSTER` | No | Default: `default`. Used to union `system.query_log` across Cloud replicas |
| `LANGFUSE_PUBLIC_KEY` | Yes | Langfuse project public key |
| `LANGFUSE_SECRET_KEY` | Yes | Langfuse project secret key |
| `LANGFUSE_BASE_URL` | No | Default: `https://cloud.langfuse.com` |
| `LLM_PROVIDER` | No | `gemini` \| `anthropic` \| `anthropic-oauth`. Blank: chosen from whichever key is present (see Configure) |
| `GEMINI_API_KEY` | Yes\* | Free key from Google AI Studio. Selects the Gemini backend |
| `GEMINI_MODEL` | No | Default: `gemini-3.1-flash-lite`. Newer models may have a much lower free-tier daily cap |
| `LLM_BASE_URL` | No | OpenAI-compatible root. Default: `https://generativelanguage.googleapis.com/v1beta/openai` |
| `ANTHROPIC_API_KEY` | Yes\* | \*One model credential is required: `GEMINI_API_KEY`, this, or `CLAUDE_CODE_OAUTH_TOKEN`. With none, falls back to the local Claude Code login, which does not exist inside Docker |
| `CLICKWRIGHT_MODEL` | No | Default: `claude-sonnet-5`. Anthropic backends only |
| `LLM_MAX_CONCURRENCY` | No | In-flight LLM calls process-wide. Default: `3` (Gemini free tier), `8` on the Claude Code path |
| `LLM_TIMEOUT_MS` | No | Per-attempt deadline; a call that hits it is retried. Default: `240000` |
| `LLM_REASONING_EFFORT` | No | `reasoning_effort` on the OpenAI-compatible path; only sent when set |
| `LLM_SEED` | No | `seed` on the OpenAI-compatible path; only sent when set (Gemini 400s on unknown fields) |
| `ANALYTICS_QUALITY_GATE` | No | Default on. `0` skips the LLM quality gate + revision pass |
| `ANALYTICS_LLM_LOOKUP` | No | Default on. `0` uses only the deterministic term-match knowledge lookup |
| `ANALYTICS_RELATED_INSIGHTS` | No | Default on. `0` keeps other conversations' cached headlines out of the narrator prompt |
| `ANALYTICS_ORDER_BY_ALL` | No | Default on. `0` drops `ORDER BY ALL` from the fetch cap (needs ClickHouse ≥ 23.12) |
| `PORT` | No | Backend port, default `8787` |
| `BACKEND_URL` | No | Vite dev-proxy target, default `http://localhost:8787`. Local dev only — Docker uses nginx instead |

A required variable that is absent or still holds a placeholder fails at first
use, naming the variable — so `npm test` and `--help`-style commands run in a
clean checkout without an `.env`.

**The four `ANALYTICS_*` flags are performance escape hatches, not features to
turn on.** All four default to enabled, which is the behaviour every trace and
screenshot was produced with; each one costs latency, so disable one only if a
demo needs the last few seconds (`ANALYTICS_QUALITY_GATE=0` saves the most — one
4–6k call plus a possible re-narration).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `docker compose up` errors on `env_file` | `backend/.env` does not exist — copy `.env.example` |
| Webapp never starts under Docker | The backend never went healthy; `docker compose logs backend` shows the ClickHouse error |
| `Missing env var X` on startup | `X` is absent or still a placeholder in `backend/.env` |
| Agent calls fail although the app runs | No usable model credential — see the note in Configure; `/api/health` shows which backend resolved |
| `rate-limited (429)` in the step log | Gemini free tier is ≈ 15 requests/min. The call backs off and retries; lower `LLM_MAX_CONCURRENCY` or upgrade the key. If it never clears, `GEMINI_MODEL` is likely on a low daily cap — the 429 body names the quota — so pick another model |
| `authentication failed (401) — check GEMINI_API_KEY` | The key is wrong, revoked, or from a different Google project |
| `404 — unknown model` | `GEMINI_MODEL` names a model the key cannot reach; `gemini-3.1-flash-lite` is the safe default |
| Answers truncate or JSON fails to parse | The output hit `max_tokens`; the trace shows `finish_reason: length`. Try `LLM_REASONING_EFFORT=low` — thinking tokens count against the budget |
| Chat answers say nothing is instrumented | `npm run seed` was never run, or no spec has been run yet |
| A spec refuses to run, "already instrumented" | Its tables exist; clear with `reset-spec.ts <spec>`, or `--orphans` if a previous run died mid-way |
