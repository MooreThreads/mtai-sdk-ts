import type { DHOutputMessage } from 'mtai'

/**
 * Bot-text callbacks offered by the DH2D demo component.
 *
 * - `onBotOutput` receives cumulative `bot_output` text (legacy
 *   compatibility: it also receives `audio_text` when no
 *   `onSubtitleOutput` is provided, matching the legacy direct-DH2D mode
 *   that reports spoken bot text through `audio_text`).
 * - `onSubtitleOutput` receives spoken `audio_text` subtitles.
 * - `onFinalAssistantText` receives the finalized assistant
 *   `message_record` content.
 */
export interface BotTextCallbacks {
  onBotOutput?: (text: string) => void,
  onSubtitleOutput?: (text: string) => void,
  onFinalAssistantText?: (content: string) => void,
}

/**
 * Routes bot-text-bearing DH2D messages to the matching callback.
 *
 * Cumulative `bot_output` text always goes to `onBotOutput`. `audio_text` is a
 * spoken subtitle and goes to `onSubtitleOutput`; when only the legacy
 * `onBotOutput` is provided it falls back there so existing consumers keep
 * working. Assistant `message_record` content is reported through
 * `onFinalAssistantText`; user records carry no bot text.
 */
export function dispatchBotTextMessage(message: DHOutputMessage, callbacks: BotTextCallbacks): void {
  if (message.type === 'audio_text') {
    if (callbacks.onSubtitleOutput) {
      callbacks.onSubtitleOutput(message.text)
    } else {
      callbacks.onBotOutput?.(message.text)
    }
  } else if (message.type === 'bot_output') {
    callbacks.onBotOutput?.(message.text)
  } else if (message.type === 'message_record' && message.message.role === 'assistant') {
    callbacks.onFinalAssistantText?.(message.message.content)
  }
}

/** Demo text display state: finalized assistant text and spoken subtitles. */
export type BotTextDisplayState = {
  /** Assistant text: latest cumulative `bot_output`, replaced by the exact assistant `message_record` content. */
  botText: string,
  /** Spoken subtitle text (`audio_text`), displayed separately from the bot text. */
  subtitleText: string,
}

export function createInitialBotTextDisplay(): BotTextDisplayState {
  return { botText: '', subtitleText: '' }
}

export type BotTextDisplayEvent =
  | { kind: 'bot_output', text: string }
  | { kind: 'audio_text', text: string }
  | { kind: 'assistant_message_record', content: string }
  | { kind: 'status_change', status: string }

/**
 * Reduces demo text display state.
 *
 * `bot_output` replaces the current text; an assistant `message_record` replaces
 * the bot text with its exact content (never appends). `audio_text` updates
 * the separate subtitle display only. Leaving `talking` clears both
 * displays.
 */
export function reduceBotTextDisplay(state: BotTextDisplayState, event: BotTextDisplayEvent): BotTextDisplayState {
  switch (event.kind) {
    case 'bot_output':
      return { ...state, botText: event.text }
    case 'audio_text':
      return { ...state, subtitleText: event.text }
    case 'assistant_message_record':
      return { ...state, botText: event.content }
    case 'status_change':
      if (event.status === 'talking' || (state.botText === '' && state.subtitleText === '')) {
        return state
      }
      return createInitialBotTextDisplay()
  }
}
