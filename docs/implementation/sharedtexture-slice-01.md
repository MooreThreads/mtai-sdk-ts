# Shared-texture migration slice 01: portable conversation attempt

## Scope

Implements the first SDK separation slice of the reviewed DH2D/SDK/app plan. User authorized inline implementation, Astra review, commits and deployment; the user subsequently selected local build and local installation on this workstation. Renderer coordination and full product qualification remain outstanding. No installation, component restart, push or deployment follows from this slice.

Baseline: `176e34b5128a62b1bfd2fed8b31a67c2a5afd804`, worktree `/home/mt/Work/mtai-sdk-ts-conversation-native`, branch `feat/conversation-native-media`. Client/server/standalone frontend/Pi backend untouched.

## Implemented

- `core/src/voice/conversation.ts`: one state-owning voice-WebSocket attempt with an injected portable AvatarMediaHost. Canonical existing DH2D session announcement→actual host acceptance→unchanged session.start→versioned session.state. No RTC, stripe/pixel, Electron, React or native addon implementation in this module.
- `avatarMediaHost.ts`: internal SDK capability and generation-qualified target/applied-frame/failure events. Applied frames are healthy playback/submission observations with resolved state, not mere wire STATE receipt or physical display proof. Every applied frame repeats the current state so pending sleep can observe its accepted turn after text.accepted.
- `conversationProtocol.ts`: moves existing URL/translation/tool sanitization functions out of the RTC connection module. Legacy re-exports preserve existing import behavior and the same VoiceProtocolError constructor.
- `turnTransition.ts`: moves the existing A→B/explicit-stop playback law out of stripe decoding. Legacy stripe re-export remains during migration; both paths use the same stateful tracker.
- Conversation owns adapter, command-driven input control, tool-result correlation and existing channel-binding workflow/UI. Media failure/detach/replacement does not close conversation or dispose QR. Explicit conversation close fences callbacks immediately and joins media, input and owned retirement, with failures surfaced.
- Normal applied A→B retires A once, sends existing playback.ended and feeds observeAvatarTurn for pending sleep. Missing/invalid/activity-false/logical turn.end alone do not complete media. Explicit stop retires current/accepted output, including unseen accepted turns, without a new remote-clear or native-flush certificate prerequisite. Native cleanup remains owned and is joined at close.
- Initial failed media attachment reports failed media but does not fabricate connection readiness or close the conversation socket. The internal caller can explicitly retry attachment; no new automatic retry/timer policy. Existing session coordinator connection timeouts/retry placement will be retained when integrated.

## Intentional staged boundary

This slice is **not** a deployable replacement. The new connection is an internal callable seam tested with fake socket/media capabilities. Existing createDH2DSession/voice-client RTC entry remains unchanged and explicitly legacy until the session/native/React/app migration; it is not a fallback used by the new conversation attempt. Do not claim SDK-wide RTC removal, new public createConversationSession/Avatar entry points, real socket/SCM_RIGHTS, PipeWire, direct-RGBA producer, packaged app equivalence or physical playback acceptance yet.

No timeout, cap, queue ceiling, buffer-duration policy, Origin control, source cadence, pool size or device setting changed. Malformed/gapped applied-publication sequence fails media rather than fabricating an observation; this is the already-required dense attachment-local protocol contract, not an observation buffer/drop policy. Media failure does not close the voice WebSocket.

## Verification before review

- `tsc --noEmit`: PASS.
- Isolated full TypeScript build under `/tmp/mtai-conversation-slice01-build.pBhkXy`: PASS.
- Compiled portable conversation imports in plain Node without DOM, with Electron/React/native-addon imports unavailable: PASS. This does not certify the not-yet-migrated root barrel/native optional entries.
- Focused Jest batch:10 suites,376 tests PASS: conversation, voiceConnections, voiceConnections.receiverStats, turnStripe, avatarMedia, avatarMedia.async, adapter, inputControl, channelBinding, channelBindingUI. Existing ts-jest module-config and jsdom canvas warnings remain; they are not real GPU witnesses. No tests deleted/skipped, timeout or assertion weakened. New conversation tests cover bootstrap, first-frame/attach ordering, normal/exceptional completion, pending sleep, QR/tool/media isolation, recovery stop debt, input admission, cleanup joins, stale callbacks, explicit retry, native failure and no RTC use.
- Reuses existing pinned `core/node_modules` via a local ignored symlink; no dependency/lockfile refresh. No hardware/audio/network media tests performed.

## Remaining work / decisions

1. Public session factory/compatibility binding and optional native/main/preload/React entries; migrate and finally remove SDK RTC/stripe implementations/exports.
2. Versioned DH2D per-session SOCK_SEQPACKET broker with real FD transport, actual selected-output readiness and ordered paired-output state; no client changes.
3. SDK native PipeWire, B clock, source-safe texture lifecycle and renderer-owned retained cover.
4. Direct-RGBA NVP and permitted Wav2Lip upload. **User-clarified boundary:** preserve existing face generation/blending/placement/copying logic, change only the handoff immediately before conversion to NV12, and try an owned GPU snapshot there first. Removing the snapshot copy is a later optimization; no B8 lease, fixed pool count or new queue ceiling. Preserve background ownership and inference overlap. Source work and qualification remain outstanding.
5. Minor existing-app binding, exact SDK artifact vendoring, Electron pin/package/feature parity and rollout/rollback qualification.
6. Build and install locally on this workstation, as selected by the user; complete product qualification and installed-renderer coordination before deployment.

## Specification review and bounded fix plan (recorded before code edits)

First max-thinking Astra SPEC: NOT PASS, with exactly three necessary corrections. No replacement of the selected architecture or stronger completion guarantee requested.

1. **Serialize input controls at the WebSocket boundary.** Restore legacy object→JSON text and leave PCM binary. Make the socket fake accept only actual WebSocket text/binary values, and retain preparation/capture/header→PCM witnesses. Required by plan §7.6 command-driven input and existing client wire compatibility; fixes a real missing serialization, not new protocol behavior.
2. **Make attachment cancellation/retirement singular.** Add an owned lifecycle revision to invalidate queued requests synchronously at detach, immediately cancel any installed pending native attachment, then install a retirement barrier joining that cancelled attach and native stop. Later attach must wait on that barrier and cannot bypass its failure. Preserve full voice/QR ownership and receipt timing. Add deferred-retirement and detach-before-queued-start witnesses. Required by §7.2 single media owner and §7.3/§7.7 cleanup/callback fencing; no extra timer, queue ceiling or buffering policy.
3. **Restore missing-ID explicit-stop fallback.** An absent turn ID retires only the currently observed turn, matching the existing tested path; named stops retain current/accepted/session validation and once-only receipt. Add the existing fallback regression via output-visible receipts/native stop. Required by baseline exceptional playback.stop compatibility; no speculative new stop/clear protocol.

All three corrections implemented inline. Post-fix tsc/noEmit and isolated build/import (`/tmp/mtai-conversation-slice01-fixed-build.ozhKeK`) PASS; same named10-suite batch now381 tests PASS. Conversation cases19→24 (+5); existing input test renamed and strengthened with real JSON-text/header→PCM assertions, not deleted. No persisted skip/test-timeout/limit change.

Parent directly reproduced the concurrency and stop regressions against the unchanged pre-fix compiled module: four specifically selected cases failed (early replacement, uncancelled queued attach, failed-retirement bypass and absent-ID stop); two failed at the existing default Jest5000ms deadline. All four pass on corrected source. The20 other cases were unselected only for this historical comparison CLI run, not skipped in persisted tests; full current24 conversation cases pass in the381-test batch. No live media/production logs were delegated or replayed.

Second max-thinking SPEC: serialization and missing-ID fixes accepted; finding2 still NOT PASS for two synchronous mediaStatus reentrancy cases. Bounded continuation plan, recorded before editing:

- Publish detach's retirement barrier before **any** subscriber notification/native cancellation dispatch that may reenter; dispatch native cancellation immediately after publication, not behind pending acceptance. This is the same single-owner §7.2/cleanup §7.7 requirement, not another layer or stronger lifecycle certificate.
- Follow Astra's concrete bounded option: emit loading and recheck cancellation **before installing** the next target, then install immediately before host.attach. A superseded request must never leave a never-attached target available for accepted-owner reuse. This restores the already-required native-acceptance-before-session.start bootstrap.
- Add the two requested API witnesses: replacement requested inside loading during deferred detach; duplicate attach requested inside retry loading, with actual host acceptance still gating session.start. No unrelated cleanup or policy change.

Both reentrancy replacements implemented inline. Current tsc/noEmit PASS; same10-suite batch383 tests PASS, conversation24→26 cases (+2). Both new cases fail against the unchanged preceding compiled build at direct causal assertions (native admission before retirement; session.start preceding any real host attachment), then pass on current source. Comparison-only CLI selection left24 unselected cases; persisted tests have no skip/timeout change. No source/AST/private-state assertions added.

Third max-thinking SPEC re-review: **PASS**, all raised findings resolved by direct source inspection. Post-review bounded fix plan: no production/test changes, because no remaining finding; proceed to separate QUALITY without speculative additions. Source frozen in `/tmp/mtai-sharedtexture-slice01-review.NWCLAN/reentrant-source.sha256.json`.

First separate max-thinking QUALITY: NOT PASS for two additional supported callback traces. Bounded requirement-mapped plan, recorded before edits:

1. **Retire the captured stop ID, not a later current turn.** Follow Astra's concrete replacement: after validating current/accepted ownership, use endAcceptedTurn(turnId) after callback-capable native stop dispatch. A synchronous applied B during stop(A) must not let the resumed branch end B. Keep immediate once-only receipt and joined cleanup. Add a native-callback B→later C API witness. This is existing §6/§7 targeted stop compatibility, not a stronger stop protocol.
2. **Fence each media-status delivery locally.** Keep a local snapshot listener list and notification revision; stop superseded/closed deliveries after reentrant detach/close. Preserve current-status replay while live, status deduplication and on/off behavior; do not change the shared event system or other event types. Add two-subscriber detach and close traces, asserting no stale ready after loading/closure. This is §4/§5 readiness/callback fencing, not speculative event-system redesign.

3. **Parent self-review: commit actual output observation before readiness callbacks.** Concrete same-scope trace: A is current; after media replacement an actual applied B triggers ready; its listener detaches the view. Publishing ready before tracker observation lets cancellation retroactively discard actual B and lose A's normal receipt. Apply the already-qualified frame's tracker/pending-sleep effects before publishing ready, retaining stale/disposed checks around external effects. Add the applied-B/ready-detach output witness. This follows the explicit §6 actual-output A→B contract and §4 readiness milestone; it is not a stronger remote/physical completion guarantee.

All three corrections implemented inline; shared events.ts remains unchanged. New cases26→31 (+5, including the on/off/replay preservation witness); same focused10-suite batch388 tests PASS and tsc/noEmit PASS. Four targeted cases fail against the unchanged preceding compiled module at their actual public consequences (premature B receipt, stale ready after loading, ready after close, lost A→B receipt), then pass on current source. Comparison-only CLI left27 cases unselected; persisted source has no skip/timeout change. Initial local off-overload/test-lib compilation errors were repaired without changing compiler config/dependencies; those failed logs remain private, not counted as behavioral regression proof.

Max-thinking SPEC re-review of the bounded quality fixes: **PASS**, explicitly confirming the parent's actual-output-before-readiness correction as existing A→B/pending-sleep semantics, not a stronger guarantee. Post-review bounded fix plan: no source/test changes because no finding; request separate QUALITY re-review on the same frozen source.

Separate max-thinking QUALITY re-review: **PASS**, no remaining necessary replacement in this slice. Post-review bounded fix plan: no source/test edits; finalize evidence and commit only this coherent slice. Both review sessions confirm provider/model openai-codex/gpt-6-astra and thinking=max. Frozen seven source/test hashes match the final reviewed set.

Final verification: tsc/noEmit PASS; full isolated build `/tmp/mtai-conversation-slice01-quality-fixed-build.axgLeM` and plain-Node import without DOM/Electron/React/native PASS;10 focused suites388 tests PASS, all31 conversation cases. Existing warnings remain disclosed; no hardware/audio/GPU or packaged-product acceptance follows.

**Slice gate: SPEC PASS → QUALITY PASS.** This is not whole-migration/deployment approval. Native/main/preload/React/DH2D/app work, product qualification and renderer restart coordination remain outstanding; build/installation are selected locally and snapshot-first pre-NV12 handoff is approved.
