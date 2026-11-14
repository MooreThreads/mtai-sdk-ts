import { createTurnTransitionTracker } from './turnTransition'

describe('createTurnTransitionTracker', () => {
  test('first observed turn emits nothing but reports the observation', () => {
    const tracker = createTurnTransitionTracker()
    expect(tracker.observe(['A0'])).toEqual({ endedTurnId: undefined, observedTurnId: 'A0' })
  })

  test('the same turn emits nothing but reports the observation', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe(['A0'])).toEqual({ endedTurnId: undefined, observedTurnId: 'A0' })
  })

  test('a validated A to B transition reports the previous turn', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: 'A0', observedTurnId: 'A1' })
  })

  test('an invalid or missing frame emits and observes nothing', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe([])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.observe(['A0'])).toEqual({ endedTurnId: undefined, observedTurnId: 'A0' })
  })

  test('duplicate transitions emit at most once per turn', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: 'A0', observedTurnId: 'A1' })
    tracker.observe(['A0'])
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: undefined, observedTurnId: 'A1' })
  })

  test('a stale observation of a retired turn never reads as a transition', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['B0'])
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: 'B0', observedTurnId: 'A1' })
    // B0's playback boundary was already confirmed; its late re-observation
    // is stale evidence: it must end nothing, observe nothing, and never
    // replace the current turn.
    expect(tracker.observe(['B0'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.currentTurn()).toBe('A1')
  })

  test('after a stale observation the current turn stays observable and transitions still fire', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['B0'])
    tracker.observe(['A1'])
    tracker.observe(['B0'])
    // Same current-token observations remain usable (they arm pending sleep).
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: undefined, observedTurnId: 'A1' })
    // A genuinely new turn still completes the transition exactly once.
    expect(tracker.observe(['B2'])).toEqual({ endedTurnId: 'A1', observedTurnId: 'B2' })
    expect(tracker.observe(['B2'])).toEqual({ endedTurnId: undefined, observedTurnId: 'B2' })
  })

  test('a retired turn stays rejected after an explicit media end until reset', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['B0'])
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: 'B0', observedTurnId: 'A1' })
    tracker.endCurrent()
    // B0 and A1 are both retired; after the explicit media end cleared the
    // current turn, re-observing either stays stale evidence for the rest
    // of the connection/session generation: it must end and observe nothing
    // and never re-open a turn.
    expect(tracker.observe(['B0'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.currentTurn()).toBeUndefined()
    // Only a tracker reset — a new connection/session generation — clears
    // retirement, so B0 becomes observable again afterwards.
    tracker.reset()
    expect(tracker.observe(['B0'])).toEqual({ endedTurnId: undefined, observedTurnId: 'B0' })
  })

  test('a retired turn stays rejected after an explicit media end even before a new turn is tracked', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    tracker.endCurrent()
    // A0 was retired by the explicit media end; re-observing it while no
    // turn is tracked is still stale evidence and must never re-open it.
    expect(tracker.observe(['A0'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: undefined, observedTurnId: 'A1' })
    // A0 was retired twice over (endCurrent, then the A1 transition); a late
    // A0 frame while A1 is current must still end nothing.
    expect(tracker.observe(['A0'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.currentTurn()).toBe('A1')
  })

  test('a frame with conflicting tokens is ignored', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe(['A1', 'B2'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: 'A0', observedTurnId: 'A1' })
  })

  test('CRC-valid non-alphanumeric tokens never count as observations', () => {
    const tracker = createTurnTransitionTracker()
    // Two characters, CRC-decodable, but not ASCII alphanumeric: such
    // payloads must never be evidence of a turn, a transition, or idle.
    expect(tracker.observe(['!?'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.observe(['\x00\x01'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.observe(['A\x7f'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.currentTurn()).toBeUndefined()
    // A non-alphanumeric repetition next to a valid one is filtered out
    // like a corrupted repetition, leaving the valid token observable.
    expect(tracker.observe(['A1', '!?'])).toEqual({ endedTurnId: undefined, observedTurnId: 'A1' })
  })

  test('a turn token is exactly two ASCII alphanumeric characters', () => {
    const tracker = createTurnTransitionTracker()
    expect(tracker.observe(['A'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.observe(['A1B'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.observe([''])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    // Lowercase letters and digits are alphanumeric.
    expect(tracker.observe(['a1'])).toEqual({ endedTurnId: undefined, observedTurnId: 'a1' })
    expect(tracker.observe(['Z9'])).toEqual({ endedTurnId: 'a1', observedTurnId: 'Z9' })
  })

  test('transitions chain across turns', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe(['A1']).endedTurnId).toBe('A0')
    expect(tracker.observe(['A2']).endedTurnId).toBe('A1')
    expect(tracker.observe(['A2']).endedTurnId).toBeUndefined()
  })

  test('reset forgets the current turn and emitted history', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    tracker.observe(['A1'])
    tracker.reset()
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: undefined, observedTurnId: 'A1' })
    expect(tracker.observe(['A2']).endedTurnId).toBe('A1')
  })

  test('currentTurn exposes the tracked turn without retiring it', () => {
    const tracker = createTurnTransitionTracker()
    expect(tracker.currentTurn()).toBeUndefined()
    tracker.observe(['A0'])
    expect(tracker.currentTurn()).toBe('A0')
    tracker.observe(['A1'])
    expect(tracker.currentTurn()).toBe('A1')
    tracker.endCurrent()
    expect(tracker.currentTurn()).toBeUndefined()
  })
})

describe('endCurrent', () => {
  test('an explicit media end reports the current turn exactly once', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.endCurrent()).toEqual({ endedTurnId: 'A0', observedTurnId: undefined })
    expect(tracker.endCurrent()).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
  })

  test('an explicit media end without a current turn emits nothing', () => {
    const tracker = createTurnTransitionTracker()
    expect(tracker.endCurrent()).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
  })

  test('a new turn after an explicit media end opens the next sequence; the retired one stays rejected', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    tracker.endCurrent()
    // Retirement lasts the whole generation: A0 stays rejected after the
    // explicit media end; only a genuinely new token opens the next
    // sequence, and its first observation emits no boundary.
    expect(tracker.observe(['A0'])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: undefined, observedTurnId: 'A1' })
    expect(tracker.observe(['B2'])).toEqual({ endedTurnId: 'A1', observedTurnId: 'B2' })
  })

  test('invalid frames never emit and never substitute for an explicit media end', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe([])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
    expect(tracker.endCurrent()).toEqual({ endedTurnId: 'A0', observedTurnId: undefined })
    expect(tracker.observe([])).toEqual({ endedTurnId: undefined, observedTurnId: undefined })
  })
})

