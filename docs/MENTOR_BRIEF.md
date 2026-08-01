# Clickwright — Mentor Brief

**Team of 3 · Atlys problem statement · Click-a-thon India 2026**

---

## 1. The problem, as we understand it

Atlys ships a feature. Today, knowing whether it worked takes days of human relay:

```
   PM writes spec          Data eng designs        Analyst writes           PM finally
   for a new feature  ──▶  tables by hand    ──▶   queries by hand   ──▶    learns "it
                                                                             worked / it
   ░░ waiting ░░░░░░░░░░░  ░░ waiting ░░░░░░░░░░░  ░░ waiting ░░░░░░░░░      didn't, and
                                                                             nobody knows
   └──────────────────────── 2–5 days ──────────────────────────────┘        exactly why"
```

Every arrow is a handoff where context is lost. The analyst doesn't know why the schema
looks that way; the PM gets a number without a reason; nothing is written down for next time.

**What the brief asks us to build:** replace all three humans with an agent pipeline —
spec in, live tables and PM-ready insight out, in minutes, with every decision on the record.

### What makes this hard (and where teams will lose points)

```
┌─ THE FIVE TRAPS ────────────────────────────────────────────────────────────┐
│                                                                              │
│  1. UNSEEN 6th SPEC        Released to all teams in the final hours.        │
│     (highest weight)       A pipeline tuned to the 5 known specs will        │
│                            visibly break. Must generalise, not memorise.     │
│                                                                              │
│  2. TRACE-OR-ZERO          "Hand-written schemas or insights without a       │
│                            matching trace score nothing on that criterion."  │
│                            Tracing is not logging — it is the evidence.      │
│                                                                              │
│  3. DIRTY DATA             Empty `os` on Android rows · duplicate and        │
│     (deliberate)           backfilled flags · nullable everything ·          │
│                            empty application_id at top of funnel.            │
│                                                                              │
│  4. HIDDEN DEFINITIONS     Conversion is per SESSION, not per user —         │
│                            stated only in base_context.md. Teams that        │
│                            assume will report confidently wrong numbers.     │
│                                                                              │
│  5. "WHY", NOT "WHAT"      Insights are judged on whether a PM would ACT.    │
│                            "iOS conversion fell 8%" scores low.              │
│                            "…in the Gulf region, consistent with the         │
│                            documented K1 WebKit OTP bug" scores high.        │
└──────────────────────────────────────────────────────────────────────────────┘
```

The success example in the brief is precise: detect an **overall uplift**, notice an
**iOS regional drop hiding inside it**, and **link that drop to a known issue already
documented in the context layer**. That single sentence tells us what the system must do.

---

## 2. Our solution: Clickwright

An automated data department. Three agents in a fixed sequence, each doing what a
human role does today, with the whole run recorded as one Langfuse trace.

### Runtime flow — one spec through the pipeline

```
  ┌────────────────────────────────────────────────────────────────────────────────┐
  │  INPUT     spec.md  (prose: what the feature does, what events it emits,        │
  │            events.ndjson  (raw sample events — the actual data to land)         │
  └───────────────────────────────────┬────────────────────────────────────────────┘
                                      │
                     getContext()  ◀──┤ conventions, envelope fields, join strategy
                                      ▼
  ╔══ ① INSTRUMENTATION AGENT ═══════════════════════════════════════════════════╗
  ║                                                                               ║
  ║   events.ndjson ──▶ PROFILER (pure code, no LLM)                              ║
  ║                     per field: type · null rate · distinct count · nesting    ║
  ║                            │                                                  ║
  ║        spec + profile ─────┴──▶ LLM writes DDL                                ║
  ║                                 (rules in prompt: LowCardinality for enums,   ║
  ║                                  ORDER BY starts with join key, PARTITION BY  ║
  ║                                  toYYYYMM, DateTime64, avoid Nullable)        ║
  ║                                      │                                        ║
  ║                                      ▼                                        ║
  ║                            ┌─── EXECUTE on ClickHouse ───┐                    ║
  ║                            │                             │                    ║
  ║                       error│                             │ok                  ║
  ║                            ▼                             ▼                    ║
  ║                    feed REAL error back              create MVs               ║
  ║                    to LLM, regenerate  ──(≤3)──▶     load NDJSON              ║
  ║                    ▲ the self-healing loop           verify row counts        ║
  ╚═══════════════════════════════════╤═══════════════════════════════════════════╝
                                      │  "created tables X, Y with columns …"
                                      ▼
  ╔══ ② CONTEXT AGENT — write ═══════════════════════════════════════════════════╗
  ║   LLM reads spec + new schema ──▶ new/updated entries ──▶ context_store       ║
  ║   written as version n+1, append-only (old versions kept as proof)            ║
  ╚═══════════════════════════════════╤═══════════════════════════════════════════╝
                                      │  fresh context (v n+1)
                                      ▼
  ╔══ ③ ANALYTICS AGENT ═════════════════════════════════════════════════════════╗
  ║                                                                               ║
  ║   PM questions + fresh context ──▶ PLAN  (list of analysis tasks, each naming ║
  ║                                          tables, metric definition, dimensions)║
  ║                                            │                                  ║
  ║   per task:   LLM writes SQL ──▶ CLICKHOUSE COMPUTES ──▶ real rows            ║
  ║                    ▲                    │                                     ║
  ║                    └── retry on error ──┘                                     ║
  ║                                            │                                  ║
  ║                                            ▼                                  ║
  ║               SANITY GATE (pure code)  drop n<50 · rates >100% · empty sets   ║
  ║                                            │                                  ║
  ║                                            ▼                                  ║
  ║               NARRATE (LLM)   every number must exist in the attached results ║
  ║                    │                                                          ║
  ║                    ├──▶ getContext("iOS OTP failures?") ──▶ returns K1        ║
  ║                    │    ◀── this is what turns "what" into "why"              ║
  ║                    ▼                                                          ║
  ║               QUALITY GATE (LLM)  actionable? cites numbers? names a segment? ║
  ╚═══════════════════════════════════╤═══════════════════════════════════════════╝
                                      ▼
  ┌────────────────────────────────────────────────────────────────────────────────┐
  │  OUTPUT    live optimized tables + materialized views                          │
  │            updated versioned context                                           │
  │            insight report: claim · computed numbers · segment · WHY · action    │
  └────────────────────────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────────────────────────┐
  │  LANGFUSE — one nested trace wrapping everything above                         │
  │  every prompt · every retry (including failures) · every SQL + its result rows  │
  └────────────────────────────────────────────────────────────────────────────────┘
```

### The design principle underneath all of it

```
      LLM DECIDES                          DETERMINISTIC SYSTEM VERIFIES
  ─────────────────────────           ──────────────────────────────────────
  what shape the schema takes    ─▶   ClickHouse either executes it or errors
  what is worth analysing        ─▶   sanity gates drop meaningless results
  how to explain a finding       ─▶   every cited number checked against rows

  Numbers travel only along:  ndjson ▶ tables ▶ SQL results ▶ report
  The model never computes one. It writes queries and prose; ClickHouse does the math.
```

That pairing is also what makes the traces persuasive — a judge scrolling the trace sees
*decision → verification → outcome* at every step, not a black box that emitted an answer.

### Why the order is Instrumentation → Context → Analytics

The Context Agent sits in the middle on purpose. Instrumentation has just changed the
world — new tables, new metrics. If Analytics ran on the old context, it would be
analysing a system it doesn't have current definitions for. That is exactly the
"stale context" failure the brief scores against.

Context has two jobs at two moments: **write** once per spec (between the other two
agents), and **serve** on demand — including mid-analysis, which is how the iOS drop
gets linked to K1.

---

## 3. What we are betting on (our differentiators)

| | Why it wins points |
|---|---|
| **Self-healing DDL/SQL loops** | Most teams will one-shot generation and crash on the unseen spec. Our retry loop bends instead of breaking — and each retry is visible trace evidence that the pipeline, not a human, produced the output. |
| **Versioned context inside ClickHouse** | Freshness becomes *demonstrable* (show v1 → v2 diff mid-trace) instead of claimed. Also a defensible answer to "justify your context store" — queryable by the agent that needs it. |
| **Known-issue (K1–K7) correlation** | Reproduces the exact success example in the brief. Requires having actually read `base_context.md` closely — most teams won't. |
| **Insight quality gate** | A rubric pass that rewrites weak insights. Directly targets the "would a PM act on this" criterion. |
| **Fire drill before the real thing** | We write our own fake 6th spec and run it blind, then fix whatever breaks — hours before the real one drops. |

---

## 4. Stack and status

**TypeScript** · `@clickhouse/client` · `langfuse` · `@anthropic-ai/sdk` · `zod` · Node 20

No agent framework, deliberately. Each agent is a fixed sequence (profile → generate →
validate → retry), which is a function with a loop — not something that needs LangChain's
abstractions between us and a 3 AM bug. Langfuse traces cleanest wrapping our own functions.

```
DONE   ClickHouse Cloud + base data loaded · Langfuse wired · repo scaffold
       core modules (db · tracing · llm · env) · connectivity check passing
NOW    vertical slice: spec 01 end-to-end with a full trace
NEXT   generalise across specs 02–05 → differentiators → fire drill → demo
```

**Division of work:** one person owns instrumentation + profiling, one owns context +
analytics (the correctness-critical half), one owns orchestration + tracing + demo.
Interfaces were agreed up front so all three build in parallel.

---

## 5. Questions for you

1. **Human-in-the-loop on the unseen spec** — is an approval gate (e.g. reviewing DDL
   before execution) acceptable, or must that run be fully hands-off?
   *Decides whether we keep or strip our gate for the final run.*

2. **Context store as a versioned ClickHouse table** — will judges accept that
   justification, or do they expect a document/vector store?
   *We chose queryable + versioned over semantic search. Sanity-checking the trade-off.*

3. **Insight depth vs coverage** — fewer deep insights with recommendations, or full
   coverage of every question in the spec?
   *Changes how our planner spends its query budget.*

4. **Will the unseen spec likely need joins back to the base funnel tables**, or only
   analysis within its own events?
   *If yes, we harden cross-table joins now rather than at hour 20.*

5. **How are traces reviewed** — live Langfuse walkthrough during the demo, or exports?
   *Determines how much we invest in trace naming and structure.*

6. **Materialized views** — expected for every feature, or only where a clear aggregation
   pattern exists?
   *Avoids building MVs that read as decoration.*
