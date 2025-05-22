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

You can monitor these states through the status_change event:



## Integration

```typescript
import { createDH2DSession } from 'mtai';

// Initialize the 2d digital human session
const session = createDH2DSession(divElement, { audioInput: true })

// wakeup the 2d digital human
session.send({ type: 'wakeup' })

// tell the 2d digital human to sleep
session.send({ type: 'sleep' })

// set system-prompt
session.send({ 
  type: 'config',
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
session.send({
  type: 'config',
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


// print the subtitle
sesson.on('message', (msg) => {
  if (msg.type == 'audio_text') {
    console.log(msg.text)
  }
})

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