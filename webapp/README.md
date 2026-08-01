# SpecLoop Console

Prototype implementation of the `SpecLoop Console` design — a feature spec goes in,
a human-approved ClickHouse schema comes out, and every artifact links back to a
Langfuse trace.

React 19 + Vite + Tailwind v4, built exclusively on the
[shadcn/ui](https://ui.shadcn.com) component library (`radix-nova` style, zinc base).
All data is served by an in-memory mock backend — **no network calls are made.**

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
```

## Screens

| Screen              | Route state                | What it does                                                       |
| ------------------- | -------------------------- | ------------------------------------------------------------------ |
| **Chat**            | `nav: "chat"`              | Ask the Analytics Agent; plan steps stream, then an insight reveals |
| **Instrumentation** | `nav: "instr"`, tab `run`  | Spec in → agent log → proposed DDL → approval gate → execute        |
|                     | `nav: "instr"`, tab `hist` | The full decision record for every instrumented spec               |
| **Observability**   | `nav: "obs"`               | Agent traces, database health, and the schema/context changelog     |
| **Dashboards**      | `nav: "dash"`              | Insights pinned from Chat, re-run on every load                     |

### Demo knobs

Mirroring the prototype's editor props, both are read from the query string:

- `?speed=instant|fast|realistic` — pacing of agent runs and chat answers (default `fast`)
- `?autoApprove=1` — skip the human approval gate (recorded as `auto` in the trace)

## Architecture

```
src/
├── api/
│   ├── types.ts        # domain contract — the whole app depends only on this
│   └── client.ts       # resolves the backend; swap the implementation here
├── mock/
│   ├── fixtures.ts     # seed data (specs, DDL, answers, traces, changelog)
│   └── server.ts       # MockSpecLoopServer: in-memory state + streamed progress
├── state/console.tsx   # client-only state (active screen, filters, form input)
├── components/
│   ├── ui/             # stock shadcn components — safe to `shadcn diff`
│   ├── ui-kit/         # thin wrappers pinning shadcn to the design's metrics
│   └── charts/         # shadcn `chart` (Recharts) presets
└── screens/            # one folder per screen
```

### Swapping in the real backend

`SpecLoopApi` in `src/api/types.ts` is the only contract the UI knows about. It is
deliberately shaped like a service: reads return data, commands are `async`, and
progress arrives by mutating a store that components observe through
`useSyncExternalStore`.

To go live, implement `SpecLoopApi` against HTTP/SSE and change one line:

```ts
// src/api/client.ts
export const api: SpecLoopApi = new HttpSpecLoopApi(readConfig())
```

Nothing under `src/components` or `src/screens` needs to change. Two notes for
whoever writes that client:

- **Streaming.** `startRun` returns immediately; the Instrumentation screen renders
  whatever `getState().run` currently holds. Push stage/log/exec updates as they
  arrive and call the store's listeners. `ask` behaves the same way for chat.
- **Server vs client state.** Anything that would survive a reload (context version,
  spec statuses, history, traces, changelog, conversations, dashboards) lives in
  `ServerState`. Selection and filters live in `src/state/console.tsx` and should
  stay there.

`src/mock/fixtures.ts` is imported only by `src/mock/server.ts`, so the entire
fixture set can be deleted with the mock.

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
