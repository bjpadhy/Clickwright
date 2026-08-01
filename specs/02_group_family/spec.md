# Feature spec — Group / Family Applications

## What it does
Lets one traveller create a single application for a group (family or friends),
adding multiple co-travellers, managing each traveller's documents, and submitting
them together. Goal is to make multi-traveller trips (a large share of leisure
visas) convert without forcing separate applications.

## User actions (raw events emitted)
- `group_started` — group flow begins (`group_id`, `group_size`, `destination`)
- `traveller_added` — a co-traveller is added (`traveller_index`, `relation`, `docs_complete`)
- `traveller_removed` — a co-traveller is dropped (`traveller_index`)
- `group_submitted` — the group is submitted (`travellers_submitted`)

Envelope as usual (`device_type`, `os`, `geoip_country_code`, `user_id`,
`application_id`, `group_id`).

## Questions the PM will ask
- Completion rate (group_started → group_submitted) **by group size** — where do
  large groups fall off?
- How many travellers are added vs removed per group; is there an add/remove churn?
- Is per-traveller document completion (`docs_complete`) the bottleneck for big groups?
- Which destinations / segments drive group applications?
