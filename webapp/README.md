# Clickwright

Prototype implementation of the `Clickwright` design — a feature spec goes in,
a human-approved ClickHouse schema comes out, and every artifact links back to a
Langfuse trace.

React 19 + Vite + Tailwind v4, built exclusively on the
[shadcn/ui](https://ui.shadcn.com) component library (`radix-nova` style, zinc base).

**Instrumentation and Chat run against the real backend.** Dashboards and
Observability are still served by the in-memory mock.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
```

The Instrumentation and Chat screens need the backend up:

```bash
cd ../backend && npm run serve      # http://localhost:8787
```

`vite.config.ts` proxies `/api/*` there (override with `BACKEND_URL`). Without it,
the screen shows a "backend unreachable" panel instead of failing silently.

## Screens

| Screen              | Route state                | Data source | What it does                                                       |
| ------------------- | -------------------------- | ----------- | ------------------------------------------------------------------ |
| **Chat**            | `nav: "chat"`              | **backend** | Ask the Analytics Agent; agent steps stream, then a traced insight  |
| **Instrumentation** | `nav: "instr"`, tab `run`  | **backend** | Spec in → live pipeline → proposed DDL → two approval gates → execute |
|                     | `nav: "instr"`, tab `hist` | **backend** | The full decision record of every run, replayed from `runs_log`     |
| **Observability**   | `nav: "obs"`               | mock        | Agent traces, database health, and the schema/context changelog     |
| **Dashboards**      | `nav: "dash"`              | mock        | Saved visualizations, re-run on every load                          |

### Demo knob

- `?speed=instant|fast|realistic` — pacing of the *mocked* dashboard refresh (default `fast`)

## Architecture

```
src/
├── api/
│   ├── http.ts              # shared transport: fetch wrapper + SSE-over-POST reader
│   ├── instrumentation.ts   # real backend: runs, gates, context store (backend/API.md)
│   ├── chat.ts              # real backend: conversations, answer stream, Insight
│   ├── types.ts             # contract for the still-mocked screens
│   └── client.ts            # resolves the mock
├── mock/
│   ├── fixtures.ts          # seed data (dashboard tiles, traces, changelog)
│   └── server.ts            # MockClickwrightServer: in-memory state + streamed progress
├── state/
│   ├── console.tsx          # client-only state (active screen, filters) + mock store
│   ├── chat.tsx             # conversations, the streaming turn, saved answers
│   └── instrumentation.tsx  # run stream, gates, spec catalogue, history
├── components/
│   ├── ui/                  # stock shadcn components — safe to `shadcn diff`
│   ├── ui-kit/              # thin wrappers pinning shadcn to the design's metrics
│   └── charts/              # shadcn `chart` (Recharts) presets
└── screens/                 # one folder per screen
```

### How the Instrumentation screen works

Everything comes from `RunEvent`s. `POST /api/runs` starts a run, then an
`EventSource` on `/api/runs/:id/events` streams its steps; the server replays the
whole buffer on connect, so reloading the page mid-run rejoins it rather than
losing it. `screens/instrumentation/run-model.ts` turns that event list into the
stepper, the agent timeline, the gate proposals, the execution log and the result
— and because `GET /api/history/:runId` returns the same event objects, the report
view reuses the identical derivation.

Two behaviours worth knowing before changing this code:

- **A gate can be proposed many times.** Rejecting does not fail the run: the
  agent regenerates and a new `approval_request` arrives for the same gate. Only
  the latest one is live, and it is dismissed the moment `approval_result` lands.
- **Failed attempts are the feature.** `ddl_generation_attempt_2` following a
  `step_error` on attempt 1 is the self-healing loop, so the error text is rendered
  verbatim under the step instead of being collapsed away.

### How the Chat screen works

`POST /api/conversations/:id/messages` answers one question as an SSE stream, so —
unlike a run — it cannot use `EventSource` (that can only GET). `src/api/http.ts`
reads the frames straight off the response body instead. `screens/chat/chat-model.ts`
turns those events into the "how I got this" panel, with the same two rules as a run:
`*_attempt_N` steps collapse into one node, and a failure that triggered a retry is
shown rather than swallowed.

What persists and what does not is deliberate. Conversations, titles, stars and the
finished `Insight` of every turn live in ClickHouse, so reopening a conversation
re-renders its cards with no recompute. The per-step events are **not** stored — the
step panel therefore only exists for answers watched in the current session, and a
reload shows the card alone.

A new conversation is a draft (`activeId === null`) until its first question, so
opening the screen never writes an empty row. `Save to dashboard` posts the SQL
behind the chart — the board re-executes it read-only on every load.

Deleting is irreversible, so the trash icon arms an inline confirm in the row
rather than acting on the first click, and the row is removed optimistically —
a failed `DELETE` re-reads the list back into truth. Deleting the open
conversation falls through to the next one down, then the one above it, then the
draft empty state. A conversation whose answer is still streaming refuses to be
deleted.

### Swapping in the rest of the backend

`ClickwrightApi` in `src/api/types.ts` still fronts Dashboards and Observability, with
the mock implementing it. Each can be cut over the way Instrumentation and Chat were
— add a client next to `src/api/chat.ts`, then move that screen's state out of
`ServerState`. `src/mock/fixtures.ts` is imported only by `src/mock/server.ts`, so
the fixtures die with the last mocked screen.

One gap is open: Chat's **Save to dashboard** writes to the real `/api/dashboards`,
but the Dashboards screen still reads the mock, so a saved chart will not appear
there until that screen is migrated too.

## Design notes

- **Palette.** The design is the Tailwind zinc ramp plus a teal accent. `src/index.css`
  pins each zinc/green/amber step to the source hex so utilities match the design
  exactly rather than landing on Tailwind v4's oklch approximations.
- **Fonts and icons** are self-hosted (`@fontsource/geist`, `@fontsource/geist-mono`,
  `@tabler/icons-webfont`) instead of the prototype's CDN links — same files, same
  rendering, no network dependency.
- **Charts** use shadcn's `chart` component over Recharts. Horizontal bar charts
  (funnel, storage) carry a second right-oriented category axis so the value column
  stays aligned with its bar; see `src/components/charts/axis-tick.tsx`.
- **shadcn files under `src/components/ui` are unmodified.** Design-specific metrics
  live in `src/components/ui-kit`, so `shadcn diff` / upgrades stay clean.
