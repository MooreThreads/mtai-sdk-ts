# Avatar receive-to-presentation timing diagnostics

## Approval and scope

The user approved the proposed SDK-only diagnostic change and requested a plan plus implementation. The accepted design is to preserve the browser's existing video-frame callback timing metadata and log it on validated turn-token transitions. No buffering, scheduling, decoding, playback, wire-protocol or lifecycle policy changes are authorized.

Work in the existing clean SDK worktree `/tmp/sdk-all`, branch `feat/voice-pipeline-mvp`, baseline `93685677cc6da3a93611cdf5529822f8b7577676`. This is newer than `/home/jj/Work/mtai-sdk-ts-channel-binding` and already contains the `avatar_turn_observed` diagnostic used in the installed Avatar. Preserve its direction-qualified wire names, reconnect behavior, observer fences and diagnostic failure isolation. Do not edit another SDK worktree or any running system.

## Question this diagnostic answers

DH2D's `dh2d_stripe_submitted` timestamp precedes encoding and RTP sending. Electron's `avatar_turn_observed` timestamp follows video presentation and successful stripe decoding. The measured interval is approximately a quarter-second, but its distribution across stages is unknown.

The first useful split is browser receive-to-presentation versus presentation-to-callback time, for callbacks that observe validated turn transitions. This is not a measurement of speaker output. It does not prove buffering is the cause or that the latency can be eliminated.

## Architecture

Only `core/src/dh2d/avatarMedia.ts` needs production changes:

1. Extend the frame requester callback with optional callback timestamp and optional partial `VideoFrameCallbackMetadata`. Existing no-argument requesters and consumers continue to work.
2. Forward the native browser callback arguments without changing request/cancel behavior or adding scheduling.
3. On the existing `changed` token path, snapshot an allowlist of numeric frame-timing fields before any playback listeners run.
4. Append one `frame_timing=<JSON>` suffix to the existing `avatar_turn_observed` line. Preserve its current prefix, `turn`, `previous`, `ended`, `now` and `epoch_ms` values, and its post-listener logging order.
5. Snapshot/format/logging failures are diagnostic only: they cannot suppress playback acknowledgements, observations, or subsequent frame requests. Do not refactor unrelated callback exception handling.

Use plain functions and types; no policy classes, new observer services, polling, retries, queues or timers. Do not introduce a runtime cap or change a timeout. No getStats collection is part of this change.

## Log contract

The JSON suffix contains only these fields, each a finite number or JSON null:

| Field | Meaning |
| --- | --- |
| `callback_now_ms` | Native rVFC `now`; do not substitute post-sampling `performance.now()` or wall time when unavailable. |
| `receive_time_ms` | Native `metadata.receiveTime`, when available. |
| `presentation_time_ms` | Native `metadata.presentationTime`. |
| `expected_display_time_ms` | Native `metadata.expectedDisplayTime`; predicted display, not actual sound output. |
| `processing_duration_ms` | Native `metadata.processingDuration` converted from seconds to milliseconds. |
| `presented_frames` | Native cumulative `metadata.presentedFrames`, useful for correlation. |
| `rtp_timestamp` | Native `metadata.rtpTimestamp`, when available. |
| `time_origin_ms` | Finite `performance.timeOrigin`, when available, for interpreting native DOM timestamps. |
| `receive_to_presentation_ms` | `presentation_time_ms - receive_time_ms`, only when both are finite. |
| `presentation_to_callback_ms` | `callback_now_ms - presentation_time_ms`, only when both are finite. |

Missing, nonnumeric or nonfinite inputs produce null, not zero. Valid zero values and signed deltas remain unchanged; no clamping. Arithmetic overflow also produces null. Never serialize the original metadata object or any text/content/pixel/auth data. Capture the allowlisted primitives before callbacks can mutate the supplied metadata.

Each normal token-change line has a suffix even when metadata is absent. A property getter or unexpected diagnostic exception may suppress only the suffix, not the original observation line or playback events. Invalid/ambiguous/CRC-failing stripes and repeated current tokens do not add log records. Start/stop reset behavior remains unchanged.

The native DOM timestamps share the document's high-resolution clock domain; epoch conversion is `time_origin_ms + <native timestamp>`. Existing `now` is the SDK observation clock after stripe sampling, not the native callback timestamp. Do not subtract unrelated process monotonic clocks. Decoder duration and receive-to-presentation time can overlap and must not be summed as independent stages.

## Verification

Use deterministic tests exercising the actual requester, observer and stripe decoder. Cover native argument forwarding and cancellation; exact fields/units/deltas; metadata snapshot before listeners; missing/partial/zero/nonfinite inputs; no stale metadata reuse; repeated/invalid tokens and restart; throwing diagnostic getters/sinks; unchanged playback event ordering.

Keep every Jest invocation at no more than three actual test cases. Do not change test timeouts. Run the entire focused avatarMedia suite in small batches, selected voiceConnections regressions, and `npm run build`. Independent specification review precedes quality review.

No new runtime dependencies or lockfile/package-version changes. Do not commit generated dist or tarballs. Source completion is not live latency acceptance: building/pinning the SDK into an Avatar package, deploying it and collecting warmed transitions are separate subsequent steps requiring coordination.
