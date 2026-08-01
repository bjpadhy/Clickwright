import { toast } from "sonner"

import { api } from "@/api/client"
import type { AgentKind, SpecId, SpecStatus } from "@/api/types"
import { LatencyChart } from "@/components/charts/latency-chart"
import { StorageChart, type StorageRow } from "@/components/charts/storage-chart"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/ui-kit/chips"
import {
  FilterPill,
  FilterPills,
  Segmented,
  SegmentedIcon,
} from "@/components/ui-kit/controls"
import { Icon } from "@/components/ui-kit/icon"
import { Panel, PanelBody, PanelHeader } from "@/components/ui-kit/panel"
import { useConsole, type ChartView, type QueryFilter } from "@/state/console"
import { StatCards } from "./stat-cards"

const AGENT_STYLE: Record<AgentKind, { background: string; color: string }> = {
  instrumentation: { background: "#e6f4f1", color: "#1a6e64" },
  analytics: { background: "#fdeae4", color: "#a03c22" },
  context: { background: "#e9eef2", color: "#274754" },
}

/** Base funnel tables, plus whatever the agent has shipped so far. */
function buildStorageRows(statuses: Record<SpecId, SpecStatus>): StorageRow[] {
  const rows: StorageRow[] = [
    { table: "destination_card_clicked", megabytes: 1240, agentCreated: false },
    { table: "landing_page_scrolled", megabytes: 980, agentCreated: false },
    { table: "search_typed", megabytes: 720, agentCreated: false },
    { table: "application_started", megabytes: 610, agentCreated: false },
    { table: "document_uploaded", megabytes: 540, agentCreated: false },
    { table: "purchase_completed", megabytes: 380, agentCreated: false },
  ]
  if (statuses.ec === "done")
    rows.push({ table: "express_checkout_events", megabytes: 460, agentCreated: true })
  rows.push(
    { table: "whatsapp_alert_events", megabytes: 120, agentCreated: true },
    { table: "traveller_profile_events", megabytes: 74, agentCreated: true }
  )
  if (statuses.ve === "done")
    rows.push({ table: "visa_eta_widget_events", megabytes: 130, agentCreated: true })
  if (statuses.rf === "done")
    rows.push({ table: "referral_events", megabytes: 98, agentCreated: true })

  return rows.sort((a, b) => b.megabytes - a.megabytes)
}

const OPTIMIZATIONS = [
  {
    severity: "HIGH",
    color: "#dc2626",
    background: "#fef2f2",
    askable: true,
    action: "Add TTL 6 MONTH to landing_page_scrolled",
    why: "It holds 21% of total storage (~980 MB) yet had zero reads in 30 days of query_log. Cold data is pure cost, and a TTL drops whole partitions for free — no rewrite needed.",
  },
  {
    severity: "MED",
    color: "#d97706",
    background: "#fffbeb",
    askable: true,
    action:
      "Materialize attrs['format'] as a LowCardinality column on document_uploaded",
    why: "Format cuts are a top-5 query pattern but currently unpack the whole Map column per row. A materialized column lets granule pruning kick in — est. 6× faster for +0.4% storage.",
  },
  {
    severity: "MED",
    color: "#d97706",
    background: "#fffbeb",
    askable: true,
    action: "Chunk bulk backfill INSERTs into 4 batches",
    why: "The 14:00 single-shot 412k-row INSERT spiked p95 latency to 384ms for every agent sharing the service. Smaller parts keep merges shallow and reads smooth during backfills.",
  },
  {
    severity: "GOOD",
    color: "#16a34a",
    background: "#f0fdf4",
    askable: false,
    action: "Keep mv_express_checkout_daily as-is",
    why: "It now serves 82% of analytics reads at ~2k rows per query instead of a 14M-row scan — the merge overhead is well paid for. No action needed.",
  },
]

const SLOWEST = [
  {
    query: "SELECT user_id, windowFunnel(2592000)(…) FROM atlys.funnel_events GROUP BY user_id",
    duration: "380ms",
    rows: "2.5M",
  },
  {
    query:
      "SELECT platform, attrs['format'] … FROM atlys.document_uploaded GROUP BY platform, fmt",
    duration: "121ms",
    rows: "41k",
  },
  {
    query:
      "SELECT destination, count() FROM atlys.destination_card_clicked GROUP BY destination",
    duration: "104ms",
    rows: "1.0M",
  },
]

const RECENT_QUERIES: {
  query: string
  agent: AgentKind
  duration: string
  rows: string
}[] = [
  {
    query:
      "SELECT platform, region, uniqMerge(completed_users) / uniqMerge(shown_users) … FROM mv_express_checkout_daily",
    agent: "analytics",
    duration: "94ms",
    rows: "2,046",
  },
  {
    query:
      "SELECT user_id, windowFunnel(2592000)(timestamp, …) FROM atlys.funnel_events GROUP BY user_id",
    agent: "analytics",
    duration: "380ms",
    rows: "2.5M",
  },
  {
    query: "INSERT INTO atlys.express_checkout_events FORMAT JSONEachRow",
    agent: "instrumentation",
    duration: "2.9s",
    rows: "412.9k",
  },
  {
    query: "SELECT name, type FROM system.columns WHERE database = 'atlys'",
    agent: "instrumentation",
    duration: "8ms",
    rows: "214",
  },
  {
    query: "SELECT event_type, count() FROM atlys.whatsapp_alert_events GROUP BY event_type",
    agent: "analytics",
    duration: "41ms",
    rows: "96.9k",
  },
  {
    query: "CREATE MATERIALIZED VIEW atlys.mv_alert_delivery_daily …",
    agent: "instrumentation",
    duration: "0.2s",
    rows: "—",
  },
]

const QUERY_FILTERS: { id: QueryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "analytics", label: "Analytics" },
  { id: "instrumentation", label: "Instrumentation" },
]

export function StackTab() {
  const { server, latencyView, setLatencyView, queryFilter, setQueryFilter } = useConsole()

  const storage = buildStorageRows(server.specStatuses)
  const storageTotal = `${(storage.reduce((sum, row) => sum + row.megabytes, 0) / 1000).toFixed(1)} GB`

  // Every table the agent shipped shows up in the count, base schema included.
  const tableCount =
    8 +
    server.history.length +
    (server.specStatuses.ec === "done" &&
    !server.history.some((entry) => entry.specId === "ec")
      ? 1
      : 0)

  const stats = [
    { key: "Queries · 24h", value: "1,284", detail: "+312 since hack began" },
    { key: "P95 latency", value: "142ms", detail: "across agent workloads" },
    { key: "Rows read · 24h", value: "48.2M", detail: "aggregated server-side" },
    {
      key: "Tables live",
      value: String(tableCount),
      detail: `8 base + ${tableCount - 8} agent-created`,
    },
  ]

  const queries = RECENT_QUERIES.filter(
    (query) => queryFilter === "all" || query.agent === queryFilter
  )

  return (
    <>
      <StatCards stats={stats} />

      <div className="grid grid-cols-2 items-stretch gap-3">
        <Panel className="px-[18px] py-4">
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] font-semibold">Query latency</span>
            <span className="text-[11px] text-zinc-400">p95 per hour · 24h</span>
            <div className="flex-1" />
            <Segmented
              value={latencyView}
              onValueChange={(value) => setLatencyView(value as ChartView)}
            >
              <SegmentedIcon value="bars" aria-label="Bar chart">
                <Icon name="ti-chart-bar" size={14} />
              </SegmentedIcon>
              <SegmentedIcon value="line" aria-label="Line chart">
                <Icon name="ti-chart-line" size={14} />
              </SegmentedIcon>
            </Segmented>
          </div>
          <LatencyChart data={api.getLatencySeries()} view={latencyView} />
          <div className="mt-2 flex justify-between font-mono text-[10px] text-zinc-400">
            <span>−24h</span>
            <span>−12h</span>
            <span>now</span>
          </div>
          <div className="mt-1.5 flex items-center gap-[5px] text-[10.5px] text-coral">
            <span className="size-2 rounded-sm bg-coral" />
            spike = express_checkout backfill (INSERT 412k rows)
          </div>
        </Panel>

        <Panel className="px-[18px] py-4">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">Storage by table</span>
            <div className="flex-1" />
            <span className="inline-flex items-center gap-[5px] text-[11px] text-teal">
              <span className="size-2 rounded-sm bg-teal" />
              agent-created
            </span>
          </div>
          <StorageChart rows={storage} />
          <div className="mt-3.5 flex gap-3.5 border-t border-zinc-100 pt-2.5 font-mono text-[10.5px] text-zinc-500">
            <span>total {storageTotal}</span>
            <span>41 active parts</span>
            <span>merges healthy</span>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-[1.15fr_.85fr] items-start gap-3">
        <Panel className="min-w-0">
          <PanelHeader>
            <Icon name="ti-bulb" size={15} className="text-zinc-600" />
            <span className="text-[13px] font-semibold">Optimization suggestions</span>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] text-zinc-500">
              agent nightly scan
            </span>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-[9px]">
            {OPTIMIZATIONS.map((item) => (
              <div key={item.action} className="flex gap-[9px]">
                <span
                  className="mt-0.5 shrink-0 rounded-[5px] px-[7px] py-[2.5px] text-[9px] font-bold tracking-[.05em]"
                  style={{ background: item.background, color: item.color }}
                >
                  {item.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] leading-[1.45] font-semibold">
                    {item.action}
                  </div>
                  <div className="mt-0.5 text-[11.5px] leading-[1.5] text-zinc-500">
                    {item.why}
                  </div>
                  {item.askable ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        toast.success(
                          "Sent to Instrumentation Agent — a DDL draft will appear for your approval"
                        )
                      }
                      className="mt-1.5 h-auto gap-[5px] rounded-full border-zinc-200 bg-transparent px-[9px] py-[3px] text-[10.5px] font-[550] text-zinc-900 hover:border-zinc-900 hover:bg-transparent hover:text-zinc-900"
                    >
                      <Icon name="ti-wand" size={12} />
                      Ask agent to draft it
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </PanelBody>
        </Panel>

        <Panel className="min-w-0">
          <PanelHeader>
            <Icon name="ti-hourglass-high" size={15} className="text-zinc-600" />
            <span className="text-[13px] font-semibold">Slowest queries · 24h</span>
          </PanelHeader>
          <div className="py-1.5">
            {SLOWEST.map((item) => (
              <div key={item.query} className="flex items-center gap-2.5 px-4 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-700">
                  {item.query}
                </span>
                <span className="shrink-0 rounded-full border border-orange-200 bg-orange-50 px-[7px] py-0.5 font-mono text-[10.5px] font-semibold text-orange-800">
                  {item.duration}
                </span>
                <span className="w-16 shrink-0 text-right font-mono text-[10.5px] text-zinc-400">
                  {item.rows}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader className="gap-2.5">
          <span className="text-[13px] font-semibold">Recent queries</span>
          <span className="text-[11px] text-zinc-400">
            compute pushed into ClickHouse — the LLM only sees aggregates
          </span>
          <div className="flex-1" />
          <FilterPills
            className="gap-2"
            value={queryFilter}
            onValueChange={(value) => setQueryFilter(value as QueryFilter)}
          >
            {QUERY_FILTERS.map((filter) => (
              <FilterPill
                key={filter.id}
                value={filter.id}
                className="px-2.5 py-[3.5px] text-[11px]"
              >
                {filter.label}
              </FilterPill>
            ))}
          </FilterPills>
        </PanelHeader>
        {queries.map((query) => (
          <div
            key={query.query}
            className="flex items-center gap-3 border-b border-zinc-100 px-4 py-[9px]"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-zinc-700">
              {query.query}
            </span>
            <StatusPill className="shrink-0" style={AGENT_STYLE[query.agent]}>
              {query.agent}
            </StatusPill>
            <span className="w-14 shrink-0 text-right font-mono text-[11px] text-zinc-600">
              {query.duration}
            </span>
            <span className="w-[76px] shrink-0 text-right font-mono text-[11px] text-zinc-400">
              {query.rows}
            </span>
          </div>
        ))}
      </Panel>
    </>
  )
}
