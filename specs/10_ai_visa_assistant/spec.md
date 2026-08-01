# Feature spec — "Ask Atlys" AI Assistant

## What it does
An in-app assistant that answers visa questions in natural language, opened from a
funnel step, the help centre, or a push. It cites sources, reports its own
confidence, and offers a hand-off to human support. Goal is to deflect support
contacts and unblock travellers without them leaving the funnel.

## User actions (raw events emitted)
- `assistant_opened` — the assistant opens (`entry_point`: funnel_step/help_center/
  push, `funnel_step`)
- `question_asked` — a question is sent (`question_id`, `query_text` — free text,
  `intents` — an **array** of classified intents)
- `answer_shown` — an answer renders (`question_id`, `confidence`, `sources_count`,
  and a latency field: builds on 7.46.0 send `latency_ms`, older builds send
  `latency_s`)
- `answer_rated` — the traveller rates the answer (`rating`, `csat` 1–5)
- `escalated_to_support` — hand-off to a human (`question_id`, `reason`)
- `assistant_closed` — the session ends (`messages_count`, `session_seconds`,
  `escalated`, `had_low_confidence_answer`)

Envelope as usual, plus `lang` on every event.

## Questions the PM will ask
- Deflection: what share of assistant sessions end without a support hand-off, and
  what predicts escalation?
- How fast is the assistant? Report one latency number that covers all traffic.
- Is answer quality good? We have CSAT — say how much weight it deserves.
- What are travellers actually asking (`intents`), and does the assistant handle
  non-English (`lang`) as well as English?
