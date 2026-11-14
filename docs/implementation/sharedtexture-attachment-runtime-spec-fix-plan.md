# Integrated Slice 1 SPEC correction plan

Apply one bounded batch for three reachable production failures from completed Astra review, not hypothetical fake reentry.
1. Default preload adapter maps actual Electron ipcRenderer/sharedTexture; test default require entry.
2. WebGLCover exposes callable checkReady used during prepare and sequence0 probe. Retain context failure before target exists; fail target rather than send prepared/accepted. No auto recovery or timing policy.
3. Bind main attachment to document: render-frame/document navigation lifecycle fences pending prep/acceptance, native output and old callbacks before current frame changes. Preload sends bridge-disposed lifecycle before removing listeners; main records unavailable and skips impossible receiver ack while TextureOutput actual allrefs still joins. Explicit bridge reinstall/reattach must freshly prepare; no timeout/retry/new receipt. Tests default adapter, preprepare contextloss, navigation while audio pending, bridge disposal before main. No GPU/device operations.
After fixes run affected integration + named native/portable batches; re-review integrated slice SPEC then independent QUALITY. Prior terminated review retained, not approval.
