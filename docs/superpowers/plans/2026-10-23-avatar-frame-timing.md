# Avatar Frame Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Append trustworthy receive/presentation/callback timing data to the SDK's existing turn-observation diagnostic without changing playback behavior.

**Architecture:** Forward the browser's rVFC arguments through the existing requester. Snapshot finite allowlisted metadata before listeners, and append a JSON suffix to the existing once-per-transition log after listeners. Preserve absent data as null and isolate all new diagnostic failures.

**Tech Stack:** TypeScript, DOM video-frame callback API, Jest/ts-jest, existing SDK logger.

---

## Approved design and workspace

- Design: `docs/superpowers/specs/2026-10-23-avatar-frame-timing-design.md`.
- Existing clean worktree: `/tmp/sdk-all`, branch `feat/voice-pipeline-mvp`.
- Baseline: `93685677cc6da3a93611cdf5529822f8b7577676` (already has observation/send timing logs).
- Older channel-binding worktree is not the implementation base; no changes there.
- Baseline verified: three focused requester/token-change/throwing-sink tests passed before writing this plan.
- User requested plan and execution in the same session. Keep documentation/source commits local; no push, package pin, publish, install, service changes or live test turns.

## Files and responsibilities

- Modify `core/src/dh2d/avatarMedia.ts`: optional callback metadata plumbing and failure-isolated log suffix.
- Modify `core/src/dh2d/avatarMedia.test.ts`: deterministic requester/observer tests and test harness support for optional callback arguments.
- Modify `core/README.md`: field units, null handling, formulas and measurement limitations.
- Update this plan with verification evidence after review.
- Do not modify `voiceConnections.ts`, wire types, timing policy, dependencies, lockfiles, package version or any other repository.

## Task 1: Native frame timing diagnostic (one cohesive implementation/review unit)

### Step 1 — Write the requester test first

- [x] Add a test named `forwards native callback timing metadata without changing cancellation` in the `createAvatarFrameRequester` describe block. Exercise the real requester, not a replacement wrapper:

```ts
let nativeCallback: VideoFrameRequestCallback | undefined
const cancelled: number[] = []
const video = {
  requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => {
    nativeCallback = callback
    return 7
  },
  cancelVideoFrameCallback: (handle: number) => cancelled.push(handle),
} as unknown as HTMLVideoElement
const onFrame = jest.fn()
const cancel = createAvatarFrameRequester(video)!(onFrame)
const metadata: VideoFrameCallbackMetadata = {
  receiveTime: 1000, presentationTime: 1200, expectedDisplayTime: 1216,
  processingDuration: 0.008, presentedFrames: 42, rtpTimestamp: 90000,
  width: 1920, height: 1080, mediaTime: 1,
}
nativeCallback!(1204, metadata)
expect(onFrame).toHaveBeenCalledWith(1204, metadata)
cancel()
expect(cancelled).toEqual([7])
```

- [x] Run the single test before production changes; expect an assertion failure because the old requester passes no arguments, not a type/compiler failure:

```bash
cd /tmp/sdk-all/core
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/dh2d/avatarMedia.test.ts --testNamePattern='^createAvatarFrameRequester forwards native callback timing metadata without changing cancellation$'
```

### Step 2 — Forward optional metadata, verify green

- [x] Change the requester callback type to optional arguments:

```ts
(onFrame: (now?: number, metadata?: Partial<VideoFrameCallbackMetadata>) => void): () => void
```

- [x] Match the browser callback typing and forward both arguments:

```ts
const handle: number | undefined = requestVideoFrameCallback.requestVideoFrameCallback.call(
  video, (now, metadata) => onFrame(now, metadata),
)
```

- [x] Run the new test plus the existing `returns null when requestVideoFrameCallback is unavailable` and `schedules and cancels video frame callbacks` tests in one anchored three-case invocation. Existing no-argument callbacks must compile and work.

### Step 3 — Write observer diagnostic tests before its implementation

- [x] Extend only the manual frame-source test helper to accept optional native timestamp/partial metadata and pass them into its stored callback. This is test plumbing, not a production fallback clock.
- [x] Add tests for the cases below. Each test parses the suffix with:

```ts
const timing = JSON.parse(lines[0].split(' frame_timing=')[1])
```

- [x] Exact values and units: emit callback `1204`, metadata receive `1000`, presentation `1200`, expected display `1216`, processing duration `0.008`, presented frames `42`, RTP timestamp `90000`. Expect:

```ts
expect(timing).toMatchObject({
  callback_now_ms: 1204,
  receive_time_ms: 1000,
  presentation_time_ms: 1200,
  expected_display_time_ms: 1216,
  processing_duration_ms: 8,
  presented_frames: 42,
  rtp_timestamp: 90000,
  receive_to_presentation_ms: 200,
  presentation_to_callback_ms: 4,
})
```

- [x] Confirm all ten allowlisted keys, including finite `time_origin_ms` (or null when unavailable); exclude an injected unrelated property. Preserve the old observation fields.
- [x] Missing/partial metadata: native callback missing → null; absent receive time → receive and corresponding delta null. A later token with no metadata must not reuse the prior frame's values.
- [x] Zero and signed data: valid zero stays zero; negative deltas are retained rather than clamped.
- [x] Malformed/nonfinite/overflow values: null instead of NaN/Infinity/strings or fabricated zero, including overflow from seconds→milliseconds and subtraction. Do not serialize arbitrary metadata.
- [x] Before-listener snapshot: have an observation listener mutate the supplied metadata; assert the original values were recorded and existing observation-before-listener clock semantics remain intact.
- [x] Repeated and invalid/CRC-failing token observations must not create extra timing lines; stop/start still logs the first valid token again. Existing tests already cover these lifecycle facts—extend or add only the coverage needed for the new suffix.
- [x] A throwing metadata getter must not suppress playback end, turn observation, scheduling of another frame, or the original log prefix. A throwing log sink must likewise leave existing behavior unchanged.
- [x] Run at most three exact tests per process, observe expected RED for missing diagnostics (not syntax/type setup failures), then implement the log path. Record RED command/output evidence in the completion report.

### Step 4 — Implement the minimal diagnostic snapshot and suffix

- [x] Add a private helper if useful, with finite-number/null normalization only. Recommended building blocks:

```ts
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function difference(later: number | null, earlier: number | null): number | null {
  return later === null || earlier === null ? null : finiteNumber(later - earlier)
}
```

- [x] Snapshot only the ten design fields, using `finiteNumber` for metadata, `performance.timeOrigin` where supported, conversion and arithmetic results. Processing input is seconds; all time fields in the output are milliseconds. No bounds or clamping.
- [x] Extend `observe` to receive optional `now`/metadata. Inside the existing token-change path, capture the diagnostic suffix in its own try/catch before listeners, retaining no source metadata object across listeners.
- [x] Keep the existing `at`/`epochMs`, tracker, notification order and `lastObservedTurnId` handling unchanged. The suffix is appended after the existing epoch field:

```ts
+ ` now=${at.toFixed(3)} epoch_ms=${epochMs}` + frameTimingSuffix
```

- [x] On snapshot failure set/leave only the suffix empty; the original observation line and playback must still proceed. On log failure preserve the existing diagnostic-only catch. No new frame loop, callbacks, awaits, timers, buffering controls, retries, protocol events or runtime limits.
- [x] Run each newly added test in batches of at most three until green. Refactor only where it makes this small function clearer.

### Step 5 — Document interpretation and verify regressions

- [x] Add an `Avatar frame timing diagnostics` section to `core/README.md` documenting the single-line suffix and all fields in the design. Include a synthetic example using receive=1000, presentation=1200, callback=1204, decoder=8ms. State that unavailable is null, native times use the document performance clock, and browser epoch conversion uses timeOrigin, not process monotonic subtraction.
- [x] Explain that presentation means compositor submission rather than audible output; receive-to-presentation includes multiple browser stages; decoder duration overlaps and must not be added as another disjoint stage; the stripe identifies a turn, not uniquely the first encoded frame of that turn. RTP timestamp/frame count help correlate later measurements.
- [x] Run all `avatarMedia.test.ts` cases in separate batches of at most three actual cases; enumerate exact full test names and construct anchored escaped patterns. Never run the whole suite in one process. No new or changed timeouts.
- [x] Run selected `voiceConnections.test.ts` tests for unavailable frame callbacks, normal stripe-triggered playback end and disposal/lifecycle fences, again at most three cases per process. Choose exact existing names after inspecting that file.
- [x] Build the SDK:

```bash
cd /tmp/sdk-all/core
npm run build
cd /tmp/sdk-all
git diff --check
git diff --stat
```

- [x] Inspect the generated `dist/dh2d/avatarMedia.js` and declaration for the changed callback signature/log keys, but do not commit dist. Check that no dependencies, versions, unrelated sources or other worktrees changed.
- [x] Commit only source/tests/README for this task after self-review. Report exact tests (including batch counts), build result, commit and any limitations.

## Task 2: Independent reviews and closeout (parent)

- [x] Request read-only spec review against the approved design and Task 1, including scope restrictions and three-case test-process rule. Fix any blocking findings with the same implementer and re-review.
- [x] After spec compliance passes, request a read-only quality review for clock semantics, native API compatibility, exception isolation, listener mutation, event ordering, tests and privacy. Address important findings and re-review.
- [x] Independently rerun representative new/legacy cases in small batches, the TypeScript build and `git diff --check`; record evidence below.
- [x] Update this plan with completed checks and review verdicts. Commit documentation only after implementation verification.
- [x] Report SDK source completion, file paths/commit(s), tests and build. Clearly state that Avatar package pin/build/deployment and real warmed latency measurements have not happened; do not claim a latency improvement.

## Verification evidence

- Baseline: three existing requester/observation/throwing-sink tests passed in one process (28 discovered, 3 executed, 25 skipped).
- Implementation: `439d01d4e6c5e0834a6c8e53743d9b22b8f1ff47`; test/documentation correction: `56f8b632fcefcd0b56a5bc72fe4b9698cb4967d5`.
- Requester RED: one assertion failed because the old wrapper called its consumer with zero arguments. Then the forwarding/cancellation/unavailable trio passed. Evidence: `/tmp/sdk-frame-timing-requester-{red,green}.log`.
- Observer RED: six cases in two processes failed parsing the absent `frame_timing` suffix (runtime `JSON.parse(undefined)`, not a compiler/setup error). The same cases then passed. Evidence: `/tmp/sdk-frame-timing-observer-{red,green}-{1,2}.log`.
- Implementer final verification: all 35 avatar-media cases passed in 12 processes after the one-shot test-harness correction; six connection regressions passed in three additional processes. Build and whitespace checks passed.
- Spec review initially identified the persistent test callback and two missing README caveats. Correction `56f8b63` consumes the callback before invoking it and clarifies the clocks and multi-stage interval. Independent re-review: **PASS**; nine cases in three processes plus TypeScript `--noEmit` and whitespace checks passed.
- Independent quality review: **APPROVED**, no critical/important/minor findings; three relevant cases independently passed in one process.
- Parent independently reran **44 cases: all 35 avatar-media tests plus nine selected connection/lifecycle tests**, in **15 processes**, maximum **three actual cases per process**. Per-process JSON results were checked for exit status, expected full names, actual executed count and passing status. Evidence: `/tmp/sdk-frame-timing-parent-verification/summary.json` and its per-batch JSON/log files. The first parent driver had a syntax error before running tests; the corrected, fail-fast driver completed the full run above.
- Parent reran `npm run build` successfully and checked the generated JS/declaration for the metadata forwarding, optional callback types and timing fields. `git diff --check` passed. No generated files, dependency/lock/version files or other worktrees changed. Some implementer Jest runs emitted the existing ts-jest hybrid-module/isolatedModules configuration warning; no configuration was changed.
- All verification used existing timeouts without adding or changing bounds. No live services, Avatar packages, SDK publication/pins, or latency test turns were touched. This completes source diagnostics only; no runtime latency improvement or live acceptance is claimed.
