# Holistic review verdict

**Keep the core architecture, but stop expanding isolated component slices. The migration is substantially implemented internally, yet remains incomplete as a product.**

The fragmentation is real: native ownership layers and increasingly elaborate fake-driven cleanup contracts have received repeated review while the supported SDK entry points, combined readiness/lifetime owner, actual app cutover, and production artifact path remain absent.

This does **not** justify discarding the native joins, protected-turn audio accounting, single-surface reuse gate, or retained WebGL cover. Those serve genuine requirements. The efficient replacement is **three integration-focused implementation slices, followed by qualification**, not another series of individually approved wrappers.

I found one concrete native control-flow defect and one small baseline-compatibility divergence. The larger findings are missing integration—not claims that the unchanged app has already regressed.

## Evidence boundary

This was read-only. I ran no tests, builds, probes, devices, deployments, or other agents; made no edits; and did not open DH2D `AGENTS.md` or private evidence.

Reported **15 suites/498 tests** and earlier **five native batches/13 goldens** remain inherited checkpoint results. They do not establish packaged Electron, GPU, PipeWire, AEC, or whole-product acceptance.

Paths below use:

- **D:** `/home/mt/Work/dh-2d-sharedtexture`
- **S:** `/home/mt/Work/mtai-sdk-ts-conversation-native`
- **A:** `/home/mt/Work/2d-digitalme-sharedtexture`

# Prioritized findings

## 1. P1 — Scoped stop is blocked behind whole-stream EOS drain

**Evidence:**  
`S/core/native/async_playback.cc:37–45,60–69`  
`S/core/native/pipewire_output.cc:128–144`

`stop()` and `end()` enter the same serialized command queue. Processing `End` calls blocking `end_and_drain()`, which waits first for PCM handoff and then PipeWire drain. A subsequently queued `Stop(A)` cannot execute until those waits finish. Full close has a separate cancellation wake; scoped stop does not.

Thus the SDK can issue its permitted immediate lifecycle receipt while native A cancellation remains trapped behind playback/drain. This is a source-level defect in the proposed consumer, not a demonstrated shipped-app failure.

**Requirement:** Plan §§6–7: exceptional stop remains usable, affected native PCM must actually be stopped, and whole-source EOS/drain remains real. Neither operation becomes normal turn completion.

**Replacement:**

- Make pending EOS drain compatible with servicing scoped controls on the existing native owner.
- Prefer an **event-driven drain begin/completion state**, rather than blocking the sole command worker through the entire drain.
- Do not use permanent whole-output cancellation as the implementation of `stop(A)` when B is protected.
- Add focused public-operation witnesses for stop during both handoff wait and downstream drain, including protected/unknown B.
- Preserve real drain, RT barriers, and joined close. Add no polling policy, watchdog, timeout, or per-turn drain.

## 2. P1 — The combined SDK attachment owner is missing; the pieces cannot simply be connected by callbacks

**Evidence:**  
`S/core/src/voice/avatarMediaHost.ts:21–35`  
`S/core/native/local_media_connection.cc:37–50`  
`S/core/native/node_connection.cc:70–83,99–103,140–147`  
`S/core/src/electron/mainTexture.ts:8–21,44–47,110–121`

The current pieces deliberately leave these responsibilities to a future owner:

- Establish the trusted named `SOCK_SEQPACKET` connection.
- Load the production addon.
- Join actual GPU acceptance with actual audio acceptance before READY.
- Resolve attachment only after selected ATTACHED.
- Authenticate current-main-frame IPC.
- Stamp submission receipt using native monotonic time.
- Route paired eligibility, healthy applied observations, scoped stops, EOS, and failures.
- Join texture, allocation-FD, audio, native, and environment retirement.

There is also a specific ownership seam: `TextureOutput` borrows the allocation FD, whereas `NodeConnection::finish()` releases that descriptor on native retirement. Native connection failure/environment cleanup can retire independently. A future host must explicitly close this contract; ordering ordinary application `close()` calls is insufficient.

That is an **unresolved ownership contract**, not proof of an existing GPU use-after-free.

**Requirement:** Plan §§4,6–7: SDK-owned media, acyclic readiness, authenticated submissions, lossless identities, and actual resource joins.

**Replacement:**

Create one attachment-scoped SDK owner around the existing internals—not another public adapter framework.

It must own or explicitly transfer/duplicate allocation custody so socket retirement cannot invalidate the texture owner’s required lifetime. It must also distinguish:

1. GPU/audio acceptance;
2. selected attachment;
3. first healthy frame submission;
4. source-reuse permission;
5. native retirement.

Do not translate `audioReady`, constructor success, or a mounted canvas into combined readiness.

## 3. P1 — Production packaging is missing on both sides

**Evidence:**  
`D/src/local_media/native_surface.py:35–44`  
`D/src/local_media/native/build.sh:3–14`  
`D/tools/build_frozen.py:368–379,1213–1215`  
`D/src/setup.py:34–40`  
`S/core/package.json:12–16`  
`S/core/native/test-node.sh:7–18`  
`A/package.json:132,169,219–227`  
`A/release/app/package.json:17–19`

The DH2D loader expects `libdh2d_rgba.so`, but the inspected frozen-build path builds the existing NVP libraries and has no corresponding RGBA build/staging integration.

The SDK package still builds with `tsc`. The native test script compiles addons into a caller-supplied directory; that is not a production artifact/load/install contract.

The app still references the old SDK tarball and Electron `^35.0.3`. Its separate runtime dependency manifest does not provide the new SDK native artifact.

**Requirement:** Plan §§4,9,11: exact, reproducible, packaged Linux ARM64 replacement.

**Replacement:**

- Integrate the DH2D RGBA library into the actual frozen/package build and loader location.
- Define SDK production native build/staging/loading, platform support, required runtime libraries, and main/preload/React entry points.
- Keep test-fixture exports out of the production addon.
- Verify app bundling, externalization and ASAR placement against its actual two-package layout.
- Pin and qualify the selected Electron release; `40.10.6` is a candidate, not inherited acceptance.
- Record matching artifact hashes. A source-tree library, test addon, or manual overlay must not count as delivery.

## 4. P1 — Public caller cutover is still absent, including several nontrivial preservation obligations

**Evidence:**  
`S/core/src/index.ts:1–24`  
`S/core/src/dh2d/sessions.ts:170–184`  
`S/core/src/dh2d/hooks.ts:29–57`  
`A/src/renderer/page/dh2d.tsx:524–539,1074–1085`  
`A/src/renderer/page/FlvPlayer.tsx:109–116,503–521,642`  
`A/src/main/main.ts:959–965`

The app still calls `createDH2DSession`; the public SDK still selects legacy connection hooks and exports RTC/stripe facilities. No supported installed path reaches the new conversation/native/texture implementation.

The remaining app work is small in API surface, but not merely replacing a `<video>`:

- `wsOpen` currently controls conversation/window behavior.
- Outer-container opacity also affects the QR-containing hierarchy.
- Avatar-switch completion needs selected-session connected **and** media-ready qualification.
- The app’s player override still dereferences video/cover elements.
- Hidden/pet operation must retain one conversation and one avatar audio owner.

**Requirement:** Plan §§4–5,8,11: video/cover-only replacement, independent QR/conversation lifetime, preserved status/input/window semantics, and no hidden RTC fallback.

**Replacement:**

Cut over the public session facade, SDK presentation component, and actual app callers together. Preserve the outer QR container and existing workflow. Move initial media hiding to media content only. Keep `wsOpen` as conversation availability.

Preserve the existing **30,000 ms avatar-switch timeout, placement, and failure behavior**. Do not introduce another readiness timeout.

Remove obsolete SDK RTC/stripe implementation and exports after auditing consumers; preserve independent DH2D RTC/RTMP modes and microphone APIs. Remove or adapt the obsolete app player override rather than leaving a type-compatible stub.

## 5. P2 — Fake-interface failure/reentry behavior has become an unjustified contract expansion

**Evidence:**  
`S/core/src/electron/textureReceiver.ts:18–19,27–33,63–100`  
`S/core/src/electron/textureReceiver.test.ts:51–72,79–139`  
`S/docs/implementation/sharedtexture-preload-spec-fix3-plan.md:1–3`

Tests require, among other things:

- Fake `VideoFrame.close()` throwing and later succeeding.
- Fake `release()` recursively delivering another imported video.
- Multiple nested failed owners.
- Immediate explicit retry from a waiter registered inside fake drawing.

These demonstrate what the structural fake permits. The inspected production integration does not yet establish those traces as supported Electron behavior.

Some reentry protection is necessary: application callbacks can synchronously detach or close, and real native retirement can fail. The mistake is treating **every arbitrary method substitution** as a product obligation.

**Requirement:** Preserve genuine resource custody and failure fencing—not universal recoverability from invented interface behavior.

**Replacement:**

- Freeze further expansion of this test-derived contract.
- Bind the receiver to the actual supported Electron/VideoFrame wrapper and enumerate its real callbacks and failure outcomes.
- Retain active-work fencing, idempotent close, no-success-after-failure, and custody of genuinely uncertain resources.
- Keep explicit retirement retry only where an actual underlying operation supports meaningful retry.
- Remove unsupported recursive fake scenarios as mandatory acceptance criteria; simplify their machinery when integrating the real wrapper.

Do not turn simplification into another standalone rewrite campaign. Perform only the pruning justified by the real integration boundary.

## 6. P2 — Empty explicit-stop identity no longer follows the existing fallback

**Evidence:**  
`S/core/src/dh2d/voiceConnections.ts:440–442`  
`S/core/src/dh2d/avatarMedia.ts:251–254`  
`S/core/src/voice/conversation.ts:278–285`

The legacy path treats an empty `turn_id` like an absent ID and retires the observed current turn. The extracted conversation accepts any string as the target, so `turn_id: ""` is ignored.

This is a concrete behavior divergence, **not evidence that the current client emits empty IDs**.

**Requirement:** Preserve existing explicit-stop handling without silently tightening the unchanged contract.

**Replacement:** Use the legacy nonempty-string normalization, then capture the current turn before native dispatch. Add one regression test; retain the rule that captured stop(A) cannot retire B.

# Keep / simplify / remove / defer

| Area | Decision |
|---|---|
| Canonical-session DH2D broker, ancillary FD transfer, ordered paired metadata | **Keep** |
| Snapshot-first NVP handoff; preserved upstream IMAGE/BAND/copy logic | **Keep** |
| Wav2Lip existing CPU-result/patch upload | **Keep** |
| Native B clock and single paired eligibility gate | **Keep unchanged** |
| PCM custody, protected-turn handoff history, RT barriers, PipeWire worker and real joins | **Keep**; fix EOS/stop servicing |
| Fresh import, healthy submission/send/main-release/all-reference ACK gate | **Keep** |
| Independent WebGL retained texture | **Keep**; do not claim end-to-end zero-copy |
| Conversation/QR separation and existing transition tracker | **Keep** |
| Electron receiver’s arbitrary nested failure/retry guarantees | **Simplify** against actual platform behavior |
| TS and native state resolvers | **One production authority:** native resolver. Keep TS types/goldens/reference tests as useful; do not install a second runtime resolver |
| Native FRAME→JS wire Buffer→native playback decoding | **Do not make it a permanent public contract.** Consolidate naturally if integration warrants it; eliminating copies is not a new acceptance blocker |
| SDK RTC/stripe path | **Remove during caller cutover**, not as an isolated deletion slice |
| Provider-source gate, remote-clear certificate, per-turn device-consumed completion | **Omit**; already withdrawn/out of scope |
| Snapshot elimination, WebGPU/zero-copy redesign, new buffering/drop policies | **Defer** |

# Replacement architecture and call flow

```text
Existing app session / controls / QR
    |
    +-- portable conversation owner
    |      WS, adapter, input control, tools, existing QR workflow
    |      existing turn tracker and playback.ended receipts
    |
    +-- internal AvatarMediaHost
           |
           +-- SDK main attachment owner
           |      trusted socket + native connection/resolver/B clock
           |      native PipeWire OUTPUT owner
           |      allocation custody + TextureOutput
           |
           +-- SDK preload receiver + independent WebGL cover
                  |
                  +-- SDK Avatar in the existing media slot
```

Required sequence:

1. Existing WS announces canonical DH2D session.
2. SDK attaches to that session and receives LAYOUT+FD.
3. Actual GPU path and audio format/buffers accept the layout.
4. SDK sends READY; DH2D selects the output and returns ATTACHED.
5. `attach()` resolves; conversation sends existing `session.start`.
6. Native FRAME receipt determines B eligibility once for paired PCM/video.
7. Healthy qualified submission produces `frameApplied`; every valid observation reaches the existing tracker and `observeAvatarTurn`.
8. Only the complete reuse gate authorizes one ACK.
9. Scoped stop, media detach, conversation close, and whole-source EOS retain their distinct meanings.

Any GPU acceptance/preflight must remain distinct from FRAME 1: it must not anchor B, advance publication identity, fabricate a turn observation, or authorize source reuse.

# Finite remaining plan

## Slice 1 — Complete the SDK attachment runtime

**Owner:** SDK main/native/preload; DH2D changes only for a demonstrated integration defect.

Deliver:

- Public `installAvatarHost()` and `installAvatarBridge()`.
- Trusted socket connector and production loader interface.
- One combined attachment owner and explicit allocation custody.
- Actual combined readiness and selected-ATTACHED resolution.
- Authenticated main-frame IPC and native receipt stamping.
- Existing paired gate → audio/texture → applied/reuse flow.
- Scoped stop/EOS fix and coordinated failure/destruction/environment cleanup.
- Only justified receiver simplification.

**Supported-API acceptance:**

Exercise the installed boundary—not private fields—with delayed acceptance, stale/wrong sender or generation, exact paired bytes/order, stop during drain, protected B, failed submission, peer loss, detach during preparation, and joined close. Device-free fixtures may support this code gate; they do not qualify real GPU/audio behavior.

**Stop condition:** If the owner cannot satisfy readiness or lifetime within the approved interfaces, report the concrete gap. Do not invent client fields, a new clear certificate, or timing policy.

## Slice 2 — Cut over the public SDK and real app together

**Owner:** SDK portable/public/React integration plus minimal app bindings.

Deliver:

- Public conversation-session API or thin compatible facade preserving current callers.
- SDK `<Avatar>` ownership, loading/ready/failed, resize and same-avatar retained cover.
- Existing app main/preload registration.
- Existing video/cover slot replacement.
- Correct `wsOpen`, switch-waiter, QR-container, and stale-session mappings.
- Removal of obsolete SDK RTC/stripe paths and app video-element override.
- Empty-stop normalization fix.

**Supported-API acceptance:**

Use the real app-facing API for cold/hidden start, first-frame readiness, remount without conversation/QR disposal, media failure during QR verification, avatar replacement, stale callbacks, repeated observations/pending sleep, accepted-but-unobserved stop, and no audio replay.

Preserve pet commands/status, `is_talking_override`, input admission, settings/auth/history/subtitles, and non-avatar recording/preview audio.

**Stop condition:** If parity requires changing client semantics, capture ownership, existing timeouts, or unrelated UI behavior, stop and seek an explicit scope decision.

## Slice 3 — Close the production artifact path

**Owner:** DH2D packaging, SDK package, app dependency/bundling configuration.

Deliver:

- Packaged RGBA library at the real DH2D loader path.
- Production SDK addon and separate portable/main/preload/React entries.
- Exact Electron/native dependency selection.
- Correct packaged runtime inclusion and ASAR/externalization.
- Matching source/artifact manifests and rollback provenance.

**Acceptance:**

The isolated packed SDK and packaged app must load through the supported entry points without source-tree dependencies or fixture binaries. Browser-core imports must remain free of Electron/native/mandatory React dependencies.

**Stop condition:** Packaging failure blocks promotion. Do not substitute manual overlays or silently change runtime configuration.

# Qualification gates after source completion

These remain separately authorized work; this review performs or authorizes none of them.

| Gate | Required evidence |
|---|---|
| Packaged runtime | Exact Linux ARM64 artifacts load in the actual main/preload configuration; native libraries and asset paths resolve |
| Graphics | Dynamic NVP/Wav2Lip content, placement/background/color/orientation/alpha, fresh imports, safe reuse, retained resize/cover, and loss handling |
| Audio | Actual PipeWire paired streaming, preserved route/volume, EOS/drain, scoped cancellation, close, and existing microphone/wake/AEC compatibility |
| Unchanged client | Existing canonical-session bootstrap, successor-token behavior, normal A→B, repeated pending-sleep observations, exceptional stop, reconnect and inherited edge cases |
| Product preservation | QR refresh/verification/dismissal; tools; input; auth/settings/profile; history/subtitles; hidden/pet/full transitions; non-avatar audio |
| B/cadence | Immutable O0, receipt-only strictly positive corrections, paired gating, source/ACK/GPU timing and supply gaps—without reserve, C recovery, drops or new limits |
| Deployment | Complete matching reviewed artifacts, preserved identity/userData, rollback, and explicit renderer restart coordination |

Submission evidence is not physical presentation. PCM handoff/drain evidence is not a universal acoustic or remote-clear certificate. Any performance claim must name its measured endpoints.

# Work to stop or omit

- Stop standalone “one more cleanup/reentry wrapper” slices.
- Stop treating historical SPEC/QUALITY passes or aggregate test counts as product integration evidence.
- Do not add a second scheduler/state authority or application-owned audio/native adapter.
- Do not recreate QR, shell, settings, or pet UI.
- Do not move/reconfigure existing capture ownership or absorb recording/preview audio into avatar playback.
- Do not reopen provider-source, per-turn drain, remote-clear barrier, no-copy, or hidden RTC-fallback work.
- Do not alter timeout/runtime limits, queue capacities, retries, polling, or buffering policy without prior approval.
- Do not build/install/restart merely to demonstrate a partial slice.

# Bounded review strategy

For each of the **three slices**:

1. Write one short requirement-mapped contract/ownership note.
2. Parent implements inline.
3. SPEC reviews the complete slice call flow and supported-API acceptance.
4. Consolidate genuine findings into one bounded fix batch; re-review the changed requirements.
5. After SPEC passes, obtain independent QUALITY review focused on integration, real resource behavior, and simplification.

A new blocker must identify a preserved requirement, reachable production trace, affected resource, and observable failure. “A fake method can arbitrarily throw or recursively call another method” is insufficient by itself.

If material failures remain after the bounded correction/recheck, stop and report them rather than starting an indefinite micro-slice approval loop. Process bounds must never become automatic approval.

# Coverage and frozen-source confirmation

Direct inspection covered the authoritative plan and scope corrections; relevant DH2D producer/broker/readiness/ownership changes; SDK conversation, native transport/clock/audio/Node layers; texture/receiver/cover implementation; representative tests; and actual unchanged app callers, preload/window behavior, identity, and packaging.

This was **not** a line-by-line audit of every historical fix document, fixture, test body, or unrelated app feature. Historical POC evidence was not independently verified. Client/provider sources outside the three repositories, private logs, installed artifacts, devices, and runtime behavior were not inspected.

Final read-only recheck:

| Repository | Frozen HEAD | Manifest hashes | State |
|---|---|---:|---|
| DH2D | `01a0a50b223cfd314b4543a714d199cd456d831a` | 71/71 match | Clean |
| SDK | `296020a2b3c9f70ce32d4b7124a66cbd2b7d3bd0` | 87/87 match | Clean |
| App | `c52c3263a3fe3e59d065040644bff8eccbf5d222` | None supplied | Clean; unchanged baseline |

**Bottom line:** retain the substantial foundation, fix the scoped-stop defect, and finish the supported end-to-end path. The remaining uncertainty is concrete integration and qualification—not a need for another round of speculative lifecycle guarantees.