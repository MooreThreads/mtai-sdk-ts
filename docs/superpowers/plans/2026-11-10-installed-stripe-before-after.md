# Installed Avatar stripe-readback before/after — 2026-11-10

Identical live probe, same host/app session topology, same 2560×1440 idle DH2D stream, same ~20.005-second windows, DevTools closed during measurement, no warmup removal. Before: installed Avatar **0.1.22** (SDK 53aa9c2 content, synchronous Canvas2D). After: installed Avatar **0.1.23** (SDK commit `17946622730d157a94b88f4ceed9b60bf3fd75d7`, two-buffer WebGL2). Probe SHA-256 identical for both runs: `a4d3e2fef8cc3db1b72f610ae33915adcd82b029abc61363c9c34d556525934d`. Numbers are nearest-rank percentiles; instrumentation overhead exists in both cohorts and is not subtracted.

## Headline

| Live metric (per callback / frame) | 0.1.22 before | 0.1.23 after | Change |
| --- | ---: | ---: | ---: |
| Video rVFC callback CPU, median | 7.3 ms | **0.5 ms** | **−93%** |
| Video rVFC callback CPU, p95 | 15.6 ms | **4.3 ms** | −72% |
| Video rVFC callback CPU, p99 | 18.8 ms | **11.3 ms** | −40% |
| Video rVFC callback CPU, max | 36.4 ms | **12.6 ms** | −65% |
| Video rVFC callback CPU, mean | 8.857 ms | **1.108 ms** | −87% |
| Total measured stripe CPU per frame, mean (video + retirement callbacks) | 8.857 ms | **2.713 ms** | −69% |
| Canvas getImageData median | 5.3 ms | n/a (removed) | — |
| GL import (texImage2D video) median | n/a | 0.3 ms | — |
| GL CPU byte copy median | n/a | 0.1 ms | — |
| Callback entry → stripe bytes CPU-available, median | (same callback) | 16.7 ms | deferred |
| Video callbacks / window | 499 | 500 | comparable |
| Internal presentedFrames gaps | 2 | 0 | comparable |

After: 974 retirement animation callbacks carried stripe work (median 0.1 ms, p95 2.7 ms, max 7.4 ms); 1,015 nonblocking fence checks (median 0 ms, max 0.2 ms); zero saturation drains occurred; zero Canvas2D fallback diagnostics; backend diagnostic `avatar_readback backend=webgl2`; all 500 readbacks produced CPU bytes; video stayed unpaused readyState 4 before/after.

## Interpretation and boundaries

- The dominant synchronous cost moved out of the per-frame video callback: before, one callback did draw + getImageData + decode (median 7.3 ms); after, the video callback submits GPU work (median 0.5 ms) and bytes are retrieved on animation callbacks (~16.7 ms later, matching the earlier synthetic ~17–18 ms).
- Total measured renderer CPU per frame fell ~69%, but **turn-boundary detection latency increases** by roughly the readback wait: stripe evidence for a presented frame is now CPU-decoded ~16.7 ms after its callback rather than within it. This is the approved tradeoff; playback-boundary correctness is unchanged and no timeout/limit was added.
- This is one 20-second idle-stream window per variant on one host under ambient load, not a controlled multi-run benchmark; medians are robust here but p99/max values are load-sensitive. Presented-frame gaps (before 2, after 0) do not prove or disprove visible smoothness.
- No audible/lip-sync acceptance, no turn-transition E2E (idle stream only), no acoustic measurement, no OS-suspend case. The app reconnected to client 8780 with `avatar_attached=true, audio_attached=true`; first frame observed 2560×1440.

## Provenance and receipts

- Installed before: package 0.1.22, app PID 3897222, ASAR sha256 `21a00db1650b3c8aa283ceaa4bf137bfb0fff4df57650e3226697caaf6e8694c`.
- Installed after: package 0.1.23 (deb sha256 `d74dccca0abc1369fbe9fce56ddc5e5d1f7c46f2006f41bbd5713c3d8657f842`), ASAR sha256 `8f4e0b71cc8dcab3b167e9215f04b37d193b38ff3feb2afca0a3a434fcfda8a1`, app PID 1639155 via `mt-cortex-avatar.service`. `dpkg -V` clean; Electron source commit `6f937e614c1ff476ad5407c14348141844b62f9e` (app source byte-identical to 0.1.22's `e998d19f` snapshot except version/SDK pin/locks/docs; new SDK tarball contains every file of 0.1.22's SDK plus the reviewed readback change).
- One-shot install receipt `installation.json`; desktop profile backed up to `profile-before-install.tar` (0600) before install; exact rollback deb retained (`0.1.22`, sha256 `32bd43668af27edbabf1e51e682176666213ae29cf88ec38978fccf4497cf35c`). Sudo authentication was supplied by the user via a 0600 stdin file; the password is not stored in receipts or command text and the auth file was deleted after install.
- Raw numeric datasets: `before-raw.json` (55,121 bytes), `after-raw.json` (185,147 bytes), plus summaries and window timestamps in `~/.cache/stripe-async-local-20261110/`. Private; no screenshots/profile data published.
