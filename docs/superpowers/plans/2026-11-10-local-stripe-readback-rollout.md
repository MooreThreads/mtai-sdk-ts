# Local Electron stripe-readback rollout — 2026-11-10

User requested: measure current installed behavior, commit/push the reviewed SDK, build Electron from `~/Work/2d-digitalme-web` with that exact SDK, install locally, measure again and compare. Source/build/installation host for this operation is the current ARM64 workstation. Client, Pi backend, server and DH2D renderer are not authorized for restart/deployment by this Electron request.

## Fresh before measurement

Installed Avatar package 0.1.22, existing app PID 3897222. `dpkg -V 2d-digitalme-avatar` returned success with no changes. The original process command, graphical environment, cwd and ASAR hash were preserved privately. This is independent of the earlier turn-change-only logs and synthetic benchmarks.

The live probe wraps the existing primary video rVFC callbacks, existing rAF callbacks and stripe-specific Canvas2D/WebGL calls. It does not create an extra video observer, change the media source, feed speech, touch audio or replace SDK behavior. Only numeric timing/geometry is exported. The probe is restored/removed after collection. Its SHA-256 is `a4d3e2fef8cc3db1b72f610ae33915adcd82b029abc61363c9c34d556525934d`; use identical code after upgrade. DevTools is closed during the measurement window. This instrumentation has overhead; use it consistently rather than equating these observations to an uninstrumented CPU profile.

Before window: 20,005 ms, Unix milliseconds 1794312346729–1794312366734. Video remained unpaused, readyState 4, 2560×1440 before/after. 499 video callbacks; two internal `presentedFrames` gaps. Callback gaps do not prove physical display drops or a video freeze. No stripe-related rAF work was observed in the synchronous baseline.

| Before metric | Mean | Median | p95 | p99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Existing video callback CPU elapsed | 8.857 ms | 7.3 ms | 15.6 ms | 18.8 ms | 36.4 ms |
| Canvas drawImage | 0.474 ms | 0.4 ms | 1.0 ms | 2.8 ms | 4.0 ms |
| Canvas getImageData | 6.790 ms | 5.3 ms | 13.1 ms | 16.3 ms | 32.6 ms |

Statistics are nearest-rank percentiles from all matching callback/call observations in the selected window, without warmup removal or clipping. Raw numeric records, private process/profile evidence and screenshots are under `~/.cache/stripe-async-local-20261110/`; do not publish profile data or screenshots containing unrelated UI.

A large document-title export was truncated by window-manager title handling; it was rejected as invalid JSON, not treated as complete evidence. The complete already-recorded dataset was then exported once to an owned one-shot loopback collector with no credentials and mode 0600. The collector exited after POST. No case replay or substitution occurred.

## Pending installation boundary

Noninteractive root authorization was unavailable (`sudo -n true` failed; no passwordless dpkg permission). Build/publication can proceed without root. Package installation requires the user's local authentication; never ask for or log a password. No after-install measurement or before/after improvement may be claimed until the selected package is actually installed/launched and the identical probe is repeated.

The source Electron checkout has unrelated untracked cache/build reports; build from a clean isolated snapshot of its current committed source and preserve those files. The installed version is newer than the source checkout's package metadata (source 0.1.12 vs installed 0.1.22), so use a new version rather than downgrade/reuse an old artifact identity. Preserve an exact rollback deb and desktop profile/authentication. Verify packed SDK provenance, final deb permissions/integrity, installed ASAR, app startup and all unchanged non-Electron components. No timing, queue, audio, provider, authentication or permissions workaround is authorized to obtain a good measurement.
