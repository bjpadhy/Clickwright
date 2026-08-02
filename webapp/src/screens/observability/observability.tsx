import { toast } from "sonner"

import { observe } from "@/api/observability"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { SegmentedTab, SegmentedTabsList } from "@/components/ui-kit/controls"
import { Icon } from "@/components/ui-kit/icon"
import { ScreenHeader } from "@/components/ui-kit/panel"
import { solidButtonSm } from "@/components/ui-kit/styles"
import { useConsole, type ObsTab } from "@/state/console"
import { ChangelogTab } from "./changelog-tab"
import { StackTab } from "./stack-tab"
import { TracesTab } from "./traces-tab"

const SUBTITLE: Record<ObsTab, string> = {
  traces: "What each agent did, why, and what it cost — step by step",
  stack: "Is the database healthy? Queries, latency and storage at a glance",
  log: "Every schema change and context update, in plain terms",
}

const CTA: Record<ObsTab, { label: string; icon: string; notice: string }> = {
  traces: {
    label: "Open in Langfuse",
    icon: "ti-external-link",
    notice: "Opening Langfuse (self-hosted) — project clickwright",
  },
  stack: {
    label: "Open in ClickStack",
    icon: "ti-external-link",
    notice: "Opening ClickStack (HyperDX) — service clickhouse-atlys",
  },
  log: {
    label: "Export changelog",
    icon: "ti-download",
    notice: "Changelog exported for the submission",
  },
}

export function Observability() {
  const { obsTab, setObsTab } = useConsole()
  const cta = CTA[obsTab]

  return (
    <Tabs
      aria-label="Observability"
      value={obsTab}
      onValueChange={(value) => setObsTab(value as ObsTab)}
      className="h-full min-h-0 gap-0"
    >
      <ScreenHeader title="Observability" subtitle={SUBTITLE[obsTab]}>
        {/* Database health links out to ClickStack from inside its own cards */}
        {obsTab === "log" ? (
          // A real download from the backend, not a toast — the changelog is a
          // submission artifact.
          <Button asChild className={solidButtonSm}>
            <a href={observe.changelogExportUrl} download>
              <Icon name={cta.icon} size={14} />
              {cta.label}
            </a>
          </Button>
        ) : obsTab !== "stack" ? (
          <Button onClick={() => toast.success(cta.notice)} className={solidButtonSm}>
            <Icon name={cta.icon} size={14} />
            {cta.label}
          </Button>
        ) : null}
      </ScreenHeader>

      <div className="scroll-y flex-1 px-6 pt-[18px] pb-10">
        <div className="mx-auto flex max-w-[1040px] flex-col gap-[14px]">
          <SegmentedTabsList className="self-start">
            <SegmentedTab value="traces">Agent activity</SegmentedTab>
            <SegmentedTab value="stack">Database health</SegmentedTab>
            <SegmentedTab value="log">Changelog</SegmentedTab>
          </SegmentedTabsList>

          <TabsContent value="traces" className="flex flex-none flex-col gap-[14px]">
            <TracesTab />
          </TabsContent>
          <TabsContent value="stack" className="flex flex-none flex-col gap-[14px]">
            <StackTab />
          </TabsContent>
          <TabsContent value="log" className="flex flex-none flex-col gap-[14px]">
            <ChangelogTab />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  )
}
