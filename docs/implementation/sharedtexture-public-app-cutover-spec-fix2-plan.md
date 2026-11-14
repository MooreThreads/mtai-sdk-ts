# Slice 2 final bounded SPEC corrections

Fixed re-review reports two concrete gaps, not new architecture: (1) selection fence wrongly clears a new generation if off-DOM attachment precedes mount; (2) terminal coordinator leaves send buffering forever.

1. Keep attachment generation and selected presentation avatar distinct. Carry existing SDK-known videoId as internal avatarId in AvatarAttachment (not client/native wire). Preload tracks owning attachment's avatar; reveal only matching selected avatar, still forward valid current attachment observations while off-DOM. Mount never invalidates a healthy new attachment. Add both ordering witnesses with new frame/failure events.
2. Record coordinator termination and reject later send, without changing pending/reconnecting buffering or timers. Public terminal-protocol + rejected-send witness.

No new policies/timeouts/receipts/framework. One correction batch and whole Slice2 review; preserve earlier NOTPASS evidence. If material gaps persist report rather than repeat helper churn.
