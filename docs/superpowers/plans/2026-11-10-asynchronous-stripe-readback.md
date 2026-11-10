# Asynchronous WebGL2 turn-stripe readback — implementation and verification record

## Status and scope

Plan, decision and implementation record. The user subsequently requested source implementation and Astra review; the reader/observer integration is implemented locally. Astra implementation specification and quality reviews both passed. The user subsequently authorized commit/push and local Electron build/install with fresh before/after measurements; publication and installation evidence are recorded separately, not inferred from review. The user separately authorized the installed-app capability/background checks and isolated occupancy benchmark recorded below, then approved the final two-buffer/synchronous-saturation policy. This update records those decisions; it does not authorize deployment, package/app build/install, live media experiments, app/service restart or audio activity. Source inspected: `88830e91d071356fdd004cbaaeffe2e8a50a9a97`, branch `feat/voice-pipeline-mvp`, `/home/mt/Work/mtai-sdk-ts`. Astra supplied architecture instructions after inspecting the source. Implementation remains inline in the parent agent; specification review precedes quality review at the completed-slice gate.

**Review:** Astra approved the plan/decision record, then reviewed the coherent implementation: **specification PASS**, followed by **quality PASS** after the bounded fixes recorded below. This includes source/test review, not installed-app/live-WebRTC acceptance, guaranteed GPU-stall behavior or deployment approval.

**Goal:** reduce renderer-thread blocking during stripe sampling by submitting GPU-to-CPU readback asynchronously, while retaining the existing CPU V2 decoder and playback-boundary semantics. This is not a promise of lower end-to-end detection latency or zero GPU synchronization.

**Non-goals:** GPU packet/CRC decoding, worker migration, new WebRTC metadata protocols, renderer/server modifications, deliberate sampling reduction/frame dropping, reading fewer repetitions, changing thresholds or existing timeouts/limits, or hiding errors through fabricated playback completion. The user explicitly approved a new two-PBO capacity and synchronous oldest-read drain at saturation; no other queue/drop/wait policy is authorized.

## 1. Evidence and current execution

- `core/src/dh2d/avatarMedia.ts`: `createAvatarFrameRequester` supplies rVFC callback arguments. `createAvatarPlayback` samples, decodes, updates its tracker, notifies listeners and schedules the next frame callback synchronously.
- `createAvatarFrameSampler` reuses a Canvas2D canvas and reads only `videoWidth × 12` pixels, not the full video. It uses `willReadFrequently:false`, then `drawImage` and `getImageData`. At width 1920 the readback is 92,160 bytes (90 KiB); at the measured current width 2560 it is 122,880 bytes (120 KiB).
- `core/src/dh2d/turnStripe.ts`: RGBA to RGB-average luminance, 4×4 cell averages, six bytes per 64×12 repetition, V2/flags/token/CRC validation, rejection of conflicting valid packets. At width 1920 there are 30 repetitions. The transition tracker retains exactly-once retirement and repeated valid observations.
- `core/src/dh2d/voiceConnections.ts` composes requester/sampler/playback through `hooks.dh2d`; lifecycle stop and accepted-output stop have existing observable receipt behavior. Receiver statistics run outside the synchronous sampling path.
- Local Electron journal on November 10: 12 unique changed-token samples (24 duplicate log records), 10:56–13:14 CST. Sampling mean 22.975 ms, median 11.45 ms; CPU conversion/decoding mean 1.75 ms, median 1.55 ms; combined mean 24.725 ms, median 13 ms, max 79.6 ms. These are not an all-frame distribution, and do not prove dropped video frames or GPU contention.
- October 26 isolated benchmark measured ~3.94 ms total for an older 8-row stripe; it is not current V2 acceptance.

### Current installed Electron capability check — November 10

The user explicitly authorized briefly opening DevTools in the existing running Electron app. An off-DOM 1×1 canvas obtained a WebGL2 context: `WebGL 2.0 (OpenGL ES 3.0 Chromium)`, renderer `ANGLE (Moore Threads, M1000, OpenGL 4.5)`, vendor `Google Inc. (Moore Threads)`. The probe cleared a known color, queued RGBA readback into a pixel-pack buffer, inserted a fence, flushed, and checked once on the next rAF with `clientWaitSync(..., 0, 0)`. Result: `condition_satisfied`, retrieved RGBA `[17,34,51,255]`, exact-byte check passed, GL error `0`. Its owned fence, buffer and temporary context were released. DevTools closure was visually verified; the existing app PID remained unchanged and the temporarily selected ASCII input engine was restored. No service/app restart, source injection into the video pipeline, audio test, provider call or configuration change occurred. Private screenshot evidence is under `/tmp/mt-cortex-webgl-probe/`; do not publish screenshots containing unrelated app UI.

This confirms WebGL2/PBO/fence availability and tiny-buffer functional readback in the actual running renderer, not video texture import, pixel parity, asynchronous stripe throughput or lower latency. The console's first typed attempt was rejected as a syntax error due to the input method; the subsequent ASCII probe completed. This is a capability check, not a repeated measured benchmark. Subsequent decisions D1–D4 are recorded below.

### Installed background-callback verification — November 10

After explicit user authorization, inspected installed Electron app `0.1.22`'s `app.asar` main bundle: the main BrowserWindow specifies `backgroundThrottling:!1` (false). A temporary renderer probe observed its own rAF and the existing active video element's rVFC callbacks; no video/audio settings or media sources were changed. DevTools was closed during all measured windows. External X window properties independently confirmed FULLSCREEN + HIDDEN / Iconic throughout the minimized interval, then Normal + FOCUSED after restoration. Each observation interval was approximately three seconds:

| Window state | rAF callbacks | rAF Hz | Video callbacks | Video Hz |
| --- | ---: | ---: | ---: | ---: |
| Visible | 172 | 57.24 | 75 | 24.96 |
| Minimized | 176 | 58.49 | 75 | 24.93 |
| Restored | 166 | 55.22 | 75 | 24.95 |

The page continued reporting `document.hidden=false` / `visibilityState=visible`, consistent with Electron's background-throttling setting; OS window state, not Page Visibility, established minimization. The same video remained connected, unpaused, readyState 4, 2560×1440 before/after. This verifies continued callback activity for this current installed app/host while minimized, not behavior under OS suspension, absent media, other Electron configurations or arbitrary GPU delays. It removes the assumed hidden-rAF blocker for this app; no new timer/worker is indicated by this evidence. The new readback scheduler itself has not been implemented or tested. Counts/intervals are preserved in private `/tmp/mt-cortex-webgl-probe/background-result.txt`. Probe callbacks/listener/global property were removed, original title/input engine/fullscreen state restored, and DevTools closure verified. Existing app PID remained unchanged.

The optimization hypothesis is avoiding an immediate CPU wait for pending GPU work. Transferring 90 KiB is small; import/conversion or synchronization may dominate. WebGL video texture import can process the whole video frame even though the render target/readback contains only 12 rows. A slower import can erase the benefit.

### First-principles conclusions and alternatives considered

- Chromium decodes/composites video on other threads; a slow JavaScript callback is not proof of an equally long video freeze. GPU copy/readback and video presentation can share resources, but today's sampling timings do not isolate GPU contention or prove visible stutter.
- Canvas2D already requests only the stripe. Delaying `getImageData` can help but offers no completion fence; a later call can still synchronously wait or copy. `drawImage` is analogous to video texture import, not guaranteed to use the identical Chromium path.
- Reducing transferred bytes can reduce transfer/copy cost, but does not remove dependencies on prior GPU work. Ordinary synchronous WebGL `readPixels` is not the selected solution. PBO readback followed by a fence, later zero-timeout status checks, and CPU retrieval after readiness is the selected asynchronous architecture.
- WebGL has no fence-completion callback; rAF checks are the scheduler, not a GPU notification. The fence must follow PBO readback, not merely GPU rendering. This avoids an intentional immediate wait in the normal path; import, driver submission and CPU retrieval can still have costs/stalls. It does not guarantee zero GPU bubbles or minimum end-to-end detection latency.
- GPU cell reduction/full stripe decoding could transfer fewer bytes and reduce CPU work, but requires more shader complexity and benchmarking. Keeping CPU decoding isolates the larger synchronization/import change first. Moving synchronous work to a worker relocates blocking rather than automatically eliminating GPU dependencies.
- Frame-associated WebRTC metadata was considered but not selected. Matching rVFC RTP timestamps would require actual outgoing packet timestamps, stream/connection identity, wrap/rewrite handling and out-of-order metadata behavior; render timestamps or unsynchronized data-channel messages are not equivalent. That is a separate protocol change, not this SDK sampling optimization.

## 2. Final user decisions — D1–D4 resolved

These are explicit decisions from this conversation, not implicit permission to add other limits, timers, dropping or lifecycle policies.

### D1 — animation callbacks check readiness; do not wait normally

Use a main-thread `requestAnimationFrame` retirement pump only while accepted readbacks are pending. Each animation callback checks the oldest fence with `clientWaitSync(fence, 0, 0)`; retrieve bytes only when ready, otherwise return and check on the next animation callback. Drain ready results in submission order. No always-running pump when idle, timer fallback, busy-spin or dependence on a future video callback.

The user required continued completion while the window is hidden/minimized. Installed-app verification confirmed `backgroundThrottling:false` and continued rAF/rVFC while minimized, with DevTools closed. Therefore no new Electron setting, worker or hidden-window timer is needed for the current app. OS suspension, missing video, context loss and other hosts/configurations are not covered by that evidence; do not promise progress when the process/OS itself is suspended.

### D2 — exactly two PBOs; synchronously drain the oldest only at saturation

The user approved **two reusable pixel-pack buffers**. Peak occupancy in the isolated fast-path experiment was two, without a configured measurement ceiling. Both runs observed/decoded all 150 presented frames (300 total). This supports the count, not a guarantee that every workload will avoid saturation.

For each delivered video callback:

1. Retire any already-ready older samples in order where necessary to establish capacity.
2. If both slots remain occupied, synchronously retrieve and decode the **oldest** pending read, then reuse its slot for the current submission. This is the sole approved blocking exception.
3. Do not skip the incoming sample, overwrite a pending result, pause the observation loop waiting for a later callback, allocate a third buffer or grow an unbounded queue.

The asynchronous rAF path remains normal operation. Synchronous saturation draining deliberately trades a possible renderer stall for avoiding intentional loss of stripe evidence. It cannot guarantee every displayed frame generates an observation; the browser can still omit callbacks while JavaScript is busy. Capture/import/render the current video stripe before a potentially blocking saturation drain where needed so that the implementation does not deliberately resample a later video frame under the old callback metadata. Preserve the captured target/context through the drain, revalidate observer ownership after listener calls, and submit only if that observer is still active.

Record saturation occurrences and synchronous-drain duration. Frequent saturation triggers a report/design decision, not automatic pool growth, threshold changes, extra deadlines or frame dropping. Use the PBO's synchronous `getBufferSubData` path for the approved drain; do not introduce `gl.finish`, busy-waiting, or a new timed fence wait. The forced-read operation may block; no new cancellation deadline or GPU completion guarantee is implied.

### D3 — keep reading across turn-end events

The user explicitly rejected discarding all pending reads or stopping observation on an ordinary turn-end event: a pending frame may already contain a new turn.

- Preserve immediate existing explicit lifecycle/accepted-output stop behavior; do not wait for GPU completion merely to acknowledge an already-supported end.
- A targeted end retires only its matching turn. Later evidence for that retired turn cannot resurrect it or cause a second end; a new turn is accepted normally.
- An untargeted end retains the existing tracker's `endCurrent` meaning: retire the currently observed turn, if any. Do not reinterpret it as ending an as-yet-undecoded, unknown turn; do not invent a turn identity. The existing API cannot retire an unknown turn without identifying it.
- Keep sampling, retain and consume pending reads in order, and let the existing tracker reject retired IDs while accepting later valid turns. Do not add a blanket pending flush/discard or reset the tracker on a normal end.
- Actual observer stop/disconnect/restart invalidates its pending work. The separately approved context-loss fallback in D4 is the explicit backend-failure exception, not normal end behavior.

Tests must cover pending A evidence after A ends, pending new B evidence around A's end, untargeted end with/without an already observed current turn, and continued observation after each case.

### D4 — Canvas2D fallback approved

If WebGL2/PBO/fence initialization is unavailable, use the existing Canvas2D sampler and identify the backend diagnostically. On WebGL context loss, invalidate the old backend's pending observations and switch to Canvas2D; stale WebGL completions must never overtake or alter newer fallback observations. Preserve the observer's existing turn tracker and retired-turn knowledge across backend fallback rather than treating it as a fresh voice session. Failed/lost GPU work is not successful playback or an idle token.

No automatic WebGL retry/recovery timer, disable-observation fallback, provider change or app restart is authorized. The installed capability check passed, but fallback remains required.

### D5 — measured import path and retained CPU decoder

Use the measured fast **`texImage2D(video)`** import path; do not substitute `texSubImage2D(video)` as an assumed optimization. On this Electron/ANGLE/driver combination, the latter blocked ~69–74 ms median per upload and missed many observer callbacks despite low PBO occupancy. The former imported in ~0.3 ms median and observed all 300 presented frames.

Retain full-width × 12 RGBA readback and the existing CPU V2 decoder. GPU decoding/cell reduction and worker migration were considered but are not selected for this slice. See [full measurements and limitations](2026-11-10-stripe-readback-occupancy-results.md). Initial policy questions are resolved. The implementation, final focused lifecycle/parity validation and Astra specification/quality gates now pass. Installed activation/live-WebRTC acceptance remains separate.

## 3. Minimal module boundaries

### A. `turnStripe.ts` — unchanged CPU decoder and tracker

Keep existing callable APIs, full-width repetitions, CRC, conflict detection, activity flag and invalid/idle behavior. Do not optimize its allocations in this slice: that obscures attribution and is not the bottleneck being tested.

### B. New `avatarStripeReadback.ts` — state-owning GPU resources

One readback instance per active observer generation owns:

- A dedicated, non-presented WebGL2 canvas/context, shaders/program, quad geometry and video texture.
- A full-width × 12 RGBA8 framebuffer target.
- Exactly two reusable PBO slots and per-submission fences/storage ownership, with D2's explicit saturation handling.
- Context-loss listener and explicit disposal state.

Conceptual operations (final names follow supported API conventions):

- `submit(video, submissionContext)`: capture pixels now and enqueue stripe rendering/PBO readback; return an accepted ticket or an explicit unavailable/saturated/error outcome. It does not silently grow, drop or block. Separate capture/preparation from enqueue if necessary to preserve current pixels during D2 saturation handling.
- `retireReady()`: inspect the oldest accepted ticket without blocking; return completed top-down RGBA samples in submission order. Do not advance past an unresolved older ticket merely because a later one appears ready.
- `retireOldestBlocking()`: retrieve the oldest pending sample synchronously for the observer's explicitly approved saturation path; return its original context and bytes. The observer decodes it before admitting the current readback. This is not used by normal rAF retirement or disposal.
- `dispose()`: delete owned fences/PBOs/GL objects where valid, detach context listeners, reject further work and invalidate result delivery. Do not wait for GPU drain or call `finish`.

A completed sample contains the immutable submitted context, width/height, RGBA bytes, and stage timestamps. It need not manufacture browser `ImageData`; the existing decoder accepts an ImageData-like object. CPU buffer reuse must not mutate a sample until its synchronous consumer is done.

This module knows nothing about turn lifecycle, websocket messages, playback receipts or receiver statistics. It owns state, rather than becoming a stateless behavior-wrapper class.

### C. `avatarMedia.ts` — observer state and ordering

Retain `createAvatarPlayback` as the sole owner of tracker/lifecycle/listeners. Split its execution into:

1. Capture callback metadata and submit a sample.
2. Decode and consume an available sample.

The first phase runs in the rVFC callback; the second may run in the approved retirement pump. Both synchronous Canvas2D and asynchronous WebGL samples enter the same consumption path. Keep production fallback and benchmark selection explicit through a small state-owning sample-source interface; do not duplicate the tracker or entire observer.

Retain the exported synchronous sampler API for existing consumers/tests. Add a separate asynchronous factory seam instead of changing a synchronous return type into a Promise behind callers' backs. The chosen observation policy is owned by the observer, not the GL module.

A submission context contains observer generation, sequence, dimensions, callback `now`, allowlisted native metadata snapshot and performance origin. Use the snapshot when consuming; never read metadata from a later callback. Import video immediately at submission, not retirement.

**Evidence limitation:** importing an HTMLVideoElement during rVFC associates the sample with that callback operationally; it does not independently guarantee the imported pixels identify exactly the native frame represented by its RTP timestamp. Do not upgrade today's timing correlation into an exact frame-identity claim.

### D. `hooks.ts` and `voiceConnections.ts` — composition only

Introduce the readback factory and approved retirement scheduler seams through existing DH2D hooks. Connect/dispose owns one observer generation and its resources. Preserve unavailable-rVFC behavior, pending accepted-output stops, receiver-stat correlation and no independent audio owner. Avoid new playback managers, dispatchers or duplicate lifecycle stores.

## 4. GPU command sequence

For each admitted video callback:

1. Snapshot source geometry and native metadata safely.
2. Establish/resize stripe targets and per-slot byte storage as necessary, retaining exactly two slots. Preserve old pending PBO bytes and dimensions; resize does not authorize dropping or reallocating over pending evidence.
3. Import the video with `texImage2D(video)` on every admitted frame, as measured; do not replace recurring imports with `texSubImage2D(video)`. Use nearest filtering and explicit unpack/orientation/color settings validated against the reference; do not assume defaults reproduce Canvas2D.
4. Render only the source's top 12 rows to a `width × 12` RGBA8 framebuffer. Specify pixel-center mapping, clipping, viewport, blending/dithering state and row orientation so no scaling/interpolation silently changes bits.
5. Establish a free slot. Normally consume already-ready results as appropriate; if both remain busy, D2 permits synchronously retrieving/decoding only the oldest read before reusing its slot. Keep the current captured stripe and metadata intact, and recheck generation/stop after listener delivery. Bind the freed/available PBO and issue `readPixels(0, 0, width, 12, RGBA, UNSIGNED_BYTE, offset=0)` into it.
6. Insert `fenceSync(SYNC_GPU_COMMANDS_COMPLETE, 0)` **after** readback, then `flush()` to submit work. Do not use `finish`; immediate retrieval of an unfinished older buffer is reserved for D2 saturation, not the ordinary path.
7. Return promptly and schedule retirement according to D1.

At retirement:

- Call `clientWaitSync(fence, 0, 0)` once per approved retirement opportunity.
- `TIMEOUT_EXPIRED` means not ready, not an application timeout/failure. Do not spin.
- `ALREADY_SIGNALED`/`CONDITION_SATISFIED`: call `getBufferSubData`, normalize rows as required, and pass bytes to the existing CPU conversion/decoder.
- `WAIT_FAILED` or context loss follows the explicit error/fallback policy; never synthesize an idle token or a playback completion.
- Release fence/slot ownership after consumption, not before bytes are safely used.

The fence covers queued readback completion, but `getBufferSubData` still incurs CPU copying/browser overhead. The video import can still synchronize. This architecture avoids an intentional immediate readback wait; it does not promise a nonblocking duration for every driver call.

## 5. Observation and cleanup laws

- Accepted samples are consumed once in submission order.
- Repeated validated tokens still invoke the current-turn observation callback; only actual transitions retire a previous turn.
- Invalid/ambiguous/CRC-failing samples never mean idle or playback ended.
- Preserve listener ordering: previous-turn end → current-turn observation → diagnostics → deferred changed-turn receiver-stat hook.
- Use actual decoding/observation time for observation clock stamps, not a backdated callback timestamp.
- Stop synchronously fences future delivery, cancels registered callbacks and the approved retirement pump, and releases references/resources without awaiting GPU work.
- Reconnect/restart creates a fresh generation. Late ready signals and asynchronous diagnostic continuations from an older generation must not reach the new session.
- Resize does not reinterpret pending bytes using new dimensions or discard them without the approved policy.
- Explicit targeted/untargeted lifecycle behavior follows D3, with API-visible tests. Keep reading and preserve pending evidence across normal turn ends. GPU work completion never overrides an already retired turn; new turns remain observable. Context-loss fallback invalidates only the old backend's pending work and preserves tracker knowledge.
- Diagnostic sink exceptions do not alter scheduling or playback events.

## 6. Timing and diagnostics

Preserve the ten existing `frame_timing` keys and their units/null/signed-delta semantics: `callback_now_ms`, `receive_time_ms`, `presentation_time_ms`, `expected_display_time_ms`, `processing_duration_ms`, `presented_frames`, `rtp_timestamp`, `time_origin_ms`, `receive_to_presentation_ms`, `presentation_to_callback_ms`.

For async sampling, define `sampling_end_ms` as the instant bytes are CPU-available and `decoding_end_ms` as CPU decoding completion. Existing callback-to-sampling/decoding fields will include elapsed asynchronous waiting; document this explicitly. They must no longer be interpreted as renderer CPU blocking duration.

Add a separately named readback timing object for backend and actual stage evidence:

- video-import call start/end;
- render/readback submission start/end;
- first fence-ready observation;
- CPU buffer retrieval start/end;
- CPU decode start/end;
- original submission sequence/generation for correlation;
- saturation occurrence/count and synchronous-drain duration, separately identified from the normal asynchronous path. No automatic capacity or scheduling change follows from a counter.

Fence-ready observation includes scheduler/polling delay and is not exact GPU completion time. Do not label it GPU execution duration. Keep normal production records sparse as today; use a private benchmark collector for every sampled frame. No raw pixels, tokens beyond existing diagnostic scope, credentials or private content in public reports.

## 7. Work slices

### Slice 0 — decisions and preliminary measurements recorded

D1–D4 and the import-path choice are resolved above. Installed WebGL/PBO/fence capability, background callback continuity and preliminary finite-source occupancy/performance were measured under separate user authorization. Do not rerun or replace those receipts silently. Next work is source implementation, with focused validation and Astra review—not installation or a new live test.

### Slice 1 — GL backend and pixel parity

Add the resource-owning module and deterministic tests. Establish real Electron parity using isolated fixture video: all repetitions, row orientation, cell boundaries, color conversion, invalid CRC, corrupted first copy, conflicting valid copies and activity-bit conflicts. Preserve the Canvas2D reference.

Do not declare GPU optimization successful based on mocked GL tests. No public default switch yet.

### Slice 2 — coherent async observer integration

Refactor sample consumption once; wire hooks/connection ownership and approved scheduling/backpressure/lifecycle decisions. Migrate affected timing and connection tests together. Keep synchronous compatibility path tested. Use specification review then quality review only after this coupled lifecycle slice is coherent.

### Slice 3 — production-implementation validation and adoption

The preliminary isolated benchmark is complete and preserved in the linked report. It measured an experimental reader, not the final two-slot/synchronous-saturation observer. Validate the actual implementation with separately authorized real-Electron parity/performance runs, explicitly including saturated operation and final pending retirement. If CPU blocking or presentation worsens, report it; do not tune thresholds, add buffers, drop observations or hide outliers to produce a win. Preserve the approved fallback and update the README/report with exact evidence boundaries.

## 8. Tests and acceptance

Focused source files: `avatarMedia.test.ts`, `turnStripeV2.test.ts`, applicable `turnStripe` tests, `voiceConnections.test.ts`, `voiceConnections.receiverStats.test.ts`, `hooks.test.ts`; new readback-specific tests belong beside the module. Follow existing bounded named test-batch conventions; no whole-suite or new test timeout changes.

Assert supported API outcomes, not private pool layout or incidental GL helper choreography:

- no CPU result delivered before simulated fence completion;
- last pending frame retires without another video callback under the approved scheduler;
- delayed/out-of-order readiness cannot reorder observed turns;
- metadata belongs to submission and is not reused from a newer callback;
- unchanged current-token repeats, transition/end receipts and first-active behavior;
- stop/restart/dispose/context loss prevent stale listener delivery;
- targeted and untargeted lifecycle ordering under pending work;
- resize preserves accepted data interpretation;
- with both slots busy, oldest-result decode occurs before reuse; current/new-turn evidence is not deliberately dropped, a third buffer is not allocated, and saturation is reported;
- normal turn end retains pending A/B reads and continued sampling, while retired A cannot be resurrected and new B remains observable;
- startup capability failure and runtime loss use the approved fallback semantics;
- diagnostics retain existing native fields and distinguish CPU work from async elapsed time.

Use isolated browser integration for real GL semantics; deterministic fake completion tests establish orchestration only. Do not add production inspection hooks solely for tests.

## 9. Benchmark protocol and reporting

Compare the current Canvas2D path with WebGL2/PBO full-stripe readback + unchanged CPU decoder. Use identical fixture/video settings and geometry, current Electron/GPU configuration, named source revisions and equal declared run conditions. Alternate variants to reduce order/thermal bias. Log initialization separately rather than hiding it in an unexplained warmup. Do not run both samplers simultaneously against the same live stream and call the result uncontended.

Collect raw per-observation stage times and aggregate mean/median/p95/p99/max, counts, unavailable/error observations and approved pending occupancy/saturation events. Measure both:

1. Renderer synchronous work: import/submission, retrieval, CPU decode.
2. End-to-end observation latency: source callback to completed decode.

Also record available browser presentation/drop counters with their limitations: missed observer callbacks are not automatically dropped video frames; `presentedFrames` gaps alone do not prove a display freeze. Preserve incomplete runs and outliers. No claimed acoustic timing or physical-display acceptance from compositor timestamps.

Success requires preserved behavioral laws plus demonstrably lower renderer blocking without an unacceptable agreed observation-latency or sampling-loss tradeoff. Numerical acceptance thresholds must be agreed, not invented here. If import dominates, report that evidence before proposing worker/video-frame API or GPU-reduction followups.

## Specification review fix plan — bounded to the approved slice

Astra's first implementation specification review found two P2 gaps, not a rejected architecture: (1) add actual CPU decode start/end to async diagnostics, preserve existing elapsed timing fields and document batching/listener effects; this is required by §6 and avoids falsely calling an elapsed interval CPU work. (2) independently control fence readiness and test no overtaking plus listener-triggered stop/restart during saturation and batched retirement, including prepared incoming/remaining old evidence and deferred hooks; these are the existing ownership/order laws in §5/§8, not new guarantees. Add only these tests/diagnostics, run focused batches and re-request specification review before quality review. No timeout, capacity, recovery or dropping change is included.

## Quality review fix plan — harness-only

After specification PASS, Astra quality review found no production-path blocker and requested two bounded harness fixes: (1) a WebGL-designated measurement must fail if any runtime Canvas2D fallback appears, retaining the mixed-backend receipt rather than presenting it as a WebGL success (§9 evidence integrity); (2) temporary benchmark profiles must be removed on the actual explicit exit path for both success and failure, because `app.exit` bypasses `will-quit` (§7–8 owned cleanup). Fix only those paths and verify exit/cleanup in isolated smoke runs. The initial attempt to remove the profile immediately before `app.exit` was experimentally insufficient: Chromium recreated profile files during shutdown. A small Node test launcher must therefore own the private profile and remove it after the Electron child has exited, preserving the child exit status. Verify both parity-success and missing-fixture failure with no newly remaining profiles. This is required harness cleanup, not a production manager or new runtime mechanism. No remeasurement, production behavior change, timer, dependency refresh or new policy is included.

## Implementation checkpoint

- New state-owning `core/src/dh2d/avatarStripeReadback.ts`; existing CPU `turnStripe.ts` unchanged. Shared observer consumption and generation fencing in `avatarMedia.ts`; factory wiring through hooks/connection composition; retained synchronous sampler API and README updates.
- `npm run build` passes. Final named seven-file Jest batch: **224 passed** (59 observer/async/V2/receiver-stat and 165 tracker/hooks/connection). Four Node harness result-contract cases also pass. Twelve new async observer API cases, including independent readiness and listener-triggered restart; no existing tests were deleted or weakened. The ts-jest configuration and open-handle warnings were independently reproduced in an unchanged `88830e9` archive at `/tmp/stripe-sdk-baseline.8fASjE`: all 212 baseline cases pass with the same warnings. No timeout or dependency policy was changed to suppress them.
- Final isolated Electron parity: **nine cases passed** on the built implementation, including synchronous capacity drain/resize and actual context loss (`quality-launcher-success.json`, exit 0). Missing-input smoke exits 1 with an explicit failed receipt (`quality-launcher-missing-input.json`). Both launcher runs leave **zero newly remaining profiles**. Source harness is under `core/integration/stripeReadback/` (part of this source slice); no normal app profile/audio/voice services are loaded. Runtime fallback benchmark rejection is covered by the four Node result-contract tests; no performance cohort was rerun to repair its success predicate.
- The first integrated performance run regressed; its receipt/source snapshot are retained. Removing redundant per-frame GL/framebuffer status round trips restored the fast path. Actual observer measurements, including increased elapsed observation latency and retained outliers, are recorded in the [measurement report](2026-11-10-stripe-readback-occupancy-results.md). No production limit or timeout was tuned to obtain a pass.
- Astra final specification/quality reviews: **PASS / PASS**. `git diff --check` passes; no existing test assertions were weakened/deleted and no original production files outside this source slice were modified.
- No SDK pin refresh, Electron re-vendoring/build/install, live provider call, production restart/deployment performed during the implementation/review slice. Subsequent user-authorized publication and local Electron rollout are separate operations. The source build is the SDK TypeScript compilation, not an Electron app build or installed activation.

## 10. Deliverables and boundaries

- Reviewed plan with D1–D4 resolved.
- One resource-owning GL module, one shared observer consumption path, minimal composition changes.
- Focused API/lifecycle tests and real Electron pixel-parity results.
- Reproducible private benchmark harness and sanitized aggregate report.
- Updated README with backend selection, timing semantics, limitations and rollback to Canvas2D.

No SDK pin refresh, Electron re-vendoring/build/install, production service restart, live provider call or deployment follows automatically. Those require a separately scoped request and selected destination. This plan intentionally does not guarantee zero GPU stalls or lowest detection latency.
