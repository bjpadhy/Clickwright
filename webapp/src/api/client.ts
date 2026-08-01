/**
 * The single place the app resolves its backend.
 *
 * Today this hands back the in-memory mock. When the real service lands, build
 * an `HttpSpecLoopApi` against the same `SpecLoopApi` interface and swap the
 * constructor here — no component changes.
 */

import type { ApiConfig, SimulationSpeed, SpecLoopApi } from "./types"
import { MockSpecLoopServer } from "@/mock/server"

const SPEEDS: SimulationSpeed[] = ["instant", "fast", "realistic"]

/**
 * Demo knobs, mirroring the prototype's editor props. Override per session with
 * `?speed=realistic&autoApprove=1`.
 */
function readConfig(): ApiConfig {
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search
  )
  const speed = params.get("speed") as SimulationSpeed | null
  const autoApprove = params.get("autoApprove")

  return {
    speed: speed && SPEEDS.includes(speed) ? speed : "fast",
    autoApprove: autoApprove === "1" || autoApprove === "true",
  }
}

export const api: SpecLoopApi = new MockSpecLoopServer(readConfig())
