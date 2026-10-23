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

- [ ] Add a test named `forwards native callback timing metadata without changing cancellation` in the `createAvatarFrameRequester` describe block. Exercise the real requester, not a replacement wrapper:

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

- [ ] Run the single test before production changes; expect an assertion failure because the old requester passes no arguments, not a type/compiler failure:

```bash
cd /tmp/sdk-all/core
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/dh2d/avatarMedia.test.ts --testNamePattern='^createAvatarFrameRequester forwards native callback timing metadata without changing cancellation$'
```

### Step 2 — Forward optional metadata, verify green

- [ ] Change the requester callback type to optional arguments:

```ts
(onFrame: (now?: number, metadata?: Partial<VideoFrameCallbackMetadata>) => void): () => void
```

- [ ] Match the browser callback typing and forward both arguments:

```ts
const handle: number | undefined = requestVideoFrameCallback.requestVideoFrameCallback.call(
  video, (now, metadata) => onFrame(now, metadata),
)
```

- [ ] Run the new test plus the existing `returns null when requestVideoFrameCallback is unavailable` and `schedules and cancels video frame callbacks` tests in one anchored three-case invocation. Existing no-argument callbacks must compile and work.

### Step 3 — Write observer diagnostic tests before its implementation

- [ ] Extend only the manual frame-source test helper to accept optional native timestamp/partial metadata and pass them into its stored callback. This is test plumbing, not a production fallback clock.
- [ ] Add tests for the cases below. Each test parses the suffix with:

```ts
const timing = JSON.parse(lines[0].split(' frame_timing=')[1])
```

- [ ] Exact values and units: emit callback `1204`, metadata receive `1000`, presentation `1200`, expected display `1216`, processing duration `0.008`, presented frames `42`, RTP timestamp `90000`. Expect:

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

- [ ] Confirm all ten allowlisted keys, including finite `time_origin_ms` (or null when unavailable); exclude an injected unrelated property. Preserve the old observation fields.
- [ ] Missing/partial metadata: native callback missing → null; absent receive time → receive and corresponding delta null. A later token with no metadata must not reuse the prior frame's values.
- [ ] Zero and signed data: valid zero stays zero; negative deltas are retained rather than clamped.
- [ ] Malformed/nonfinite/overflow values: null instead of NaN/Infinity/strings or fabricated zero, including overflow from seconds→milliseconds and subtraction. Do not serialize arbitrary metadata.
- [ ] Before-listener snapshot: have an observation listener mutate the supplied metadata; assert the original values were recorded and existing observation-before-listener clock semantics remain intact.
- [ ] Repeated and invalid/CRC-failing token observations must not create extra timing lines; stop/start still logs the first valid token again. Existing tests already cover these lifecycle facts—extend or add only the coverage needed for the new suffix.
- [ ] A throwing metadata getter must not suppress playback end, turn observation, scheduling of another frame, or the original log prefix. A throwing log sink must likewise leave existing behavior unchanged.
- [ ] Run at most three exact tests per process, observe expected RED for missing diagnostics (assertions, not syntax/type setup failures), then implement the log path. Record RED command/output evidence in the completion report.

### Step 4 — Implement the minimal diagnostic snapshot and suffix

- [ ] Add a private helper if useful, with finite-number/null normalization only. Recommended building blocks:

```ts
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function difference(later: number | null, earlier: number | null): number | null {
  return later === null || earlier === null ? null : finiteNumber(later - earlier)
}
```

- [ ] Snapshot only the ten design fields, using `finiteNumber` for metadata, `performance.timeOrigin` where supported, conversion and arithmetic results. Processing input is seconds; all time fields in the output are milliseconds. No bounds or clamping.
- [ ] Extend `observe` to receive optional `now`/metadata. Inside the existing token-change path, capture the diagnostic suffix in its own try/catch before listeners, retaining no source metadata object across listeners.
- [ ] Keep the existing `at`/`epochMs`, tracker, notification order and `lastObservedTurnId` handling unchanged. The suffix is appended after the existing epoch field:

```ts
+ ` now=${at.toFixed(3)} epoch_ms=${epochMs}` + frameTimingSuffix
```

- [ ] On snapshot failure set/leave only the suffix empty; the original observation line and playback must still proceed. On log failure preserve the existing diagnostic-only catch. No new frame loop, callbacks, awaits, timers, buffering controls, retries, protocol events or runtime limits.
- [ ] Run each newly added test in batches of at most three until green. Refactor only where it makes this small function clearer.

### Step 5 — Document interpretation and verify regressions

- [ ] Add an `Avatar frame timing diagnostics` section to `core/README.md` documenting the single-line suffix and all fields in the design. Include a synthetic example using receive=1000, presentation=1200, callback=1204, decoder=8ms. State that unavailable is null, native times use the document performance clock, and browser epoch conversion uses timeOrigin, not process monotonic subtraction.
- [ ] Explain that presentation means compositor submission rather than audible output; receive-to-presentation includes multiple browser stages; decoder duration overlaps and must not be added as another disjoint stage; the stripe identifies a turn, not uniquely the first encoded frame of that turn. RTP timestamp/frame count help correlate later measurements.
- [ ] Run all `avatarMedia.test.ts` cases in separate batches of at most three actual cases; enumerate exact full test names and construct anchored escaped patterns. Never run the whole suite in one process. No new or changed timeouts.
- [ ] Run selected `voiceConnections.test.ts` tests for unavailable frame callbacks, normal stripe-triggered playback end and disposal/lifecycle fences, again at most three cases per process. Choose exact existing names after inspecting that file.
- [ ] Build the SDK:

```bash
cd /tmp/sdk-all/core
npm run build
cd /tmp/sdk-all
git diff --check
git diff --stat
```

- [ ] Inspect the generated `dist/dh2d/avatarMedia.js` and declaration for the changed callback signature/log keys, but do not commit dist. Check that no dependencies, versions, unrelated sources or other worktrees changed.
- [ ] Commit only source/tests/README for this task after self-review. Report exact tests (including batch counts), build result, commit and any limitations.

## Task 2: Independent reviews and closeout (parent)

- [ ] Request read-only spec review against the approved design and Task 1, including scope restrictions and three-case test-process rule. Fix any blocking findings with the same implementer and re-review.
- [ ] After spec compliance passes, request a read-only quality review for clock semantics, native API compatibility, exception isolation, listener mutation, event ordering, tests and privacy. Address important findings and re-review.
- [ ] Independently rerun representative new/legacy cases in small batches, the TypeScript build and `git diff --check`; record evidence below.
- [ ] Update this plan with completed checks and review verdicts. Commit documentation only after implementation verification.
- [ ] Report SDK source completion, file paths/commit(s), tests and build. Clearly state that Avatar package pin/build/deployment and real warmed latency measurements have not happened; do not claim a latency improvement.

## Verification evidence

- Baseline: three existing requester/observation/throwing-sink tests passed in one process (28 discovered, 3 executed, 25 skipped).
- Implementation, reviews and final evidence will be recorded here as execution proceeds; no live acceptance is claimed by this plan.
