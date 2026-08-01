import * as React from "react"
import { toast } from "sonner"

import {
  formatBytes,
  formatCount,
  formatExact,
  formatMs,
  type QueryAgent,
  type Suggestion,
  observe,
} from "@/api/observability"
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
import { EmptyNote, LoadError, UnavailableNote } from "./states"
import { useDatabaseHealth, useSuggestions } from "./use-observe"

const AGENT_STYLE: Record<string, { background: string; color: string }> = {
  instrumentation: { background: "#e6f4f1", color: "#1a6e64" },
  analytics: { background: "#fdeae4", color: "#a03c22" },
  context: { background: "#e9eef2", color: "#274754" },
  optimizer: { background: "#f3e8ff", color: "#6b21a8" },
  observe: { background: "#f4f4f5", color: "#52525b" },
  server: { background: "#f4f4f5", color: "#52525b" },
  script: { background: "#f4f4f5", color: "#52525b" },
  // Queries Clickwright did not run — a console session, or ClickHouse Cloud's
  // own internals. Never guess an agent for these.
  unattributed: { background: "transparent", color: "#a1a1aa" },
}

const SEVERITY_STYLE: Record<Suggestion["severity"], { color: string; background: string }> = {
  HIGH: { color: "#dc2626", background: "#fef2f2" },
  MED: { color: "#d97706", background: "#fffbeb" },
  GOOD: { color: "#16a34a", background: "#f0fdf4" },
}

const QUERY_FILTERS: { id: QueryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "analytics", label: "Analytics" },
  { id: "instrumentation", label: "Instrumentation" },
  { id: "context", label: "Context" },
]

function agentLabel(agent: QueryAgent | null): string {
  return agent ?? "unattributed"
}

export function StackTab() {
  const { latencyView, setLatencyView, queryFilter, setQueryFilter } = useConsole()
  const health = useDatabaseHealth(true)
  const advisor = useSuggestions(true)
  const [drafting, setDrafting] = React.useState<string | null>(null)

  const data = health.data

  const draft = React.useCallback(async (suggestion: Suggestion) => {
    setDrafting(suggestion.id)
    try {
      await observe.draft(suggestion.id)
      toast.success(
        "Sent to the optimizer — open Instrumentation to review the DDL before it runs"
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDrafting(null)
    }
  }, [])

  if (health.error) {
    return <LoadError message={health.error} onRetry={health.reload} />
  }
  if (!data) {
    return <EmptyNote>Reading ClickHouse system tables…</EmptyNote>
  }

  const { stats, partsHealth, queryLogAvailable } = data
  const unknown = "—"

  const statCards = [
    {
      key: "Queries · 24h",
      value: queryLogAvailable && stats ? formatExact(stats.queries24h) : unknown,
      detail: queryLogAvailable ? "against this database" : "query log unavailable",
    },
    {
      key: "P95 latency",
      value: queryLogAvailable && stats ? `${stats.p95LatencyMs}ms` : unknown,
      detail: queryLogAvailable ? "across agent workloads" : "query log unavailable",
    },
    {
      key: "Rows read · 24h",
      value: queryLogAvailable && stats ? formatCount(stats.rowsRead24h) : unknown,
      detail: queryLogAvailable ? "aggregated server-side" : "query log unavailable",
    },
    {
      key: "Tables live",
      value: stats ? String(stats.tablesLive) : unknown,
      detail: stats
        ? `${stats.baseTables} base + ${stats.agentTables} agent-created`
        : "",
    },
  ]

  const storage: StorageRow[] = data.storageByTable.map((row) => ({
    table: row.table,
    megabytes: Math.max(row.bytes / 1_000_000, 0.01),
    agentCreated: row.origin === "agent",
  }))

  const spike = data.latencyP95ByHour.find((bucket) => bucket.isSpike)

  const queries = data.recentQueries.filter(
    (query) => queryFilter === "all" || query.agent === queryFilter
  )

  return (
    <>
      <StatCards stats={statCards} />

      {!queryLogAvailable ? (
        <UnavailableNote>
          <strong>system.query_log is not readable</strong> on this service, so
          query counts, latency and the query lists below are unavailable. Storage
          and table counts are unaffected.
        </UnavailableNote>
      ) : null}

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
          <LatencyChart data={data.latencyP95ByHour} view={latencyView} />
          <div className="mt-2 flex justify-between font-mono text-[10px] text-zinc-400">
            <span>−24h</span>
            <span>−12h</span>
            <span>now</span>
          </div>
          {spike ? (
            <div className="text-coral mt-1.5 flex items-center gap-[5px] text-[10.5px]">
              <span className="bg-coral size-2 rounded-sm" />
              spike {spike.p95Ms}ms
              {spike.spikeCause ? ` — ${spike.spikeCause}` : ""}
            </div>
          ) : (
            <div className="mt-1.5 text-[10.5px] text-zinc-400">
              no latency spikes in the last 24h
            </div>
          )}
        </Panel>

        <Panel className="px-[18px] py-4">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">Storage by table</span>
            <div className="flex-1" />
            <span className="text-teal inline-flex items-center gap-[5px] text-[11px]">
              <span className="bg-teal size-2 rounded-sm" />
              agent-created
            </span>
          </div>
          {storage.length > 0 ? (
            <StorageChart rows={storage} />
          ) : (
            <EmptyNote>No tables yet.</EmptyNote>
          )}
          <div className="mt-3.5 flex gap-3.5 border-t border-zinc-100 pt-2.5 font-mono text-[10.5px] text-zinc-500">
            <span>total {formatBytes(data.storageTotalBytes)}</span>
            {partsHealth ? (
              <>
                <span>{partsHealth.activeParts} active parts</span>
                <span>
                  {!partsHealth.partLogAvailable
                    ? "merge health unknown"
                    : partsHealth.healthy
                      ? "merges healthy"
                      : `${partsHealth.failedMerges24h} failed merges`}
                </span>
              </>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-[1.15fr_.85fr] items-start gap-3">
        <Panel className="min-w-0">
          <PanelHeader>
            <Icon name="ti-bulb" size={15} className="text-zinc-600" />
            <span className="text-[13px] font-semibold">Optimization suggestions</span>
            {advisor.data?.scannedAt ? (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] text-zinc-500">
                scanned {advisor.data.scannedAt.slice(11, 16)}
              </span>
            ) : null}
            <div className="flex-1" />
            <Button
              variant="outline"
              disabled={advisor.scanning}
              onClick={advisor.startScan}
              className="h-7 gap-1.5 border-zinc-200 bg-transparent px-2.5 text-[11px] font-[550] text-zinc-900 hover:border-zinc-900 hover:bg-transparent"
            >
              <Icon
                name={advisor.scanning ? "ti-loader-2" : "ti-radar-2"}
                size={13}
                className={advisor.scanning ? "animate-spin" : ""}
              />
              {advisor.scanning ? "Scanning…" : "Run scan"}
            </Button>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-[9px]">
            {advisor.scanError ? (
              <LoadError message={advisor.scanError} />
            ) : null}
            {advisor.scanning ? (
              <EmptyNote>
                Reading measured evidence and drafting suggestions — 2–3 minutes.
              </EmptyNote>
            ) : advisor.data?.status === "failed" ? (
              <LoadError
                message={advisor.data.error ?? "scan failed"}
                onRetry={advisor.startScan}
              />
            ) : (advisor.data?.suggestions.length ?? 0) === 0 ? (
              <EmptyNote>
                No scan yet — run one to get suggestions grounded in measured
                storage and query statistics.
              </EmptyNote>
            ) : (
              advisor.data?.suggestions.map((item) => (
                <div key={item.id} className="flex gap-[9px]">
                  <span
                    className="mt-0.5 shrink-0 rounded-[5px] px-[7px] py-[2.5px] text-[9px] font-bold tracking-[.05em]"
                    style={SEVERITY_STYLE[item.severity]}
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
                    {item.actionable ? (
                      <Button
                        variant="outline"
                        disabled={drafting === item.id}
                        onClick={() => void draft(item)}
                        className="mt-1.5 h-auto gap-[5px] rounded-full border-zinc-200 bg-transparent px-[9px] py-[3px] text-[10.5px] font-[550] text-zinc-900 hover:border-zinc-900 hover:bg-transparent hover:text-zinc-900"
                      >
                        <Icon
                          name={drafting === item.id ? "ti-loader-2" : "ti-wand"}
                          size={12}
                          className={drafting === item.id ? "animate-spin" : ""}
                        />
                        {drafting === item.id ? "Sending…" : "Ask agent to draft it"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </PanelBody>
        </Panel>

        <Panel className="min-w-0">
          <PanelHeader>
            <Icon name="ti-hourglass-high" size={15} className="text-zinc-600" />
            <span className="text-[13px] font-semibold">Slowest queries · 24h</span>
          </PanelHeader>
          <div className="py-1.5">
            {data.slowestQueries.length === 0 ? (
              <EmptyNote>
                {queryLogAvailable ? "No queries in the window." : "Unavailable."}
              </EmptyNote>
            ) : (
              data.slowestQueries.map((item) => (
                <div
                  key={item.shape}
                  className="flex items-center gap-2.5 px-4 py-2"
                  title={item.shape}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-700">
                    {item.shape}
                  </span>
                  <span className="shrink-0 rounded-full border border-orange-200 bg-orange-50 px-[7px] py-0.5 font-mono text-[10.5px] font-semibold text-orange-800">
                    {formatMs(item.maxMs)}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-[10.5px] text-zinc-400">
                    {formatCount(item.rows)}
                  </span>
                </div>
              ))
            )}
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
        {queries.length === 0 ? (
          <EmptyNote>
            {!queryLogAvailable
              ? "Unavailable — system.query_log cannot be read."
              : data.recentQueries.length === 0
                ? "No queries against this database in the last 24h."
                : "No queries match this filter."}
          </EmptyNote>
        ) : (
          queries.map((query) => (
            <div
              key={query.queryId}
              className="flex items-center gap-3 border-b border-zinc-100 px-4 py-[9px]"
              title={query.step ? `${query.step} · ${query.at}` : query.at}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-zinc-700">
                {query.query}
              </span>
              <StatusPill
                className="shrink-0"
                style={AGENT_STYLE[agentLabel(query.agent)]}
              >
                {agentLabel(query.agent)}
              </StatusPill>
              <span className="w-14 shrink-0 text-right font-mono text-[11px] text-zinc-600">
                {formatMs(query.ms)}
              </span>
              <span className="w-[76px] shrink-0 text-right font-mono text-[11px] text-zinc-400">
                {query.rows > 0 ? formatCount(query.rows) : "—"}
              </span>
            </div>
          ))
        )}
      </Panel>
    </>
  )
}
