# DDL Output

Generated `CREATE TABLE` statements for all instrumented specs.

## How to populate

After running all specs, export the DDL from ClickHouse:

```sql
SELECT name, create_table_query
FROM system.tables
WHERE database = currentDatabase()
  AND name NOT IN (
    'context_store','runs_log','conversations','messages',
    'dashboards','insight_cache','optimization_suggestions',
    'schema_changelog','trace_summaries','run_summary'
  )
ORDER BY name
```

Save each spec's tables as a separate `.sql` file:
- `01_express_checkout.sql`
- `02_group_family.sql`
- `03_status_sharing.sql`
- `04_abandoned_checkout_recovery.sql`
- `05_instant_forex.sql`
- `06_smart_document_retry.sql`
