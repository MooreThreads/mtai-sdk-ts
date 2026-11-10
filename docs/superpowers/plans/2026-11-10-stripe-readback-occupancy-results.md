# Stripe-readback occupancy experiment — 2026-11-10

## Authorization and boundaries

User requested measurement before choosing production pending-buffer capacity. This was an isolated synthetic-video experiment, not implementation or deployment of the production reader. No production queue cap, drop/backpressure rule, timeout, sampling policy, shader decoder, audio route, provider setting or app package was changed. The live Electron app remained running with PID 3897222 and was fullscreen/focused afterward. Only the separately owned benchmark Electron process was started and exited.

## Runtime and source

- Electron 35.0.3 / Chromium 134.0.6998.88.
- Benchmark Electron executable SHA-256 `a5732bcc9f9ee9ee80b09ea27348b3d044f1b1eae571935e745b0b9f031755fa`, byte-identical to the installed Avatar executable.
- WebGL renderer: `ANGLE (Moore Threads, M1000, OpenGL 4.5)`.
- SDK CPU decoder and Canvas2D sampler transpiled from `88830e91d071356fdd004cbaaeffe2e8a50a9a97` using the existing local TypeScript installation. No repository source was modified for the prototype.
- Benchmark startup switches matched the app's relevant source settings: disable GPU vsync, disable frame-rate limiter, disable VaapiVideoDecoder, permit autoplay. BrowserWindow has `backgroundThrottling:false`. It is a small, nonfocusable isolated window; it does not load the Avatar app, profile/auth, microphone, client connection or Pi backend.
- Live app/GPU workload was not stopped; this is not a controlled idle-GPU hardware characterization.

## Input and resource policy

Finite synthetic 2560×1440, 25 fps, six-second H.264/YUV420p video: 150 input frames per run, animated `testsrc2` background with a full-width 12-row V2 stripe. Forty 64-pixel repetitions contain bytes `02 01 5a 39 18 96`: token Z9, raw-active true, valid CRC. No audio track.

Each delivered rVFC submits a stripe. PBOs are allocated lazily only when no free PBO exists and are recycled after readback; no production capacity was chosen and no prototype skip/overflow policy was imposed. The finite source provides a finite experiment: at most 150 submissions per run. Readback readiness is checked in rAF, oldest ticket first, with `clientWaitSync(...,0,0)`; bytes are retrieved only after a signaled fence. All completed samples use the existing CPU decoder. Final source-end handling permits pending retirement without another video callback.

No warmup observations were removed. Initialization has its own record. Startup outliers, missing callbacks and failed alternatives remain in the receipts. Every completed sample verifies token, activity flag, all forty valid repetitions and no failed repetition. This is functional stripe evidence, not exhaustive pixel parity, damage/conflict coverage or production turn-lifecycle acceptance.

## Runs and important import-path finding

Initial run order: Canvas2D #1, WebGL `texSubImage2D(video)` #1, WebGL `texSubImage2D(video)` #2, Canvas2D #2.

The preallocated texture + `texSubImage2D(video)` path unexpectedly spent ~69–74 ms median in video import, observing only 61 and 60 of 150 presented frames. Preserved this result, then ran two additional, separately identified WebGL runs using `texImage2D(video)` instead. The alternate path observed all 150 frames in each run with ~0.3 ms median import. These later runs are not interleaved A/B controls; thermal/order/JIT effects are not isolated. The import-path difference is an empirical result on this Chromium/driver combination, not a generic WebGL guarantee or a causal driver diagnosis.

## Combined distributions across two runs per variant

All numbers below are milliseconds; nearest-rank p95/p99. "Synchronous stages" is the sum, per sample, of import/render/readback submission + CPU buffer retrieval + CPU conversion/decoding for WebGL, or Canvas2D sampling + CPU conversion/decoding for Canvas2D. It excludes uninstrumented callback/scheduler overhead and is not one contiguous blocking interval for WebGL. "Elapsed" is callback entry to completed CPU decode, including asynchronous waiting.

| Variant | Samples | Synchronous mean | Median | p95 | p99 | Max | Elapsed median | Elapsed p95 | Elapsed max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Canvas2D reference | 298 | 8.028 | 6.6 | 10.7 | 32.1 | 284.5 | 6.6 | 10.7 | 284.9 |
| WebGL texSubImage2D | 121 | 73.580 | 73.1 | 84.0 | 93.3 | 102.4 | 102.2 | 173.8 | 186.6 |
| WebGL texImage2D | 300 | 1.624 | 1.3 | 3.5 | 5.1 | 8.7 | 17.4 | 19.3 | 57.0 |

Per-run texImage2D means: import 0.461/0.550 ms; complete submission 0.561/0.658 ms; CPU readback copy 0.179/0.202 ms; conversion/decoding 0.858/0.789 ms. Different CPU decoder costs across variants can include JIT, input representation and scheduling effects; do not attribute every difference to transfer architecture.

The first Canvas2D run includes a ~275 ms initial sampling outlier. It is retained, not excluded to improve the score.

## Occupancy result

**Both texImage2D runs allocated exactly two PBOs; peak pending occupancy was two.** No configured pool ceiling forced that result.

Across 300 accepted/decoded observations:

- Occupancy after submission = 1: 277 observations.
- Occupancy after submission = 2: 23 observations.
- Occupancy above 2: none observed.
- Zero invalid packet results and zero GL errors.
- No internal gaps in rVFC `presentedFrames`; each run observed presented frames 1–150.
- Browser playback-quality counters: 150 total / 0 dropped per run.
- Submission end → first ready observation: median 15.9 ms, p95 17.1 ms, max 47.7 ms. This includes rAF scheduling delay and is **not GPU execution duration**.

The texSubImage2D runs also peaked at two pending reads, despite poor performance. Low occupancy alone therefore cannot establish acceptable sampling or low blocking: the expensive upload prevented callback delivery.

Canvas2D observed 149 frames per run, with one gap inside presented frames 1–150, while browser counters still reported zero dropped frames. texSubImage2D had 87/90 internal observer gaps and still zero browser-reported drops. Missed observer callbacks are not equivalent to dropped displayed video frames.

## Decision supported, and what is still open

The tested texImage2D/PBO/fence path substantially reduced measured renderer synchronous work, at the cost of ~17 ms median observation latency versus ~6.6 ms for the Canvas2D reference. It supports continuing with this import path, not assuming every WebGL upload is equivalent.

Two PBOs cover the measured workload. This is **not a guarantee under arbitrary delays**, and the measurement itself did not approve a production limit or skipping frames when full. **Subsequent explicit user decision:** use exactly two reusable PBOs; if both remain busy, synchronously retrieve/decode the oldest pending result and reuse its slot, rather than deliberately dropping a sample or adding buffers. Normal completion uses rAF readiness checks. The tradeoff—occasional renderer blocking at saturation—was disclosed and approved. Record saturation occurrences; no automatic pool growth, frame skipping, extra timeout or retry policy. See the [updated implementation plan](2026-11-10-asynchronous-stripe-readback.md) for all final decisions. The experiment did not force/test this fixed-capacity saturation path; implementation tests must do so.

The current benchmark uses synthetic stable-token media and a separate Electron window. It does not establish live-WebRTC video import cost, all-turn transition fidelity, hidden/minimized benchmark performance, physical display smoothness or audible output. The separate existing-app hidden callback check remains distinct evidence.

## Implemented observer validation — subsequent source slice

After the user requested implementation, the source reader/observer and a reusable isolated Electron harness were added. The first integrated performance run did **not** reproduce the prototype gain: video callback medians were ~6.4/6.65 ms and total measured callback CPU per observation ~11.16/11.26 ms, with 142/144 observations. Import remained ~0.3 ms median; the extra cost was in submission. This receipt is retained as `implemented-observer-performance.json`, with the pre-fix reader source `reader-before-hotpath.ts` in the same private directory. No result was discarded or called passing performance acceptance.

The implementation had unnecessarily queried framebuffer completeness and GL error state every submission. Framebuffer validation was moved to initialization/resize, with error checks retained on CPU readback. A new, separately named run of the actual observer/readback followed (same finite fixture, Electron binary and canvas/WebGL/WebGL/canvas order). It is not a controlled attribution experiment proving which individual query caused a driver stall.

| Actual observer run | Observed / input frames | Video callback CPU median / p95 | Retirement callback CPU median / p95 | Total measured callback CPU per observation (mean) | Observation elapsed median / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Canvas #1 | 143 / 150 | 6.8 / 35.3 ms | n/a | 10.882 ms | 6.8 / 35.2 ms |
| WebGL #1 | 149 / 150 | 0.6 / 4.7 ms | 0.1 / 2.4 ms | 3.172 ms | 18.4 / 53.8 ms |
| WebGL #2 | 150 / 150 | 0.6 / 4.9 ms | 0.1 / 2.2 ms | 3.071 ms | 18.4 / 52.2 ms |
| Canvas #2 | 142 / 150 | 6.85 / 31.9 ms | n/a | 9.840 ms | 6.75 / 31.3 ms |

Both actual WebGL runs peaked at two pending buffers; every delivered/accepted callback was decoded, but WebGL #1 had one native presented-frame gap (Canvas had seven/eight). All four browser quality counters reported 150 total, zero dropped. Retirement callback statistics include empty/not-ready polls; their 0.1 ms median is not a per-successful-read decode cost. Total CPU includes the measured video and retirement callbacks, not all browser CPU. The actual observer performs native metadata capture, tracking and diagnostic work omitted by the initial primitive prototype, so do not substitute initial-prototype numbers for this result. Context scheduling/JIT/live GPU load can differ between cohorts; physical smoothness and acoustic latency remain unproven. Synchronous stage time improves, while detection latency increases; high-percentile delays and outliers remain visible.

Receipt: `/tmp/mt-cortex-stripe-occupancy-20261110/implemented-observer-hotpath-performance.json`, SHA-256 `71579e63529439b8b6e448c3d0e61366b16461af15b29f455fd11d904b776540`. A subsequent source-only timestamp correction places `submission_end_ms` after `flush`; it does not change the command/scheduling path. Final source parity/compile checks remain separate from this dated timing receipt.

The real-Electron parity harness uses the actual built module and tests valid packets, damaged-first-copy recovery, token/activity conflicts, CRC rejection, partial trailing repetition, two-slot synchronous drain with pending dimensions changing 64→128→192, disposal and real WebGL context loss. The initial nine cases passed in Electron 35.0.3 (`implementation-parity.json`); repeat against final reviewed source without overwriting this receipt. This tests saturation API behavior; it does not force an actual long GPU stall or prove every live-WebRTC turn boundary.

## Private reproduction inputs and receipts

Directory: `/tmp/mt-cortex-stripe-occupancy-20261110/`. Do not silently overwrite these receipts.

- `results.json`: original four-run experiment (including slow texSubImage2D alternative), SHA-256 `fcbc902d4629ffc99b12b3d6f899fbdd4a0e36bbc55585bcbcb5d9f008a9ac59`.
- `results-teximage.json`: two texImage2D runs, SHA-256 `910e507d35a07c221143b66aea8bc247bf215d137e6d54463bf4976a9a9daa77`.
- `fixture-v2.mp4`: `d7c2c5d9c84e8c43ff4227ff917806d19d2192499cd938eea13d2ee4d4a10192`.
- `stripe-v2.png`: `350a6aec10be72c4710fdafa4617e1431199f6adeb0fcf7c965dfd21d0d635c8`.
- Current harness `main.cjs`: `a433eb87c76eae0d56ab465d0a7f0336cf277d0322845b8c7d479b55e3a34255`.
- Current harness `bench.html`: `39a50d98a02eaf6000e593f220319a8938809915843b2100c750d08f7b462717`.
- Transpiled `turnStripe.js`: `0f945b39b351221dfe28ec664d13a37145114a7e25f250f200fbf0153873fb52`.
- Transpiled `avatarMedia.js`: `c4247cf117d51d6e5010b4cfc13e275dc308ff00b5386680f272d3359bf14404`.

Current harness supports default `texsubimage` (the four-run sequence) and `--teximage` (two WebGL runs). The original harness was modified to add that switch after the first experiment; its raw receipt remains preserved as `results.json`, while the current default output name is `results-texsubimage.json`. Reproduction should use a newly declared output directory/run identity rather than overwrite measured receipts. No benchmark results were substituted for production acceptance.
