# MT AI SDK

A TypeScript SDK for integrating with the MT AI service in browser applications.

## Installation

```bash
npm install mtai
```

## Usage

### Digital Human States

The digital human can be in one of several states:

1. **sleeping**: The default inactive state. The digital human is not listening or responding.

2. **listening**: The digital human is awake and actively listening for user input. This state is entered after a "wakeup" command or when the previous interaction has completed.

3. **talking**: The digital human is speaking in response to user input. During this state, it may not process new voice commands.

4. **sleep_talking**: A special state where the digital human responds to text input while remaining in sleep mode. In this state, it will provide text responses without audio output or animation. This is useful for quiet interactions or when audio responses are not desired.

You can monitor these states through the status_change event

## Voice-client avatar mode (default)

`createDH2DSession(container, { videoId, audioInput })` uses voice transport without
an application installer. SDK defaults are root `endpoint: 'http://localhost:32101'`,
`show_turn_id: false`, and `voiceClient: { interaction_endpoint: 'http://127.0.0.1:8780',
dh2d_endpoint: 'http://127.0.0.1:32106', sessionId: 'avatar-channel-session',
wechatPluginEndpoint: 'http://127.0.0.1:8781' }`.

`setConfig` still requires `endpoint`; omitted keys use fresh SDK defaults on each
call. Explicit `voiceClient` objects replace (rather than deep-merge) the default
object, and a per-session object overrides the global one. Explicit global
`voiceClient: undefined` selects the legacy transport. Call `setConfig` before
creating sessions only when overrides are needed. Original `session.config()`
calls are safe: the SDK ignores them in voice mode.

The SDK talks to the voice
client for voice protocol traffic and exchanges the WebRTC offer directly with
DH2D using the canonical session id the client reports; `voiceClient.interaction_endpoint`
is the browser-to-local voice interaction websocket, and `voiceClient.dh2d_endpoint`
is the HTTP endpoint of the DH2D server used for that offer exchange and for
avatar discovery, while the global `endpoint` stays the legacy service
endpoint for all other requests; a partial runtime config that omits
`dh2d_endpoint` falls back to the global `endpoint` for those avatar
operations. `wakeup`, `sleep`,
and text input are translated to the client protocol, TTS subtitles are
surfaced as incremental `audio_text` segments (main/narrator in wire order),
streamed LLM output as cumulative/replacement `bot_output`, and an assistant
`message_record` is derived from accumulated LLM output at `turn.end`.
ASR progress uses `asr_process`; a nonblank final also emits a confirmed user
`message_record`, once per identified turn. It never emits `asr_session`:
legacy consumers resubmit completed `asr_session` text, whereas voice ASR is
already submitted by the service. A matching current `text.accepted` confirms
the original typed text as a user record before its explicit talking status.
Sleep remains an explicit `status_change` from `conversation.state:ended`;
no model identifier or compensating status is invented. Commands retain their
opaque fields for the existing application's command handler.
Avatar playback boundaries are decoded from the DH2D video turn stripe and
reported to the client as `playback.ended`.

The logical `voiceClient.sessionId` is encoded into the client WebSocket path
and used unchanged in its session handshake; when omitted, it defaults to
`avatar-channel-session`. Exactly `.` and `..` are rejected before connecting
or retrying because browser URL normalization treats them as navigation.
Other session IDs are unaffected, including IDs containing dots.

### Avatar frame timing diagnostics

On each validated turn-token change, `avatar_turn_observed` retains its existing
`turn`, `previous`, `ended`, `now`, and `epoch_ms` fields and appends
` frame_timing=<JSON>`. Repeated tokens and invalid frames produce no additional
observation logs. Evidence is captured before playback listeners, while the log
is emitted after them. The existing `now` is the SDK observation timestamp
captured after stripe sampling and decoding, before listeners; it is distinct
from the native callback timestamp `callback_now_ms`. These diagnostics do not
change playback or latency policy; logging overhead is not a measured speedup.

The JSON contains exactly these fields (native times use the document's
`performance` clock):

| Field | Source / units |
| --- | --- |
| `callback_now_ms` | Native requestVideoFrameCallback `now`, milliseconds; no fallback |
| `receive_time_ms` | Native `receiveTime`, milliseconds |
| `presentation_time_ms` | Native `presentationTime`, milliseconds |
| `expected_display_time_ms` | Native `expectedDisplayTime`, milliseconds |
| `processing_duration_ms` | Native `processingDuration` (seconds) × 1000 |
| `presented_frames` | Native `presentedFrames`, frame count |
| `rtp_timestamp` | Native `rtpTimestamp`, RTP clock ticks |
| `time_origin_ms` | Document `performance.timeOrigin`, epoch milliseconds |
| `receive_to_presentation_ms` | `presentation_time_ms - receive_time_ms` |
| `presentation_to_callback_ms` | `callback_now_ms - presentation_time_ms` |

Every value is a finite number or JSON `null`. Missing, nonnumeric, nonfinite,
and overflowing results are `null`; zero and signed differences are preserved.
No raw metadata or other native fields are serialized. Legacy frame sources
without native arguments still produce the suffix with unavailable values set
to `null`. A throwing metadata getter or unexpected snapshot failure may omit
only the suffix; diagnostic failures must not interrupt playback.

The separate `observation_timing` suffix contains six fields, all in the
performance clock domain: `callback_entry_ms`, `sampling_end_ms`,
`decoding_end_ms`, `callback_to_sampling_ms`, `sampling_to_decoding_ms`, and
`callback_to_decoding_ms`. Sampling covers canvas draw/readback; decoding covers
stripe conversion/decoding. Missing or nonfinite clock readings are `null`.
The suffix is emitted only for changed validated tokens and is diagnostic only;
its request hook runs asynchronously after playback listeners.

Receiver diagnostics use one asynchronous `RTCPeerConnection.getStats()`
collector per connection generation. A baseline is requested when playback is
ready; changed-token observations request later snapshots asynchronously after
listeners. Interval records retain only allowlisted inbound audio/video reports keyed by
`id`, `kind`, and proven numeric `ssrc`, with current/previous RTCStats
timestamps, interval duration, and every allowlisted counter carrying an
explicit unit (`packets`, `count`, `frames`, `samples`, or `seconds`). Missing
or nonfinite counters remain present as `{ value: null, delta: null, unit }`. `packetsLost` may be
signed and its signed delta is preserved; other nonmonotonic counters produce a
null delta and establish a fresh baseline. Decoder and jitter-buffer means use
`totalDecodeTime`, `jitterBufferDelay`, the real cumulative
`jitterBufferTargetDelay`/`jitterBufferMinimumDelay`, and emitted/decoded deltas:
`1000 * delta / delta emitted-or-decoded count`, not same-frame measurements. Missing fields, nonfinite values, counter resets,
identity changes, unsupported stats, rejected calls, and overlapping calls are
reported as `null` or fixed unavailable reasons; busy calls are not queued.
Missing SSRC, missing/nonfinite timestamps, identity changes, equal/backward
report timestamps, and any shared non-`packetsLost` counter decrease suppress
that report's interval and use the current report as the next baseline. Raw
values remain present when the interval is null; a later valid pair may resume
interval reporting. Each record also carries the observation `turn`, RTP timestamp,
native callback timestamp, and performance origin when available.
There is no timer, polling, retry, timeout, or media backpressure. Stopping a
connection clears the baseline and fences late results.

Synthetic example (not a measurement):

```text
avatar_turn_observed turn=A1 previous=A0 ended=A0 now=1205.000 epoch_ms=1700000001205 frame_timing={"callback_now_ms":1204,"receive_time_ms":1000,"presentation_time_ms":1200,"expected_display_time_ms":1216,"processing_duration_ms":8,"presented_frames":42,"rtp_timestamp":90000,"time_origin_ms":1700000000000,"receive_to_presentation_ms":200,"presentation_to_callback_ms":4}
```

For cross-process correlation, convert native timestamps to epoch milliseconds
with `time_origin_ms + native_timestamp_ms`; do not subtract unrelated
monotonic clocks. Presentation means compositor submission, not actual speaker
playback. Receive-to-presentation spans browser receive buffering, A/V sync,
decode, and presentation; it is not a pure jitter-buffer measurement, and the
exact decomposition remains unknown. `processing_duration_ms` overlaps this
interval: do not sum decoder processing and receive-to-presentation as disjoint
stages. A token identifies a turn, not uniquely its first
encoded frame; RTP timestamps and frame counts aid correlation. Packaging,
deployment, and ten warmed-turn real measurements are outside this diagnostic
change; no latency improvement is claimed.

Input mapping in voice-client mode:

- `input.text` maps to the client protocol's `text.input`.
- `wakeup` with `text` sends `conversation.start` followed immediately by
  `text.input` for that text (`conversation.start` is idempotent while a
  conversation is already active, so a text-bearing wakeup is never held
  behind a stop-then-start sequence). Without text, `wakeup` keeps its
  existing behavior: start the conversation, or stop-then-start when a
  conversation is currently active.
- `sleep` with `text` sends only `text.input` and defers `conversation.stop`
  until the avatar has finished playing that message out: the client's
  `text.accepted` acknowledgement is correlated (by `request_id`) to the
  accepted turn, the SDK waits until avatar playback observes that turn's
  stripe and then any different validated turn, and only then sends exactly
  one `conversation.stop`. Without text, `sleep` sends `conversation.stop`
  immediately.
- `input.bot_text` is rejected with an explicit error: the client protocol
  has no bot-authored text input (its `text.input` is strictly user text and
  its verbatim-speech path is client-internal), so bot text is never silently
  dropped nor misrouted as user text. Use `input.text` or the legacy
direct-DH2D mode for verbatim bot speech.
- `asr_session` keeps its documented listening-control semantics through the
  conversation lifecycle that owns listening in the client protocol:
  `command: 'start'` opens listening (`conversation.start`) and
  `command: 'stop'` ends it (`conversation.stop`). `should_respond: false`
  has no client-protocol equivalent (ASR finals in an active conversation
  always generate a response) and is rejected with an explicit error.
- `config` and `ping` have no client-protocol equivalent and are ignored.

```typescript
const session = createDH2DSession(divElement, {
  videoId: 'YOUR_AVATAR_ID',
  voiceClient: { interaction_endpoint: 'ws://localhost:8300', dh2d_endpoint: 'http://192.168.10.23:32107' },
})
```

WeChat channel binding defaults to the local plugin endpoint above and can be
overridden via `voiceClient`; the SDK does not discover an endpoint. The endpoint exposes the
revision-driven binding workflow. The SDK renders its own plain DOM/CSS binding
UI inside the player, including locally encoded QR, status, verification and fades.
Do not provide application-owned binding callbacks or an additional overlay:

```typescript
const session = createDH2DSession(divElement, {
  videoId: 'YOUR_AVATAR_ID',
  voiceClient: {
    interaction_endpoint: 'ws://localhost:8300',
    wechatPluginEndpoint: 'http://127.0.0.1:8781',
  },
})
```

The built-in `bind_channel` tool accepts `{ channel: 'wechat', action:
'initiate' }` or `{ channel: 'wechat', action: 'cancel' }`.
Cancellation is a frontend-only dismissal: it fences local snapshot delivery
and emits a sanitized `cancelled` snapshot without making a backend request;
it does not cancel QR/login work. Verification codes are sent only through
the SDK's verification form and are never included in tool results or snapshots.
The SDK disposes the UI and workflow when the owning connection is retired.
QR payloads are encoded locally using the framework-free MIT `qrcode-generator`
dependency; no remote QR service or image URL interpretation is used.

The global `setConfig({ endpoint: '...', show_turn_id: true })` option exposes
the full video frame, including the encoded turn-ID stripe. Omission or `false`
visually crops the stripe using uniform scaling and upward cropping, preserving
the aspect ratio and horizontal center. This is **not** a session option. It is
read when the player is created, like other global defaults; it does not subscribe
to subsequent config updates. Original-frame stripe decoding is unchanged.

Playback boundaries: a validated stripe transition from turn A to a
different turn B reports `playback.ended` for A. The A→idle boundary (the
last turn of a playback sequence returning to idle) is never guessed from
frames — DH2D idle frames are undecodable and invalid stripes must not emit
— it is reported only on the explicit, protocol-safe `playback.stop`
lifecycle signal from the client. The signal's `session_id` and `turn_id`
are validated against the tracked avatar turn, so a stop targeted at a
retired or still-queued turn never retires the turn currently playing.

Pending-message sequencing: at most one pending sequence exists per voice
session. Any new `wakeup`, `input`, or `sleep` action — and any disconnect
or reset — cancels the previous pending sequence, so a deferred
`conversation.start` (stop-then-start wakeup) or the deferred
`conversation.stop` of a text-bearing sleep can never fire after it was
superseded. Acknowledgements for a retired request, and transitions for a
turn the avatar never validated, never complete a sequence; no timeout,
polling limit, or synthetic idle transition is ever fabricated, and
`turn.end` is never treated as an avatar playback boundary. If the browser
cannot report per-frame video callbacks, avatar transitions cannot be
observed and a text-bearing sleep simply never sends its deferred stop.

Microphone input: configure `audioInput: true` (default device) or pass a
`MediaStream`. Captured audio is delivered to the voice client as an input
`audio.chunk` control frame immediately followed by its binary payload:
mono PCM16 little-endian at 16 kHz, sent only while a capture turn is
accepted. Disconnecting a voice-client session fences the retired
connection: late websocket events, microphone batches, and stripe evidence
are dropped, and the video element's stream is cleared.

## Integrate Digital Human

```typescript
import { createDH2DSession } from 'mtai';

// Initialize the 2d digital human session
const session = createDH2DSession(divElement, { audioInput: true, videoId: 'YOUR_VIDEO_ID' })

// wakeup the 2d digital human
session.send({ type: 'wakeup' })

// wakeup with a greeting text (voice-client mode sends conversation.start then text.input)
session.send({ type: 'wakeup', text: '你好呀' })

// tell the 2d digital human to sleep
session.send({ type: 'sleep' })

// sleep with a farewell text (voice-client mode defers conversation.stop until the avatar played it out)
session.send({ type: 'sleep', text: '再见啦' })

// set system-prompt
session.config({ 
  message_prefix: [{
    role: 'system',
    content: 'You are a helpful assistant'
  }]
})

// send text input to the digital human
session.send({ type: 'input', text: 'Hello, how are you?' })

// make the digital human speak specific text
session.send({ type: 'input', bot_text: 'I will say exactly this text.' })

// control ASR (Automatic Speech Recognition) session
session.send({ type: 'asr_session', command: 'start' }) // start listening
session.send({ type: 'asr_session', command: 'stop' }) // stop listening

// configure advanced settings
session.config({
  asr_model: 'remote',
  tts_model: 'remote',
  mode: 'duplex',
  llm_service: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    token: 'your-api-token'
  },
  llm_config: {
    model: 'gpt-4',
    temperature: 0.7,
    max_tokens: 150
  }
})

// configure FAQ-based responses
session.config({
  llm_service: {
    provider: 'faq',
    config_file: 'path/to/your/faq.json'  // Path to your FAQ configuration file
  }
})

// print the subtitle
sesson.on('message', (msg) => {
  if (msg.type == 'audio_text') {
    console.log(msg.text)
  }
})

```

## Available Configuration Choices

The SDK provides methods to retrieve available configuration options for various components of the digital human system. This is useful for discovering supported voices, avatars, and other configurable elements.

```typescript
import { getAvailableVoices, getAvailableAvatars, getLlmModels } from 'mtai';

// Get available TTS voices
const voices = await getAvailableVoices();
console.log('Available voices:', voices);


// Get available avatars
const avatars = await getAvailableAvatars();
console.log('Available avatars:', avatars);

// Get available LLM models
const llmModels = await getLlmModels();
console.log('Available LLM models:', llmModels);

// You can then use these values in your configuration
session.config({
  voice: voices[0].code,  // Use the first available voice
  llm_service: llmModels[0].service,
  llm_config: llmModels[0].config
});
```

## Custom Endpoint Configuration

You can configure the SDK to use a custom backend endpoint, for example, when connecting to a self-hosted or on-premise server. This is done using the `setConfig` method before initializing your session.

> setConfig must be called before creating sessions.

**Example:**

```typescript
setConfig({
  endpoint: 'http://your_server_ip:32101'
});
```


## Component Management

Components in the SDK refer to items like custom avatars and local ASR (Automatic Speech Recognition) models. The SDK allows you to monitor the status of these components, trigger updates, and cancel ongoing updates. 

```typescript
import { observeComponents, updateComponent, cancelUpdateComponent } from 'mtai';

// Observe component status changes
const unsubscribe = observeComponents((components) => {
  components.forEach(component => {
    console.log(`Component ${component.name}: ${component.status}`);
  });
});

// Update a specific component
await updateComponent('component-name');

// Cancel an ongoing update for a component
await cancelUpdateComponent('component-name');

// Don't forget to unsubscribe when done
unsubscribe();
```





## Development

### Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)

### Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

### Linting

```bash
npm run lint
```

## License

MIT 