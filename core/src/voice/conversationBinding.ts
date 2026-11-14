import { createChannelBindingToolHandler, type VoiceClientToolHandler } from './channelBinding'
import { createChannelBindingUI } from './channelBindingUI'

/** Session-owned binding workflow/root, shared by connection attempts. */
export function createConversationBinding(endpoint: string, container?: HTMLElement) {
  let ui: ReturnType<typeof createChannelBindingUI> | undefined
  const binding = createChannelBindingToolHandler({ endpoint,
    onSnapshot: snapshot => ui?.update(snapshot), onError: error => ui?.error(error) })
  if (container) ui = createChannelBindingUI(container, binding.workflow)
  return { handler: binding.handler as VoiceClientToolHandler,
    dispose() { binding.workflow.dispose(); ui?.dispose() } }
}
export type ConversationBinding = ReturnType<typeof createConversationBinding>
