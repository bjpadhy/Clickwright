import { api } from "@/api/client"
import { InsightColumns } from "@/components/charts/insight-columns"
import { InsightFunnel } from "@/components/charts/insight-funnel"
import { Button } from "@/components/ui/button"
import { Icon, Spinner } from "@/components/ui-kit/icon"
import { Panel, Screen, ScreenHeader } from "@/components/ui-kit/panel"
import { iconButton, outlineButtonSm, solidButtonMd } from "@/components/ui-kit/styles"
import { cn } from "@/lib/utils"
import { useConsole } from "@/state/console"

export function Dashboards() {
  const {
    server,
    activeDashboard,
    selectDashboard,
    refreshDashboards,
    createDashboard,
    removeFromDashboard,
    goto,
  } = useConsole()

  const active =
    server.dashboards.find((board) => board.id === activeDashboard) ?? server.dashboards[0]
  const count = active?.items.length ?? 0

  return (
    <Screen label="Dashboards">
      <ScreenHeader
        title="Dashboards"
        subtitle="Saved visualizations — each one re-runs its SQL on ClickHouse every load"
      >
        <Button variant="outline" onClick={refreshDashboards} className={outlineButtonSm}>
          <Icon name="ti-refresh" size={14} />
          Refresh
        </Button>
      </ScreenHeader>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[238px] shrink-0 flex-col border-r border-zinc-200 bg-white">
          <div className="flex items-center justify-between px-3.5 pt-[13px] pb-2.5">
            <span className="text-[13px] font-[650]">Boards</span>
            <Button
              variant="outline"
              size="icon"
              title="New dashboard"
              onClick={createDashboard}
              className={iconButton}
            >
              <Icon name="ti-plus" size={14} />
            </Button>
          </div>
          <div className="scroll-y flex flex-1 flex-col gap-0.5 px-2">
            {server.dashboards.map((board) => (
              <Button
                key={board.id}
                variant="ghost"
                onClick={() => selectDashboard(board.id)}
                className={cn(
                  "h-auto flex-col items-stretch gap-0 rounded-lg px-2.5 py-[9px] font-normal hover:bg-zinc-100",
                  board.id === active?.id ? "bg-zinc-100" : "bg-transparent"
                )}
              >
                <div className="truncate text-left text-[12.5px] font-[550]">
                  {board.name}
                </div>
                <div className="mt-0.5 text-left text-[10.5px] text-zinc-400">
                  {board.items.length}{" "}
                  {board.items.length === 1 ? "visualization" : "visualizations"}
                </div>
              </Button>
            ))}
          </div>
        </div>

        <div className="scroll-y min-w-0 flex-1 px-6 pt-5 pb-12">
          {count === 0 ? (
            <div className="flex flex-col items-center px-5 py-[70px] text-center">
              <div className="flex size-11 items-center justify-center rounded-xl bg-zinc-100">
                <Icon name="ti-layout-dashboard" size={22} className="text-zinc-500" />
              </div>
              <div className="mt-3.5 text-[15px] font-[650]">No visualizations yet</div>
              <div className="mt-[5px] max-w-[400px] text-[12.5px] leading-[1.6] text-zinc-500">
                Ask the Analytics Agent a question in Chat, then hit "Save to dashboard" on
                any insight chart. It lands here and re-runs its SQL on every load.
              </div>
              <Button onClick={() => goto("chat")} className={cn(solidButtonMd, "mt-4")}>
                <Icon name="ti-message-circle" size={14} />
                Go to Chat
              </Button>
            </div>
          ) : (
            <>
              <div className="mb-3.5 flex items-baseline gap-2.5">
                <span className="text-[15px] font-[650] tracking-[-.01em]">
                  {active.name}
                </span>
                <span className="inline-flex items-center gap-[5px] text-[11px] text-zinc-500">
                  <Icon name="ti-database" size={13} />
                  re-ran {count} {count === 1 ? "saved query" : "saved queries"} on
                  ClickHouse · {server.dashboardsStamp}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {active.items.map((item, index) => {
                  const answer = api.getAnswer(item.key)
                  return (
                    <Panel key={`${item.key}-${index}`} className="min-w-0">
                      <div className="flex items-center gap-2 border-b border-zinc-100 px-3.5 py-[11px]">
                        <span className="flex-1 truncate text-[13px] font-semibold">
                          {answer.short}
                        </span>
                        <span className="font-mono text-[10px] text-zinc-400">
                          {answer.queryMs}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Remove from dashboard"
                          onClick={() => removeFromDashboard(active.id, index)}
                          className="size-[22px] rounded-md text-zinc-400 hover:bg-zinc-100"
                        >
                          <Icon name="ti-x" size={13} />
                        </Button>
                      </div>
                      <div className="px-3.5 py-[13px]">
                        {server.dashboardsRefreshing ? (
                          <div className="flex items-center justify-center gap-[9px] py-[26px] text-zinc-500">
                            <Spinner size={14} />
                            <span className="text-[12px]">re-running SQL on ClickHouse…</span>
                          </div>
                        ) : (
                          <>
                            <div className="mb-[11px] text-[11.5px] leading-[1.5] text-zinc-500">
                              {answer.headline}
                            </div>
                            {answer.funnel ? (
                              <InsightFunnel rows={answer.funnel} size="sm" />
                            ) : null}
                            {answer.columns ? (
                              <InsightColumns
                                columns={answer.columns}
                                scale={0.72}
                                maxBarSize={44}
                              />
                            ) : null}
                            <div className="mt-3 flex items-center gap-1.5 border-t border-zinc-100 pt-2.5 font-mono text-[10px] text-zinc-400">
                              <Icon name="ti-code" size={12} />
                              saved SQL · re-ran {server.dashboardsStamp} · fresh data
                            </div>
                          </>
                        )}
                      </div>
                    </Panel>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </Screen>
  )
}
