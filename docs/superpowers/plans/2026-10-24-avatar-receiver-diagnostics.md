# Avatar Receiver Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Follow strict TDD and two-stage review.

**Goal:** Explain browser receive/presentation and observation costs without changing media behavior.
**Architecture:** Separate asynchronous connection-owned RTCStats collector plus additive per-observation timings. Existing ten-field frame_timing contract remains unchanged. Event-triggered snapshots avoid new timers.
**Tech Stack:** TypeScript, Jest, WebRTC RTCStats/rVFC, Electron35 on ARM64 cube.

Authoritative contract: ../specs/2026-10-24-avatar-receiver-diagnostics-design.md.

## Execution record

Implementation completed through SDK `5bb2dfb`; spec and quality approved after
fixes. Parent verified 43 cases in 15 processes (maximum three actual cases per
process) and built the SDK. Avatar `0.1.7` was built on cube in 141.20 s, strict
ARM64/native validation passed, installed with a stopped-profile backup and
unchanged prelaunch profile, empty dpkg verification output and matching ASAR.
Only Avatar restarted; protected service listeners stayed unchanged.

Capture used the real installed UI for one warm-up plus ten requests, selecting
one stripe transition per request. This is not ten independently verified fully
drained responses: multiple observations per request and an 87.6 s idle first
stats interval limit inference. No optimization or latency improvement claimed.
Detailed evidence/limitations: Electron repo
`docs/avatar-receiver-diagnostics-cube-2026-10-24.md`, and local sanitized
`/tmp/avatar-receiver-20261024/capture-summary.json`. The checklist below is the
original implementation prescription, not a claim of a broader E2E acceptance.

## Task 1: Receiver collector and connection integration

Files: create core/src/dh2d/receiverStats.ts and receiverStats.test.ts; modify core/src/dh2d/voiceConnections.ts; use a new integration test file if needed, leaving the existing concurrently dirty voiceConnections.test.ts untouched.

- [ ] Write focused tests for baseline then two reports with increasing timestamps/counters, proving exact interval arithmetic for both audio/video and allowlisted output. Watch expected assertion failures before implementation.
- [ ] Implement typed functional collector with request()/stop(), baseline identity, generation fencing, asynchronous getStats scheduling and failure-isolated logging; no timers or queues. Implement missing/reset/unsupported/busy behavior against focused failing tests, covering rejected promise and throwing logger.
- [ ] Wire baseline at media readiness, changed-token requests after listeners, stop/dispose fencing. Tests must prove diagnostics do not block observation and late results cannot log after retirement.
- [ ] Run exact anchored Jest selections, no more than three actual cases per process; parse machine-readable results to confirm counts and exits. Build with npm --prefix core run build. Record commands and RED/GREEN evidence.

## Task 2: Observation-stage breakdown

Files: core/src/dh2d/avatarMedia.ts, avatarMedia.test.ts, core/README.md.

- [ ] Add deterministic-clock tests for callback entry, sample end, decode end and signed/native clock separation; original frame_timing remains exactly ten fields. Verify listeners/log ordering, unchanged no-argument requesters, null clocks and exception isolation. Watch expected assertion failures.
- [ ] Add separate observation_timing suffix with finite numeric/null timing stages and asynchronous changed-token diagnostics hook needed by Task1; do not call stats inside the canvas/stripe critical path. Keep playback listener order/behavior and original now/epoch semantics unchanged.
- [ ] Run all affected avatar-media tests in exact-name batches of at most three, selected lifecycle tests similarly; document unsupported RTCStats fields, interval arithmetic, identity/reset policy, clock domains, observer overhead and limits of inference.
- [ ] Commit only task files, preserving unrelated dirty/staged files byte-for-byte.

## Task 3: Independent gates

- [ ] Spec review against design; fix and re-review gaps. Then independent quality review; fix and re-review findings.
- [ ] Parent fresh build/regression checks, diff/whitespace review and unchanged unrelated source/index evidence. Record accepted commit SHA; never export dirty working tree as release SDK.

## Task 4: Cube build and deployment (parent only)

- [ ] Resolve live owners and obtain coordinated deployment/capture window; read-only baseline installed versions, processes, existing artifact and graphical environment.
- [ ] Export exact committed SDK core, install own locked dependencies on cube, build/pack immutable SHA-pinned tarball. Update Avatar dependency/root locks and next unused version/app lock. Preserve cube overlays/index/native provenance.
- [ ] Run official yarn build:deb:single, strict verify-deb-fast.sh with no foreign waiver, graphical native require without starting hooks; inspect bundled probe fields. Record measured times without speculative speed claims.
- [ ] Stop only exact Avatar process identity, back up stopped profile, install normal dpkg with guarded stdin privilege, verify profile unchanged before launch, actual empty dpkg-V output, ASAR hash match; launch through existing desktop environment only once. Abort on concurrent service changes until coordinated.

## Task 5: Controlled capture (parent only)

- [ ] Establish supported real installed Avatar input path and fixed harmless scenario. Do not print raw user logs or inspect credentials. Coordinate no concurrent deploy/replay work.
- [ ] One warm-up, then ten warmed transitions; preserve outliers and record all component revisions. Stop on real lifecycle/input blocker without adding timeouts/retries or silently changing test path.
- [ ] Export only allowlisted numeric/identity timing fields; deduplicate full events, partition by connection/renderer, compute interval statistics and missing-field counts. Report receiver-buffer versus delivery/decode/presentation versus sampling evidence without claiming audibility or exact same-frame identity.
- [ ] Publish local report/receipt, source commits and artifact hashes; explicitly distinguish completed, blocked and unmeasured claims. No push/public publication unless requested.
