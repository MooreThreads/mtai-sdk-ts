/** Transport-independent playback law shared by ordered metadata and legacy stripes. */
export type TurnTransition = {
  /** Previous turn ended by this observation, never the newly observed turn. */
  endedTurnId: string | undefined,
  /** Valid current observation, including repeated observations of the same turn. */
  observedTurnId: string | undefined,
}

/**
 * A validated A→B retires A once. Missing/invalid/conflicting observations never
 * mean idle. Retired tokens cannot reopen within the same connection generation.
 * Explicit stop can retire a known accepted turn that never reached the player,
 * without ending a different current turn. Only reset begins a new generation.
 */
export function createTurnTransitionTracker() {
  let currentTurn: string | undefined
  const reported = new Set<string>()
  function observe(tokens: string[]): TurnTransition {
    const valid = [...new Set(tokens)].filter(token => typeof token === 'string' && /^[0-9A-Za-z]{2}$/.test(token))
    if (valid.length !== 1) return { endedTurnId: undefined, observedTurnId: undefined }
    const token = valid[0]
    if (token === currentTurn) return { endedTurnId: undefined, observedTurnId: token }
    if (reported.has(token)) return { endedTurnId: undefined, observedTurnId: undefined }
    const previous = currentTurn
    currentTurn = token
    if (previous === undefined || reported.has(previous)) return { endedTurnId: undefined, observedTurnId: token }
    reported.add(previous)
    return { endedTurnId: previous, observedTurnId: token }
  }
  function endCurrent(): TurnTransition {
    const previous = currentTurn
    currentTurn = undefined
    if (previous === undefined || reported.has(previous)) return { endedTurnId: undefined, observedTurnId: undefined }
    reported.add(previous)
    return { endedTurnId: previous, observedTurnId: undefined }
  }
  function endAcceptedTurn(turnId: string): TurnTransition {
    if (currentTurn === turnId) currentTurn = undefined
    if (reported.has(turnId)) return { endedTurnId: undefined, observedTurnId: undefined }
    reported.add(turnId)
    return { endedTurnId: turnId, observedTurnId: undefined }
  }
  return {
    observe, endCurrent, endAcceptedTurn,
    currentTurn: () => currentTurn,
    reset() { currentTurn = undefined; reported.clear() },
  }
}
