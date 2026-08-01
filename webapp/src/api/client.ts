/**
 * Where the still-mocked screens get their data: Chat, Dashboards and
 * Observability. Instrumentation does not come through here — it calls the real
 * backend via `src/api/instrumentation.ts`.
 */

import type { ApiConfig, SimulationSpeed, SpecLoopApi } from "./types"
import { MockSpecLoopServer } from "@/mock/server"

const SPEEDS: SimulationSpeed[] = ["instant", "fast", "realistic"]

/** Demo knob: `?speed=realistic` paces the simulated chat answers. */
function readConfig(): ApiConfig {
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search
  )
  const speed = params.get("speed") as SimulationSpeed | null

  return { speed: speed && SPEEDS.includes(speed) ? speed : "fast" }
}

export const api: SpecLoopApi = new MockSpecLoopServer(readConfig())
