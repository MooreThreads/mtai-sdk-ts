import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NA,
  fetchLatestSpeculation,
  formatSpeculationMs,
  latestCompletedTurn,
  latestSpeculation,
  speculationSavedMs,
} from './telemetryMetrics.ts'

function turn(overrides: Record<string, unknown> = {}) {
  return { turn_id: 't1', session_id: 's1', finished: true, ...overrides }
}

test('speculationSavedMs reads only the canonical speculation_saved_ms field', () => {
  assert.equal(speculationSavedMs(turn({ metrics: { speculation_saved_ms: 350.7 } })), 350.7)
  assert.equal(speculationSavedMs(turn({ metrics: {} })), null)
  assert.equal(speculationSavedMs(turn({ metrics: null })), null)
  assert.equal(speculationSavedMs(turn({})), null)
  assert.equal(speculationSavedMs(null), null)
  // A generic saved_ms or nested speculation shape is never accepted.
  assert.equal(speculationSavedMs(turn({ metrics: { saved_ms: 500 } })), null)
  assert.equal(
    speculationSavedMs(turn({ metrics: { speculation: { saved_ms: 500 } } })),
    null,
  )
  // Non-finite/non-number values are unavailable, not 0.
  for (const bad of ['350', NaN, Infinity, null, true]) {
    assert.equal(speculationSavedMs(turn({ metrics: { speculation_saved_ms: bad } })), null)
  }
})

test('formatSpeculationMs renders N/A when unavailable and rounds measured values', () => {
  assert.equal(formatSpeculationMs(null), NA)
  assert.equal(formatSpeculationMs(350.7), '351 ms')
  assert.equal(formatSpeculationMs(12.4), '12 ms')
  // A genuinely measured 0 is a real measurement; only unavailable is N/A.
  assert.equal(formatSpeculationMs(0), '0 ms')
})

test('latestCompletedTurn picks the first finished turn, newest first', () => {
  const turns = [
    turn({ turn_id: 'live', finished: false }),
    turn({ turn_id: 'newest-done', session_id: 's2' }),
    turn({ turn_id: 'older-done' }),
  ]
  // Newest completed SERVER turn regardless of which session owns it.
  assert.equal(latestCompletedTurn(turns)?.turn_id, 'newest-done')
  assert.equal(latestCompletedTurn([turn({ turn_id: 'x', finished: undefined })]), null)
  assert.equal(latestCompletedTurn([]), null)
  assert.equal(latestCompletedTurn(null), null)
  assert.equal(latestCompletedTurn({ turns: [] }), null)
})

test('latestSpeculation reports ids and the metric text of the latest completed turn', () => {
  const snapshot = {
    turns: [
      turn({ turn_id: 'live', finished: false, metrics: { speculation_saved_ms: 5 } }),
      turn({ turn_id: 'done', session_id: 'voice_1', metrics: { speculation_saved_ms: 412.6 } }),
    ],
  }
  assert.deepEqual(latestSpeculation(snapshot), {
    sessionId: 'voice_1',
    turnId: 'done',
    valueText: '413 ms',
  })
})

test('latestSpeculation keeps ids but shows N/A when the metric is missing', () => {
  const snapshot = { turns: [turn({ turn_id: 'done', metrics: {} })] }
  assert.deepEqual(latestSpeculation(snapshot), {
    sessionId: 's1',
    turnId: 'done',
    valueText: NA,
  })
})

test('latestSpeculation is N/A with no ids when nothing completed or payload invalid', () => {
  const none = { sessionId: null, turnId: null, valueText: NA }
  assert.deepEqual(latestSpeculation({ turns: [turn({ finished: false })] }), none)
  assert.deepEqual(latestSpeculation({ turns: [] }), none)
  assert.deepEqual(latestSpeculation({ error: 'telemetry upstream failed' }), none)
  assert.deepEqual(latestSpeculation({ turns: null }), none)
  assert.deepEqual(latestSpeculation('nope'), none)
  assert.deepEqual(latestSpeculation(null), none)
  // Ids that are not strings are not reported.
  assert.deepEqual(latestSpeculation({ turns: [turn({ session_id: 7, turn_id: null })] }), none)
})

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

const URL = 'https://aibook-api.mthreads.com:8795/telemetry/turns?limit=10'

test('fetchLatestSpeculation extracts the latest completed turn via one GET', async () => {
  const seen: string[] = []
  const latest = await fetchLatestSpeculation(URL, {
    fetchImpl: (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return jsonResponse({ turns: [turn({ metrics: { speculation_saved_ms: 88.5 } })] })
    }) as typeof fetch,
  })
  assert.deepEqual(latest, { sessionId: 's1', turnId: 't1', valueText: '89 ms' })
  assert.deepEqual(seen, [URL])
})

test('fetchLatestSpeculation returns null on network, HTTP, and payload failures', async () => {
  assert.equal(
    await fetchLatestSpeculation(URL, {
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch')
      }) as typeof fetch,
    }),
    null,
  )
  assert.equal(
    await fetchLatestSpeculation(URL, {
      fetchImpl: (async () => new Response('nope', { status: 502 })) as typeof fetch,
    }),
    null,
  )
  assert.equal(
    await fetchLatestSpeculation(URL, {
      fetchImpl: (async () => new Response('<html>')) as typeof fetch,
    }),
    null,
  )
})
