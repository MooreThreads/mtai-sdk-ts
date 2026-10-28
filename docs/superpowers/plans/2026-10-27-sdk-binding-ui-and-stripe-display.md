# SDK-owned WeChat binding UI and turn-ID stripe display

## Scope and decisions

Implement both features in `mtai-sdk-ts` (`/tmp/sdk-all`, branch `feat/voice-pipeline-mvp`). No implementation or deployment is authorized by this document alone.

- Plain DOM/CSS only: no React, Ant Design, or UI framework.
- SDK owns the WeChat binding UI and its lifecycle. Consumers must not implement binding UI through SDK callbacks.
- No Electron feature changes. The consuming app should remain as close to its source branch as possible.
- `status` and `unbind` remain backend/Pi tool actions; do not restore their SDK implementations or HTTP endpoints.
- Preserve existing timeouts, limits, transport behavior, stripe decoding, and session ownership.

## 1. SDK-owned binding UI and QR transitions

Create a small internal DOM/CSS controller attached to the existing DH2D player container. Wire it directly to the SDK binding workflow.

The controller owns QR rendering, status text, verification input/submission, and completion/failure/dismissal presentation. Remove consumer-facing WeChat UI callbacks (`onSnapshot`, `onError`, `onWorkflow`) from the supported public configuration; internal workflow notifications may remain implementation details.

- Fade QR opacity in on appearance and out before visual removal.
- Keep the QR sharp, square, and surrounded by its required quiet zone.
- Keep the UI outside the transformed video layer so video cropping does not scale or clip it.
- Preserve binding semantics: frontend cancel dismisses only; it does not cancel backend login or delete credentials.
- Fence stale verification and transition completions when a workflow or operation is replaced.
- Dispose SDK-owned DOM and listeners on session close; transitions must not delay transport teardown.
- Preserve QR replacement behavior and avoid layout jumps.

Before implementation, select a framework-free QR encoding approach. The SDK currently has no QR renderer; do not assume the QR payload is an image URL or use a remote QR-generation service. A no-new-runtime-dependency requirement cannot be claimed until this choice is settled.

## 2. Global `show_turn_id` configuration

Add `show_turn_id?: boolean` to the SDK's global `Config`, configured through the existing `setConfig(...)` function:

```ts
setConfig({
  endpoint: '...',
  show_turn_id: false,
});
```

**This is not a `DH2DSessionConfig` option. Do not add it to `createDH2DSession(...)`.** Omission has the same behavior as `false`.

- `true`: preserve the existing full-frame video presentation, including the stripe.
- `false` (default): visually hide the stripe by uniformly enlarging and shifting the video upward within a clipped parent.
- Preserve the original aspect ratio: no independent width/height stretching.
- Keep the video centered horizontally; crop a small amount from the left, top, and right.
- Derive the crop from actual video geometry and stripe height; handle metadata arrival and player resizing without arbitrary zoom values.
- Apply presentation styling only. Keep encoded stripe pixels and the SDK's original-frame sampling/decoding intact.
- Do not change DH2D server generation, stream dimensions, playback signaling, or media transport.
- Follow existing global configuration lifecycle semantics; do not invent a separate per-session override or configuration subscription system.

## Implementation sequence

1. Inspect global config, player construction/cleanup, workflow ownership, and public exports. Identify consumer callback compatibility and QR encoder requirements before coding.
2. Add failing tests for global `show_turn_id` default and explicit true behavior, then implement minimal player-only presentation changes.
3. Add failing DOM tests for SDK-owned binding UI, verification, QR transitions, replacement, and disposal; implement the internal controller and connect it to the existing workflow.
4. Remove public binding UI callback configuration and update SDK tests/docs/examples that relied on it. Do not modify the Electron repository as part of this SDK task.
5. Run SDK TypeScript build and relevant config/player/binding/connection tests; review correctness, lifecycle handling, and minimality.

## Verification

- Global `setConfig` accepts the flag; omission hides the stripe; true restores full-frame presentation.
- No per-session `show_turn_id` option is introduced.
- Cropping remains proportional and horizontally centered across video/container sizes.
- Stripe decoding still receives original pixels and produces unchanged playback observations.
- Binding UI works without consumer callbacks or a framework.
- Appearance/removal transitions work; cancelled/replaced operations cannot revive obsolete UI.
- Verification input stays local to the existing verification transport and never appears in model tool results.
- Session cleanup removes all SDK-owned UI/listeners without changing backend binding state.
- No SDK status/unbind transport is introduced.

## Integration caveat

The existing Electron checkout already renders `ChannelBindingOverlay` and supplies binding callbacks. Removing the SDK callback API is an intentional compatibility change for that customized consumer. SDK-only completion must not be reported as an already-integrated Electron release. Any later consumer cleanup should remove the duplicated feature code rather than add new application-owned behavior; it requires a separate scoped integration step.
