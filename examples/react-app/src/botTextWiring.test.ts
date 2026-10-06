import test from 'node:test'
import assert from 'node:assert/strict'

import type { DHOutputMessage } from 'mtai'
import {
  createInitialBotTextDisplay,
  dispatchBotTextMessage,
  reduceBotTextDisplay,
  type BotTextCallbacks,
  type BotTextDisplayEvent,
  type BotTextDisplayState,
} from './botTextWiring.ts'

function recordCalls(): BotTextCallbacks & {
  calls: { bot: string[], subtitle: string[], final: string[] },
} {
  const calls = { bot: [] as string[], subtitle: [] as string[], final: [] as string[] }
  return {
    calls,
    onBotOutput: (text) => calls.bot.push(text),
    onSubtitleOutput: (text) => calls.subtitle.push(text),
    onFinalAssistantText: (content) => calls.final.push(content),
  }
}

test('accumulates bot_output fragments in the displayed bot text', () => {
  let state = createInitialBotTextDisplay()

  state = reduceBotTextDisplay(state, { kind: 'bot_output', text: '你好' })
  state = reduceBotTextDisplay(state, { kind: 'bot_output', text: '，世界' })

  assert.equal(state.botText, '你好，世界')
  assert.equal(state.subtitleText, '')
})

test('assistant message_record replaces the displayed bot text with exact content', () => {
  let state = createInitialBotTextDisplay()
  state = reduceBotTextDisplay(state, { kind: 'bot_output', text: 'draft' })

  state = reduceBotTextDisplay(state, { kind: 'assistant_message_record', content: 'final answer' })

  assert.equal(state.botText, 'final answer')

  state = reduceBotTextDisplay(state, { kind: 'assistant_message_record', content: 'second' })

  assert.equal(state.botText, 'second')
})

test('replaces the displayed bot text even when the finalized content repeats it', () => {
  let state = createInitialBotTextDisplay()
  state = reduceBotTextDisplay(state, { kind: 'bot_output', text: 'same' })

  state = reduceBotTextDisplay(state, { kind: 'assistant_message_record', content: 'same' })

  assert.equal(state.botText, 'same')
})

test('assistant message_record with empty content clears the displayed bot text', () => {
  let state = createInitialBotTextDisplay()
  state = reduceBotTextDisplay(state, { kind: 'bot_output', text: 'draft' })

  state = reduceBotTextDisplay(state, { kind: 'assistant_message_record', content: '' })

  assert.equal(state.botText, '')
})

test('audio_text updates a separate subtitle display and never touches bot text', () => {
  let state = createInitialBotTextDisplay()
  state = reduceBotTextDisplay(state, { kind: 'bot_output', text: 'answer' })

  state = reduceBotTextDisplay(state, { kind: 'audio_text', text: 'spoken part 1' })
  state = reduceBotTextDisplay(state, { kind: 'audio_text', text: 'spoken part 2' })

  assert.equal(state.botText, 'answer')
  assert.equal(state.subtitleText, 'spoken part 2')
})

test('clears both displays when the avatar stops talking and keeps them while talking', () => {
  let state = createInitialBotTextDisplay()
  state = reduceBotTextDisplay(state, { kind: 'bot_output', text: 'answer' })
  state = reduceBotTextDisplay(state, { kind: 'audio_text', text: 'spoken' })

  state = reduceBotTextDisplay(state, { kind: 'status_change', status: 'talking' })
  assert.equal(state.botText, 'answer')
  assert.equal(state.subtitleText, 'spoken')

  state = reduceBotTextDisplay(state, { kind: 'status_change', status: 'listening' })
  assert.equal(state.botText, '')
  assert.equal(state.subtitleText, '')

  // Repeated non-talking statuses keep returning the same cleared state.
  const repeated = reduceBotTextDisplay(state, { kind: 'status_change', status: 'sleeping' })
  assert.equal(repeated, state)
})

test('routes audio_text to the spoken subtitle callback, not to onBotOutput', () => {
  const callbacks = recordCalls()

  dispatchBotTextMessage({ type: 'audio_text', text: 'spoken' }, callbacks)

  assert.deepEqual(callbacks.calls.subtitle, ['spoken'])
  assert.deepEqual(callbacks.calls.bot, [])
  assert.deepEqual(callbacks.calls.final, [])
})

test('falls back to onBotOutput for audio_text when no subtitle callback is provided (legacy wiring)', () => {
  const calls: string[] = []

  dispatchBotTextMessage({ type: 'audio_text', text: 'spoken' }, {
    onBotOutput: (text) => calls.push(text),
  })

  assert.deepEqual(calls, ['spoken'])
})

test('routes bot_output fragments to onBotOutput even when subtitle callbacks are wired', () => {
  const callbacks = recordCalls()

  dispatchBotTextMessage({ type: 'bot_output', text: 'frag' }, callbacks)

  assert.deepEqual(callbacks.calls.bot, ['frag'])
  assert.deepEqual(callbacks.calls.subtitle, [])
})

test('reports finalized assistant message_record content, not user records', () => {
  const callbacks = recordCalls()

  dispatchBotTextMessage(
    { type: 'message_record', message: { role: 'assistant', content: 'final' } },
    callbacks,
  )
  dispatchBotTextMessage(
    { type: 'message_record', message: { role: 'user', content: 'question' } },
    callbacks,
  )

  assert.deepEqual(callbacks.calls.final, ['final'])
  assert.deepEqual(callbacks.calls.bot, [])
  assert.deepEqual(callbacks.calls.subtitle, [])
})

test('ignores messages that carry no bot text', () => {
  const callbacks = recordCalls()

  dispatchBotTextMessage({ type: 'status_change', status: 'talking' }, callbacks)
  dispatchBotTextMessage({ type: 'asr_process', sentence: 'hello' }, callbacks)
  dispatchBotTextMessage({ type: 'session_ended' }, callbacks)

  assert.deepEqual(callbacks.calls.bot, [])
  assert.deepEqual(callbacks.calls.subtitle, [])
  assert.deepEqual(callbacks.calls.final, [])
})

test('a full turn keeps subtitles separate and finalizes bot text with the exact record', () => {
  let state: BotTextDisplayState = createInitialBotTextDisplay()
  const callbacks: BotTextCallbacks = {
    onBotOutput: (text) => { state = reduceBotTextDisplay(state, { kind: 'bot_output', text }) },
    onSubtitleOutput: (text) => { state = reduceBotTextDisplay(state, { kind: 'audio_text', text }) },
    onFinalAssistantText: (content) => {
      state = reduceBotTextDisplay(state, { kind: 'assistant_message_record', content })
    },
  }

  const messages: DHOutputMessage[] = [
    { type: 'bot_output', text: 'The answer ' },
    { type: 'audio_text', text: 'The answer is ' },
    { type: 'audio_text', text: 'The answer is 42.' },
    { type: 'bot_output', text: 'is 42.' },
    { type: 'message_record', message: { role: 'assistant', content: 'The answer is 42.' } },
  ]
  for (const message of messages) {
    dispatchBotTextMessage(message, callbacks)
  }

  assert.equal(state.botText, 'The answer is 42.')
  assert.equal(state.subtitleText, 'The answer is 42.')
})
