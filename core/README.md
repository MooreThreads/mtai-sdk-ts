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

## Voice-client avatar mode (opt-in)

When the local voice client owns the digital-human session, configure
`voiceClient` and keep the same session API. The SDK then talks to the voice
client for voice protocol traffic and exchanges the WebRTC offer directly with
DH2D using the canonical session id the client reports; `voiceClient.interaction_endpoint`
is the browser-to-local voice interaction websocket, and `voiceClient.dh2d_endpoint`
is the HTTP endpoint of the DH2D server used for that offer exchange and for
avatar discovery, while the global `endpoint` stays the legacy service
endpoint for all other requests; a partial runtime config that omits
`dh2d_endpoint` falls back to the global `endpoint` for those avatar
operations. `wakeup`, `sleep`,
and text input are translated to the client protocol, TTS subtitles are
surfaced as `audio_text`, streamed LLM output as `bot_output`, and a
`message_record` is derived from accumulated `bot_output` at `turn.end`.
Avatar playback boundaries are decoded from the DH2D video turn stripe and
reported to the client as `playback.ended`.

Input mapping in voice-client mode:

- `input.text` maps to the client protocol's `text.input`.
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

Playback boundaries: a validated stripe transition from turn A to a
different turn B reports `playback.ended` for A. The A→idle boundary (the
last turn of a playback sequence returning to idle) is never guessed from
frames — DH2D idle frames are undecodable and invalid stripes must not emit
— it is reported only on the explicit, protocol-safe `playback.stop`
lifecycle signal from the client. The signal's `session_id` and `turn_id`
are validated against the tracked avatar turn, so a stop targeted at a
retired or still-queued turn never retires the turn currently playing.

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

// tell the 2d digital human to sleep
session.send({ type: 'sleep' })

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