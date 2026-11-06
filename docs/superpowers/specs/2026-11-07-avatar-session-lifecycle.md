# Avatar session replacement lifecycle

## Approved outcome

The user approved implementation after agreeing to this order:

`stop old retries -> finish old cleanup -> release the existing global slot -> connect replacement`

A retired frontend attempt must never clear a replacement's media. Reuse the existing SDK-wide limiter for legacy and voice modes; do not add an independent voice-mode quota.

## Context and scope

Source repository: mtai-sdk-ts. Isolated branch: `fix/voice-avatar-session-lifecycle`, based on `dfe836896eba3bf52b11bcd39cd4a5f632afed50`. The original checkout contains unrelated dirty changes and must remain untouched. This work changes SDK source and tests only, with local TypeScript builds. It does not publish packages, modify the Electron app, deploy, restart Cube, inject audio, or change the client, remote voice server, Pi backend, or DH2D renderer.

The installed frontend diagnosis is preserved privately under `/tmp/dh2d-reconnect-cube-20261106-NtcqjY/diagnosis.md`. Its old retry loop survives cancellation in backoff; failed attempts clear the shared video unconditionally; session.close releases the registry entry after its existing three-second caller wait even if the operation is still alive.

## Required behavior

1. Cancellation is terminal for an SDK connection operation. Cancellation during an active attempt, during retry backoff, before entry, or between asynchronous stages cannot create another transport attempt. Late child registrations cannot revive an aborted scope. Existing resources and abort subscriptions must be retired without leaking stale callbacks.
2. A session owns its global registration until its connection operation and owned disconnect/cleanup finish. Cancelling a queued session must not admit it. Cleanup must complete before a replacement is admitted, on both voice and legacy paths. Failure and close paths release at most once and must not leave unhandled promise rejections.
3. Preserve the existing close caller's three-second wait and return/error behavior. If this wait expires while work is still retiring, the registration remains held; release is tied to actual operation completion, not to expiration of that caller wait. The timeout itself is neither moved nor extended. A non-cooperating operation can continue holding its slot; do not force-release it or invent a new cleanup deadline.
4. Preserve the shared limiter's existing capacity and one-second admission notification delay. Recheck/claim current capacity atomically when waiters wake; a stale captured array must not admit multiple queued replacements. Do not add a second limiter or a queue-size ceiling.
5. Each voice connection attempt may detach media or alter the reconnect cover only while it owns the currently attached stream. An attempt rejected before receiving tracks owns no video. A stale abort, dispose, explicit disconnect, track event, canplay event, or delayed cover callback must not mutate replacement media/presentation or report readiness on somebody else's stream.
6. Preserve normal current-owner media cleanup, reconnect-cover behavior, successful connection behavior, legacy login behavior, voice protocol, and audio input semantics.

## Timing and runtime-policy constraints

Do not add, remove, change, relocate, or repurpose runtime/test timeout thresholds, deadlines, watchdogs, polling bounds, runtime caps, or queue limits. In particular preserve the existing 60000ms connection attempt timeout, 2000ms retry cadence, 3000ms close caller wait, 1000ms admission notification delay, 500ms cover delay, and configured reconnect/ping behavior. Cancelling obsolete work and clearing its pending callbacks on explicit cancellation is part of the approved lifecycle fix, not a new timeout policy. Tests use fake timers and causal deferred promises; do not add test timeout overrides or bounded polling helpers.

## Verification

- Establish baseline full Jest suite and TypeScript build before changes.
- Demonstrate assertion failures against the original implementation for cancellation during backoff, retaining the global slot beyond the caller close wait while cleanup is pending, and stale attempt media cleanup.
- Test already-aborted scopes, idempotent cancellation, failure cleanup, queued cancellation and competing admission waiters.
- Test both voice and legacy sessions against the real shared limiter with deferred transport/disconnect hooks. Mock transport, not the limiter or session lifecycle being asserted.
- Test real voice connection logic with the existing fake WebSocket/RTCPeerConnection/DOM fixtures: failures before tracks, replacement stream adoption, delayed cover callbacks, current-owner cleanup, and asset replacement while old retry backoff is pending.
- Run the full SDK suite and `npm run build`; preserve baseline warnings separately.
- Require independent spec and quality reviews. Report local verification separately from live deployment; no browser/acoustic or Cube-fix claim without subsequent authorized deployment verification.

## Baseline

`cd core && npm test -- --runInBand`: 20 suites, 363 tests passed.

`cd core && npm run build`: passed.

Existing ts-jest TS151002 hybrid-module/isolatedModules warnings are present before the change; changing the test/compiler configuration is outside scope.
