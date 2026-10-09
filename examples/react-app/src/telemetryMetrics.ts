// Server telemetry metric extraction (pure helpers; no DOM, no React).
//
// GET /telemetry/turns returns the server's turns newest first. This module
// reduces that snapshot to the LATEST COMPLETED SERVER TURN — whichever
// session owns it — and reads ONLY its canonical `metrics.
// speculation_saved_ms` field: the measured pre-ASR lead of the selected
// speculation candidate (asr_final monotonic anchor minus the selected
// candidate's started monotonic), NOT a counterfactual latency saving. There
// is no browser-session ownership claim: it is simply the server's most
// recent finished turn. A missing/invalid metric is N/A, never a fabricated
// 0 — the same contract as the MVP web frontend's key_metrics.mjs.

export const NA = 'N/A'

export interface TelemetryTurn {
  turn_id?: unknown
  session_id?: unknown
  finished?: unknown
  metrics?: {
    speculation_saved_ms?: unknown
  } | null
}

/** The latest completed server turn's ids and metric display text. */
export interface LatestSpeculation {
  sessionId: string | null
  turnId: string | null
  valueText: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

export function speculationSavedMs(turn: TelemetryTurn | null | undefined): number | null {
  const value = turn?.metrics?.speculation_saved_ms
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function formatSpeculationMs(value: number | null): string {
  return value == null ? NA : `${Math.round(value)} ms`
}

export function latestCompletedTurn(turns: unknown): TelemetryTurn | null {
  if (!Array.isArray(turns)) return null
  return ((turns.find((turn) => isObject(turn) && turn.finished === true)) as TelemetryTurn) ?? null
}

export function latestSpeculation(snapshot: unknown): LatestSpeculation {
  const turns = isObject(snapshot) ? snapshot.turns : null
  const turn = latestCompletedTurn(turns)
  return {
    sessionId: typeof turn?.session_id === 'string' ? turn.session_id : null,
    turnId: typeof turn?.turn_id === 'string' ? turn.turn_id : null,
    valueText: formatSpeculationMs(speculationSavedMs(turn)),
  }
}

/**
 * One plain HTTP GET of the telemetry snapshot, reduced to the latest
 * completed server turn. Returns `null` on network/CORS failure, non-200
 * response, or an unparsable payload so callers can render N/A.
 * No retry, no polling, no timeouts.
 */
export async function fetchLatestSpeculation(
  url: string,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<LatestSpeculation | null> {
  try {
    const response = await fetchImpl(url)
    if (!response.ok) return null
    return latestSpeculation(await response.json())
  } catch {
    return null
  }
}
