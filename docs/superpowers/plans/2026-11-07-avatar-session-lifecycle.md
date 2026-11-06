# Avatar Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop retired avatar retries, retain the existing shared global permit through real cleanup, and prevent stale attempts from clearing replacement media.

**Architecture:** Keep one shared SDK admission gate for legacy and voice sessions. Make cancellation terminal across asynchronous boundaries, bind permit release to actual operation completion while preserving the close caller's existing wait, and fence video/cover mutations by connection ownership. This is one tightly coupled implementation task, followed by independent specification and quality review.

**Tech Stack:** TypeScript, Jest/ts-jest, jsdom and existing fake WebSocket/RTCPeerConnection fixtures.

---

## Workspace and constraints

- Worktree: `/home/jj/.config/superpowers/worktrees/mtai-sdk-ts/voice-avatar-session-lifecycle`.
- Branch: `fix/voice-avatar-session-lifecycle`; base `dfe836896eba3bf52b11bcd39cd4a5f632afed50`.
- Evidence: `/tmp/sdk-avatar-session-lifecycle-20261107-c1LM2m/`.
- Approved spec: `docs/superpowers/specs/2026-11-07-avatar-session-lifecycle.md`.
- Original dirty checkout `/home/jj/Work/mtai-sdk-ts` is read-only for this task. Dependencies are reused through a node_modules symlink; do not run npm install or change lockfiles.
- Baseline: 363 tests across 20 suites passed, TypeScript build passed. Existing TS151002 ts-jest warnings are not part of this task.
- No deployment, service restart, audio replay, npm publication, remote push, timeout/limit changes, or new test timeout/polling bounds.

## File responsibilities

- `core/src/abortable.ts` and new `core/src/abortable.test.ts`: terminal cancellation, safe child lifecycle and abort registration cleanup.
- `core/src/dh2d/voiceConnections.ts` and `voiceConnections.test.ts`: cancel existing retry backoff, prevent obsolete retries, scope media/cover cleanup and readiness callbacks to their owner.
- `core/src/dh2d/sessions.ts` and `sessions.test.ts`: await owned disconnect work, release registration on actual completion, preserve close caller wait.
- `core/src/dh2d/hooks.ts` and `hooks.test.ts`: preserve existing shared capacity, atomically recheck admission when waiters wake, cancel queued admission cleanly.
- `core/src/dh2d/connections.ts` and `connections.test.ts`: change only if required to ensure the common cancellation/ownership contract also works for legacy callers; do not redesign legacy GC, ping, reconnect or audio behavior.
- `core/README.md`: document close caller wait versus permit lifetime and shared legacy/voice admission.
- A small internal ownership/retry helper is permitted only if it removes real duplication; do not introduce a parallel session manager or new public quota configuration.

## Task 1: Lifecycle fix, test-first

### A. Cancellation cannot revive a retired operation

- [x] Add a focused cancellation regression before implementation. A minimal real-API assertion is:

```ts
import { abortable, withChild } from './abortable'

test('a child of an aborted scope never starts work', async () => {
  const scope = abortable()
  scope.abort()
  const start = jest.fn(async () => 'started')
  await expect(withChild(scope, start)).rejects.toThrow('connection aborted')
  expect(start).not.toHaveBeenCalled()
})

test('late abort subscribers observe terminal cancellation once', () => {
  const scope = abortable()
  scope.abort()
  const handler = jest.fn()
  scope.onabort(handler)
  scope.abort()
  expect(handler).toHaveBeenCalledTimes(1)
})
```

- [x] Add an actual `connectVoiceClient` regression to the existing transport fixture: cause a socket failure; let the existing 2000ms retry wait begin with fake timers; abort its owning scope; assert terminal rejection and no second WebSocket/PC even after advancing that same existing retry interval. Also cover a failed attempt followed by cancellation before the catch continuation starts. Attach promise rejection observers immediately to avoid false unhandled-rejection failures.
- [x] Run `cd core && npm test -- --runInBand src/abortable.test.ts src/dh2d/voiceConnections.test.ts` and retain expected assertion failures under the evidence directory.
- [x] Implement terminal abort state and child cleanup. Preserve successful-child ownership semantics; unregister parent callbacks on success and failure. Prevent invoking child work after an already-aborted parent. Use the existing retry duration, with cancellation able to retire its wait and no new retry attempt after cancellation. Do not change connectTimeout, cover or reconnect timers.
- [x] Repeat the focused tests and save GREEN evidence.

### B. Real cleanup owns the existing shared slot

- [x] Use the real admission hooks and registry in tests. Control transport and disconnect completion with causal deferred promises, not a mocked global gate. The local helper is:

```ts
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
```

- [x] For voice and legacy modes, admit an old session, close it, and hold its disconnect hook pending. Create a replacement and advance the existing 3000ms close wait and 1000ms gate notification delay using fake timers. Assert that the close caller can finish on its original schedule but the old registration remains and replacement connect has not run. Release cleanup; assert only then that registration transfers and replacement can connect.
- [x] Cover failure/cancellation before initial connect completes, queued-session cancellation, release exactly once, and two queued replacements waking together without exceeding the existing capacity. Avoid leaving intentionally blocked fixture operations unresolved after a test.
- [x] Run focused `sessions.test.ts`/`hooks.test.ts` and capture assertion failures before changing production lifecycle code.
- [x] Preserve this close caller expression and its location:

```ts
await Promise.race([completed, new Promise(r => setTimeout(r, 3000))])
```

  Move registration release out of the close caller's `finally` and attach it to real operation completion. Make `completed` include awaited disconnect cleanup; remove double-disconnect paths and the unusable unassigned connection reference as appropriate. Observe background rejection without hiding errors from a caller awaiting close. Keep the global hook shared by both transport choices.
- [x] In the existing gate, recheck the live registry and claim synchronously when an admission notification runs; do not admit from a stale captured array. Preserve the 1000ms notification delay and existing `count` parameter/capacity. Remove cancelled waiters/subscriptions and their pending callbacks without adding another queue or limit.
- [x] Repeat focused tests and save GREEN evidence.

### C. A stale attempt cannot mutate replacement media

- [x] Add tests with the existing fake video/cover and real voice connection implementation for:
  1. Failed attempt before track arrival leaves an existing stream and cover unchanged.
  2. Attempt A owns stream A; after another owner attaches stream B, A's abort/dispose/explicit disconnect leaves B and its cover untouched.
  3. A foreign `canplay` event does not resolve A's readiness; stale track and delayed 500ms cover callbacks cannot mutate a replacement.
  4. Current owner's normal disconnect still closes its sockets, stops observation and clears its stream, preserving existing reconnect-cover behavior.
  5. Asset replacement during old retry backoff produces only the replacement's subsequent attempt and can reach its normal readiness path.
- [x] Run and retain RED evidence before production media changes.
- [x] Track the stream owned by each attempt, and check ownership before cleanup. The core predicate must distinguish “never attached” from an owned stream:

```ts
let ownedStream: MediaStream | undefined
const ownsVideo = () => ownedStream !== undefined && elements.video.srcObject === ownedStream
const clearOwnedVideo = () => {
  if (ownsVideo()) elements.video.srcObject = null
}
```

  Use this invariant consistently for track attachment ownership, disposal, explicit disconnect, cover snapshots and delayed readiness/presentation callbacks. A connection that never attached media must not clear arbitrary media. Do not leave a second unconditional `srcObject = null` in explicit disconnect that bypasses the ownership-aware disposal.
- [x] Repeat focused tests and preserve GREEN evidence. Keep existing successful media/protocol tests intact; do not weaken assertions to accommodate regressions.

### D. Documentation, reviews and verification

- [x] Document that legacy and voice use one shared slot, that close still has its existing caller wait, and that a still-retiring operation holds the slot until it terminates. No forced release/new cleanup timeout is introduced.
- [x] Run from `core`:

```bash
npm test -- --runInBand
npm run build
```

  Run `git diff --check` from the worktree. Save complete logs in the evidence directory. Compare counts and diagnostics against the baseline.
- [x] Self-review for every unguarded media mutation, retry entry after abort, premature permit release, ignored cleanup promise, dangling waiter, and changed timeout/limit. Commit only this task's files in this isolated branch.
- [x] Independent spec review first, then quality review. Fix findings with new regression tests where applicable and rerun affected/full verification.
- [x] Record final commit, file scope, test counts, remaining warnings and the fact this was not deployed. Verify the original dirty workspace was not edited by this task; report concurrent changes rather than overwriting them.

### Implementation evidence

- RED logs: `abortable-red.log` (3 failed assertions), `retry-red.log` (2),
  `gate-red.log` (1), `session-red.log` (2), `media-red.log` (4),
  `readiness-red.log` (2), all under the evidence directory above.
- GREEN logs: `abortable-green.log`, `retry-green.log`, `session-green.log`,
  `media-green.log`, `focused-green.log`; the latter covers all four focused suites.
  Supplemental lifecycle/asset-replacement tests were added after these primary
  RED/GREEN cycles to exercise the integrated behavior.
- Final full verification: `full-green.log` — 21 suites / 385 tests PASS
  (baseline: 20 / 363); `build-green.log` — TypeScript build PASS.
- Existing ts-jest TS151002 diagnostics remain. Focused hook/session runs
  reported Jest's open-handle notice; the final full run exited without that notice.
- No timeout/capacity values changed, no extra manager, no legacy GC/audio redesign,
  no dependency/lockfile changes, and no live-system actions. Only this isolated
  worktree was edited. Independent spec and quality review remain for the parent.

### Specification-review follow-up

- [x] Fence `connectPc` after each awaited native/signaling step; use the owning
  AbortSignal for HTTP and ICE observation without racing away native work.
- [x] Join voice and legacy offer tasks (including optional legacy audio setup)
  on failure/cancellation and after the existing connect-timeout trigger.
- [x] Exercise the real shared session gate with deferred HTTP in voice, legacy,
  and legacy-with-audio modes: the old slot survives the caller's 3-second wait
  and transfers only after the deliberately non-cooperative fetch retires.
- [x] Recheck voice media ownership after readiness awaits, before returning the
  connection or starting playback observation.
- [x] Observe automatic `session_ended` close rejection while preserving explicit
  close errors and the existing logging/wait behavior.
- [x] Move the legacy rejection callback into its attempt scope; exercise three
  real failed attempts/backoffs without retaining parent callbacks.
- [x] Join late legacy microphone acquisition and stop only the retired attempt's
  acquired tracks; caller-supplied streams and normal audio protocol are unchanged.
- [x] Verify full tests/build and review timer/limit/resource ownership diffs.
- [x] Rerun independent specification review, then quality review (parent).

Follow-up evidence in the same directory:
- `review-pc-red.log`: 6 failing native/ICE cancellation assertions;
  `review-pc-green.log`: 6 passed.
- `review-transport-red.log`: voice retirement and final-ownership failures;
  its initial legacy fixture also lacked HTTP `ok` and was corrected.
  `review-legacy-retirement-red.log` separately proves the corrected real legacy
  slot-retirement failure with the join removed.
- `review-legacy-red.log`: retained parent callback failure;
  `review-close-red.log`: automatic close unhandled rejection failure (explicit
  error assertion already passed); `review-timeout-red.log`: removal of the
  timeout-path join reproduced premature retirement.
- `review-audio-red.log` and `review-audio-offer-red.log`: late/acquired legacy
  microphone tracks were not stopped on cancellation (one failing test each).
- `review-focused-green.log`: 4 suites / 132 tests PASS.
- `review-full-green.log`: 22 suites / 400 tests PASS; `review-build-green.log`:
  TypeScript build PASS. Existing TS151002 warnings and Jest's delayed-exit notice
  appeared; no timer values were changed to suppress them. A full follow-up
  `--detectOpenHandles` run (`review-handles.log`) also passed all 400 tests and
  did not report open handles.
- No new timeout, bounded wait, queue, capacity change, dependency change, GC
  redesign, deployment, push, publication, or original-worktree edits.

### Second specification-review follow-up: complete retirement contract

- [x] Independently abort-settle legacy media readiness after signalling has
  fulfilled. Verify close/replacement and the existing 60000ms timeout followed
  by the unchanged 2000ms retry cadence in that exact state.
- [x] Keep successful legacy attempt cleanup on its returned connection and await
  it from normal disconnect, including SDK-acquired microphone tracks and
  transport/media listeners. Preserve caller-supplied streams and existing GC.
- [x] Return one stable input-controller disposal promise. Join acquisition,
  prior releases and asynchronous stop even when one rejects, before reporting
  the retirement error.
- [x] Preserve immediate voice fencing while propagating one idempotent
  retirement completion through failed-attempt cleanup and normal disconnect.
  Voice setup waiters now also settle independently on cancellation and are
  joined alongside signalling and input retirement.
- [x] Verify real connected voice sessions retain the real shared slot beyond
  the unchanged 3-second caller wait for deferred getUserMedia and deferred
  AudioContext.close; only actual retirement permits replacement admission.
- [x] Verify pending (failed-attempt) input cleanup, direct disposal idempotence,
  successful legacy disposal idempotence and caller-stream preservation.
- [x] Full lifecycle self-review: pending signalling/media/input -> connected
  resource ownership -> synchronous fencing -> awaited retirement -> slot release.
  Abort callbacks remain synchronous notifications, not the completion contract;
  owners explicitly join the returned retirement promises.
- [x] Parent reruns independent specification review, then quality review.

### Final independent review and parent verification

- Specification review PASS at `b2cf4d36bb393fb9b7ddb8e6ef7d29657932d274`:
  independent full 411 tests / 22 suites and `tsc --noEmit` passed; actual
  transport/gate reproductions confirmed all outstanding retirement cases fixed.
- Quality review approved with no critical or important issues. Its independent
  focused run passed 159 tests across 7 suites. The sole minor issue was an
  outdated connectTimeout comment; the comment now distinguishes cancellation
  trigger from unbounded retirement of non-cooperating owned work.
- Parent independently ran full 411 tests / 22 suites and TypeScript build
  successfully (`parent-full-verification.log`, `parent-build-verification.log`).
  Final post-comment verification is recorded in the accompanying report.
- Original dirty checkout was not edited by this task. Its tracked diff changed
  concurrently in README, playerPresentation, sessions and voiceConnections
  source/tests; before/after snapshots remain in the private evidence directory.
  No unrelated changes were copied, reverted, staged or committed here.
- Code commits: `a4f0d27`, `3111f7c`, `b2cf4d36`; documentation baseline `c62e75c`.
  All implementation remains isolated on `fix/voice-avatar-session-lifecycle`.
  No merge, push, package publication, deployment, restart or live audio test.

Evidence in the same directory:
- `pass3-input-red.log`: 2 failures (dispose discarded retirement).
- `pass3-input-join-red.log`: after exposing disposal, 1 remaining failure proved
  rejected stop could settle before acquisition; all-settled joining fixes it.
- `pass3-lifecycle-red.log`: 6 failures covering legacy post-offer readiness,
  connected voice acquisition/context retirement, and successful legacy cleanup.
- `pass3-failed-input-red.log`: 2 regression failures with failed-attempt disposal
  joining removed, verifying that connected-only cleanup is insufficient.
- `pass3-lifecycle-green.log`: 11 selected tests passed.
- `pass3-focused-green.log`: 4 suites / 140 tests PASS.
- `pass3-full-green.log`: 22 suites / 411 tests PASS; `pass3-build-green.log`:
  TypeScript build PASS. Existing TS151002 diagnostics remain; an earlier focused
  run emitted Jest's delayed-exit notice, but the final focused and full runs did not.
- `microphone.ts`, capture/sampling/routing policy, all timeout/cadence/capacity
  values, dependency files and other worktrees are unchanged. No deployment,
  publication, push or live-system commands were performed.
