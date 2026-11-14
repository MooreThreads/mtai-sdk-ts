# Public SDK/app Slice 2 — source approved, packaging unqualified

Slice1 committed b532411. Two-worktree source cutover in progress; no install/restart/package promotion.

SDK: compatible createDH2DSession facade uses portable conversation; authenticated main handle and preload contextBridge own narrow attach/stop/events. Optional mtai/react Avatar owns presentation only, no conversation close or audio replay on remount. Preload creates receiver before attach regardless visible mount, moves same canvas on remount, hides cross-avatar content and fences old generation; resize preserves source aspect. QR remains in independently owned #mt_dh2d_container, main view is positioned separately. Empty explicit stop restores existing nonempty-string fallback. Existing 60000/default connect timeout, 2000 retry, scheduled reconnect, session 3000 close race and app 30000 avatar-switch failure behavior retained, no media timer introduced. RTC-specific transport/stats/stripe/readback paths and exports removed; DH2D independent RTC/RTMP and microphone code untouched. SDK optional React dev/types dependencies pinned from current app lock (npm package-lock-only network attempt hit operator60s; no dependency refresh, targeted closure copied from existing app lock). SDK/app ignored dependency overlays under /tmp, original dependency directories unchanged.

App: one-time main/preload registration; existing DH2D control/history/input component mounts SDK Avatar; wsOpen stays conversation status, outer opacity removed so QR independent; switch waiter joins connected plus media-ready using same30000/error placement; old video/cover override and peer-limit reload removed as obsolete RTC path. Pet/auxiliary windows don't create conversation/native audio. Settings/auth/mic/nonavatar audio untouched.

Validation: SDK tsc noEmit+build PASS; 19namedSDKsuites348PASS. Entire collection-only baseline591/32files -> current383/26files (net-208), collected intentionally without execution using namepattern '^$' only for accounting, no persisted skips. Before/after JSON /tmp/mtai-cutover-{before-all,after}-collection.json. Table below. App default test setup refused because main not built; unit-only config /tmp/avatar-cutover-unit-jest.json omits check-build-exists only, not product runtime check. Four app suites17PASS, one artifact-integrity test explicitly excluded from this SOURCE-only run because vendor remains Slice3 baseline; unchanged test retained. Three app suites16PASS without exclusion separately. App full tsc FAILS: clean HEAD isolated comparison using matching old SDK shows same19 normalized source diagnostic signatures, none added; inherited pet duplicates, ElectronStore/Buffer/SDK dependency declarations etc. This is not full app build PASS. Logs /tmp/mtai-cutover-app-{before,after}-tsc.private.log. No GPU/audio/hardware acceptance.

## Test migration accounting

| File/group | Before | After | Reason / retained semantic witnesses |
|---|---:|---:|---|
| pc,connections |12|0|Retired RTC offer/track/stats APIs; native acceptance/cancellation/joins covered installed runtime and new coordinator.|
| receiverStats + voiceConnections.receiverStats |4|0|RTC stats-only outputs no longer exist.|
| playerPresentation |6|0|Video/stripe crop removed; native cover/frame failure and React/remount witnesses retained new path.|
| avatarMedia + async |54|0|Removed stripe sampler/readback/animation APIs, diagnostics/canvas fallback internals. A->B/repeated/stale/accepted scoped stop laws already in conversation tests (unchanged32), native single-gate/order/reference suites.|
| turnStripe + V2 |33|19 moved|19 public tracker laws moved verbatim to voice/turnTransition.test.ts;14 stripe encoder/CRC/readback-only cases retired.|
| voiceConnections |128|4 +20 moved|20 command-translation public laws moved verbatim to conversationProtocol tests. New4 coordinator tests preserve readiness/version, preabort, timeout joins/backoff. Existing32 conversation + adapter/input/microphone/channelBinding suites retain tool correlation, input/header/PCM ordering, snapshots/pending sleep, accepted-unseen/captured stop, failure isolation and cleanup; no new RTC fallback. Detailed prior title inventory retained /tmp/mtai-cutover-test-law-inventory.txt.|
| sessions |18|5|Removed hook-wiring/legacy login assertions; public WS/bridge tests now verify facade handshake/readiness, QR remount, media failure/retry, empty stop, idle reconnect/stale fence.|
| hooks |8|4|4 hook-wiring/legacy-mode cases replaced by facade API tests; shared capacity and config precedence preserved.|
| main/preload |13|15|+2 authenticated installed control/canvas bridge tests.|
| React |0|1|Mounted optional component remount/status without close/detach/audio.|

App tests port actual observable history/subtitle/command contracts unchanged to session API fake (no retired hooks); SDK defaults test now real public WS/bridge; obsolete stripe crop test replaced QR/conversation remount law. Two mounted switch tests added. No weakening to hide failures: jsdom randomUUID fixture gap, default session media duplicate replay, wrong URL identity assertion, wrong EditModal fixture binding corrected; earlier logs retained /tmp/mtai-cutover-*.private.log.

## Final review closeout

User authorized correcting the remaining reconnect issue and reviewing again. Nonterminal reconnect now enters reconnecting/loading and buffers commands before awaited native retirement; terminal protocol failure still rejects sends. Two public-facade regressions hold retirement pending under ordinary socket loss and scheduled reconnect, then prove exactly-once delivery on replacement. No timer/limit changes.

Final source: tsc noEmit/build PASS, 19 named SDK suites354PASS, affected app unit4suites18PASS with unchanged artifact-integrity test explicitly excluded because exact vendoring is Slice3. Final collection-only census389cases/26files vs baseline591/32, net-202 (not an execution result); adds6cases since earlier383 census: main+1, preload+1, session+4; expanded React assertions unchanged casecount. Collection filters are administrative census only, not persisted skips. App full tsc inherited failure boundary remains as documented.

Astra completed SPEC PASS -> independent QUALITY PASS, both openai-codex/gpt-6-astra thinkingmedium peruserselection. Verified completedstop/model/invocation/heads/frozenSDK45+app9entries (includingdeletions) before checkpoint-only update. Artifacts /tmp/mtai-public-cutover-review.u81gtzr2/{spec-reconnect,quality}-result.private.md. Prior NOTPASS and remaining-blocker notes retained historical. Slice2 remains uncommitted pending closeout; source approval is not artifact/GPU/audio/product acceptance. No install/restart/push/probes.

Artifact path: package source exports/typesVersions defined but actual exact packed addon/vendoring/native dependencies/ASAR reserved Slice3. App require.resolve names expected production native artifact; not loadable from source-only tree and not represented as delivery.
