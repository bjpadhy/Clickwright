# Clickwright changelog

Every schema change and context update, newest first. Generated from
`context_store` and `runs_log`.

## 2026-08-02 04:46:32.678 — forex_offer_shown + 4 more created

- **kind:** schema
- **spec:** 05_instant_forex
- **detail:** Instrumentation Agent · approved by unnamed reviewer · 6,237 events loaded across 5 tables
- **trace:** https://cloud.langfuse.com/trace/fa4afc37-c6bd-4996-a07b-3cec3c3bba02
- **tables:** forex_offer_shown (2,900 rows), currency_selected (1,033 rows), amount_entered (1,033 rows), forex_added_to_cart (725 rows), forex_purchased (546 rows)

## 2026-08-02 04:46:32.622 — context v1.8

- **kind:** context
- **spec:** 05_instant_forex
- **detail:** +8 new entries · 3 existing definitions superseded · convention:data_hygiene, convention:envelope, convention:sessionization
- **contradiction surfaced:** an existing definition was replaced
- **trace:** https://cloud.langfuse.com/trace/fa4afc37-c6bd-4996-a07b-3cec3c3bba02
- **entities:** convention:data_hygiene, convention:envelope, convention:sessionization, metric:forex_aov_uplift, metric:forex_attach_rate, spec:05_instant_forex, table:amount_entered, table:currency_selected, table:forex_added_to_cart, table:forex_offer_shown, table:forex_purchased

## 2026-08-02 04:42:08.941 — abandonment_detected + 5 more created

- **kind:** schema
- **spec:** 04_abandoned_checkout_recovery
- **detail:** Instrumentation Agent · approved by unnamed reviewer · 5,919 events loaded across 6 tables
- **trace:** https://cloud.langfuse.com/trace/6a56481f-d1a9-4fa1-a468-2a62aad68b8e
- **tables:** abandonment_detected (2,300 rows), reminder_sent (2,300 rows), reminder_opened (690 rows), reminder_cta_clicked (268 rows), resumed_at_step (268 rows), reconverted (93 rows)

## 2026-08-02 04:42:08.888 — context v1.7

- **kind:** context
- **spec:** 04_abandoned_checkout_recovery
- **detail:** +13 new entries · 3 existing definitions superseded · convention:data_hygiene, convention:envelope, convention:sessionization
- **contradiction surfaced:** an existing definition was replaced
- **trace:** https://cloud.langfuse.com/trace/6a56481f-d1a9-4fa1-a468-2a62aad68b8e
- **entities:** convention:data_hygiene, convention:envelope, convention:sessionization, metric:channel_recovery_funnel, metric:reconversion_by_timing, metric:recovery_rate, metric:recovery_rate_by_drop_step, metric:reminder_channel_performance, spec:04_abandoned_checkout_recovery, spec:04_abandoned_checkout_recovery, table:abandonment_detected, table:reconverted, table:reminder_cta_clicked, table:reminder_opened, table:reminder_sent, table:resumed_at_step

## 2026-08-02 04:39:35.455 — share_clicked + 4 more created

- **kind:** schema
- **spec:** 03_status_sharing
- **detail:** Instrumentation Agent · approved by unnamed reviewer · 6,503 events loaded across 5 tables
- **trace:** https://cloud.langfuse.com/trace/fee6df6b-6b96-455f-88f7-df9c2b78faca
- **tables:** share_clicked (1,600 rows), channel_selected (1,144 rows), link_generated (1,144 rows), link_opened (2,310 rows), recipient_cta_clicked (305 rows)

## 2026-08-02 04:39:35.401 — context v1.6

- **kind:** context
- **spec:** 03_status_sharing
- **detail:** +11 new entries · 3 existing definitions superseded · convention:data_hygiene, convention:envelope, convention:sessionization
- **contradiction surfaced:** an existing definition was replaced
- **trace:** https://cloud.langfuse.com/trace/fee6df6b-6b96-455f-88f7-df9c2b78faca
- **entities:** convention:data_hygiene, convention:envelope, convention:sessionization, metric:k_factor, metric:new_user_open_rate, metric:recipient_k_factor, metric:share_rate, spec:03_status_sharing, spec:03_status_sharing, table:channel_selected, table:link_generated, table:link_opened, table:recipient_cta_clicked, table:share_clicked

## 2026-08-02 04:36:45.068 — group_started + 3 more created

- **kind:** schema
- **spec:** 02_group_family
- **detail:** Instrumentation Agent · approved by unnamed reviewer · 5,453 events loaded across 4 tables
- **trace:** https://cloud.langfuse.com/trace/99a64d75-4033-4be7-9597-52d427a7b858
- **tables:** group_started (1,200 rows), traveller_added (3,495 rows), traveller_removed (70 rows), group_submitted (688 rows)

## 2026-08-02 04:36:45.009 — context v1.5

- **kind:** context
- **spec:** 02_group_family
- **detail:** +7 new entries · 3 existing definitions superseded · convention:data_hygiene, convention:envelope, convention:sessionization
- **contradiction surfaced:** an existing definition was replaced
- **trace:** https://cloud.langfuse.com/trace/99a64d75-4033-4be7-9597-52d427a7b858
- **entities:** convention:data_hygiene, convention:envelope, convention:sessionization, metric:group_completion_rate, metric:traveller_churn_rate, spec:02_group_family, table:group_started, table:group_submitted, table:traveller_added, table:traveller_removed

## 2026-08-02 04:33:52.222 — express_checkout_shown + 4 more created

- **kind:** schema
- **spec:** 01_express_checkout
- **detail:** Instrumentation Agent · approved by unnamed reviewer · 5,507 events loaded across 5 tables
- **trace:** https://cloud.langfuse.com/trace/28ee0448-584b-4961-86da-d8eda0ae49e2
- **tables:** express_checkout_shown (1,650 rows), express_checkout_selected (1,007 rows), saved_method_used (1,007 rows), otp_entered (1,007 rows), express_payment_confirmed (836 rows)

## 2026-08-02 04:33:52.173 — context v1.4

- **kind:** context
- **spec:** 01_express_checkout
- **detail:** +9 new entries · 3 existing definitions superseded · convention:data_hygiene, convention:envelope, convention:sessionization
- **contradiction surfaced:** an existing definition was replaced
- **trace:** https://cloud.langfuse.com/trace/28ee0448-584b-4961-86da-d8eda0ae49e2
- **entities:** convention:data_hygiene, convention:envelope, convention:sessionization, metric:express_checkout_latency, metric:otp_success_rate, spec:01_express_checkout, spec:express_checkout, table:express_checkout_selected, table:express_checkout_shown, table:express_payment_confirmed, table:otp_entered, table:saved_method_used

## 2026-08-02 04:29:51.026 — context v1.3

- **kind:** context
- **spec:** data_audit_baselines
- **detail:** +3 new entries · metric:standard_checkout_conversion_rate, metric:express_payment_completion_rate, guide:conversion_denominators
- **entities:** metric:standard_checkout_conversion_rate, metric:express_payment_completion_rate, guide:conversion_denominators

## 2026-08-02 04:29:43.857 — context v1.2

- **kind:** context
- **spec:** data_audit_ordering
- **detail:** +1 new entry · 1 existing definition superseded · guide:funnel_analysis, convention:event_ordering
- **contradiction surfaced:** an existing definition was replaced
- **entities:** convention:event_ordering, guide:funnel_analysis

## 2026-08-02 04:29:37.307 — context v1.1

- **kind:** context
- **spec:** data_audit
- **detail:** +3 new entries · 6 existing definitions superseded · entity:application, known_issue:K1, known_issue:K2
- **contradiction surfaced:** an existing definition was replaced
- **entities:** convention:data_hygiene, convention:envelope, convention:sessionization, entity:application, known_issue:K1, known_issue:K2, metric:conversion_rate, table:document_uploaded, table:purchase_completed

## 2026-08-02 04:28:04.248 — context v1.0

- **kind:** context
- **spec:** base_context.md
- **detail:** +31 new entries · convention:event_table_template, entity:application, entity:destination
- **entities:** convention:event_table_template, entity:application, entity:destination, entity:document, entity:event, entity:user, guide:funnel_analysis, join_map:core, known_issue:K1, known_issue:K2, known_issue:K3, known_issue:K4, known_issue:K5, known_issue:K6, known_issue:K7, metric:conversion_rate, metric:drop_off_rate, metric:funnel_conversion, metric:on_time_delivery_rate, metric:passport_capture_pass_rate, metric:revenue_per_conversion, metric:step_through_rate, overview:business, table:application_started, table:auth_completed, table:destination_card_clicked, table:document_uploaded, table:landing_page_scrolled, table:pay_now_clicked, table:purchase_completed, table:search_typed
