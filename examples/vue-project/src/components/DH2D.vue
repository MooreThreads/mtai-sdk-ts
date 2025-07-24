<script lang="ts" setup>
import {
  ref,
  watch,
  computed,
  type Ref,
  type CSSProperties,
  onMounted,
  watchEffect
} from 'vue'
import {
  createDH2DSession,
  DHStatus,
  DH2DSessionStatus,
  hooks,
  type ChatMessage,
  type DH2DSession,
} from 'mtai'

interface Props {
  sessionRef?: Ref<DH2DSession | null>
  style?: CSSProperties
  videoId: string
  audioInput?: boolean
  voice?: string
  asrModel?: 'local' | 'remote'
  systemPrompt?: string
  asrKey?: string
  greetingMessage?: string
  openaiCompatibleLLM?: {
    model?: string
    chatCompletionAddr?: string
    bearerToken?: string
  }
  onBotOutput?: (output: string) => void
  onAsrOutput?: (output: string) => void
  onHistoryChanged?: (history: ChatMessage[]) => void
  onStatusChanged?: (status: typeof DHStatus[number]) => void
  onSessionStatusChanged?: (status: typeof DH2DSessionStatus[number]) => void
}

const props = withDefaults(defineProps<Props>(), {
  audioInput: true
})

const containerRef = ref<HTMLDivElement | null>(null)
const session = ref<DH2DSession | null>(null)
const history = ref<ChatMessage[]>([])
const status = ref<typeof DHStatus[number]>('sleeping')
const upstreamStatus = ref<typeof DHStatus[number]>('sleeping')
const asrSessionActive = ref(false)
const latestGreetingMsg = computed(() => props.greetingMessage)
const statusLock = ref(Promise.resolve())
const containerReady = ref(false)
onMounted(() => {
  containerReady.value = true
})
defineExpose({
  send: (msg: any) => session.value?.send(msg),
  close: () => session.value?.close()
})

watch(session, (newSession) => {
  if (props.sessionRef) {
    props.sessionRef.value = newSession
  }
})

const appendHistory = (message: ChatMessage) => {
  if (
      props.onHistoryChanged &&
      (history.value.length === 0 || history.value[history.value.length - 1]?.role !== message.role)
  ) {
    history.value = [...history.value, message]
    props.onHistoryChanged(history.value)
  }
}

watchEffect(() => {
  props.onStatusChanged?.(asrSessionActive.value ? 'listening' : status.value)
})

// 处理 session 创建和销毁
watch(
  [
    () => containerReady.value,
    () => containerRef.value,
    () => props.videoId,
    () => props.audioInput,
    () => latestGreetingMsg.value,
    () => props.onSessionStatusChanged
  ],
  ([ready, container, videoId, audioInput, greetingMsg, statusChangeHandler], _, onCleanup) => {
    if (!ready || !container) return

    const newSession = createDH2DSession(container, {
      videoId,
      audioInput
    })

    const unsubStatusChange = newSession.on('statuschange', (newStatus) => {
      if (newStatus === 'connected') {
        setTimeout(() => {
          if (greetingMsg) newSession.send({ type: 'wakeup', text: greetingMsg })
        }, 5000)
      }
    })

    const messageHandler = (message: any) => {
      if (message.type === 'status_change') {
        upstreamStatus.value = message.status
        status.value = message.status
      } else if (message.type === 'asr_session') {
        handleAsrSession(message, newSession)
      } else if (message.type === 'audio_text') {
        props.onBotOutput?.(message.text)
      } else if (message.type === 'message_record') {
        handleMessageRecord(message, newSession)
      }
    }

    const handleAsrSession = (message: any, session: DH2DSession) => {
      const { sentence, completed } = message
      if (sentence) {
        props.onAsrOutput?.(sentence)
        if (completed) {
          session.send({
            type: getInteractionType(upstreamStatus.value),
            text: sentence
          })
          appendHistory({ role: 'user', content: sentence })
          status.value = 'talking'
        }
      } else if (completed) {
        status.value = 'sleeping'
      }
    }

    const handleMessageRecord = (message: any, session: DH2DSession) => {
      appendHistory(message.message)
      if (message.message.role === 'user' &&
          message.message.content.match(/.*(?:拜拜|再见|睡觉)(?:吧)?$/)) {
        session.send({ type: 'sleep' })
      }
    }


    newSession.on('message', messageHandler)
    if (statusChangeHandler) {
      newSession.on('statuschange', statusChangeHandler)
    }

    session.value = newSession

    onCleanup(() => {
      unsubStatusChange()
      newSession.off('message', messageHandler)
      if (statusChangeHandler) {
        newSession.off('statuschange', statusChangeHandler)
      }
      newSession.close()
    })
  },
  { immediate: true }
)

watch(
    () => [
      session.value,
      props.voice,
      props.systemPrompt,
      props.asrModel,
      props.openaiCompatibleLLM?.model,
      props.openaiCompatibleLLM?.chatCompletionAddr,
      props.openaiCompatibleLLM?.bearerToken
    ],
    () => {
      const { model, chatCompletionAddr, bearerToken } = props.openaiCompatibleLLM || {}
      session.value?.config({
        type: 'config',
        voice: props.voice,
        ...(props.systemPrompt && {
          message_prefix: [
            {
              role: 'system',
              content: props.systemPrompt,
            },
          ],
        }),
        ...(props.asrModel && {
          asr_model: props.asrModel,
        }),
        ...(model && {
          llm_config: { model }
        }),
        ...(chatCompletionAddr && {
          llm_service: {
            provider: 'openai',
            endpoint: chatCompletionAddr,
            ...(bearerToken && {
              token: bearerToken,
            }),
          },
        }),
      })
    },
    { immediate: true }
)

// 按键监听
watchEffect((onCleanup) => {
  if (!props.asrKey) return

  const handleKey = (event: KeyboardEvent) => {
    if (event.key === props.asrKey) {
      asrSessionActive.value = event.type === 'keydown'
    }
  }

  document.addEventListener('keydown', handleKey)
  document.addEventListener('keyup', handleKey)

  onCleanup(() => {
    document.removeEventListener('keydown', handleKey)
    document.removeEventListener('keyup', handleKey)
    asrSessionActive.value = false
  })
})

// ASR 会话状态变化处理
watch(asrSessionActive, async (active) => {
  if (!session.value || !props.asrKey) return

  const release = () => {
    const next = Promise.resolve()
    statusLock.value = next
    return next
  }

  await statusLock.value
  const currentLock = (statusLock.value = new Promise<void>(() => {}))

  try {
    if (active && status.value !== 'sleeping') {
      session.value!.send({ type: 'sleep' })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 5000)
        const stop = watch(status, (newStatus) => {
          if (newStatus === 'sleeping') {
            clearTimeout(timer)
            resolve()
            stop()
          }
        })
      })
    }
    session.value!.send({
      type: 'asr_session',
      command: active ? 'start' : 'stop',
    })
  } finally {
    if (statusLock.value === currentLock) {
      release()
    }
  }
})

function getInteractionType(status: typeof DHStatus[number]) {
  return status === 'listening' || status === 'talking' ? 'sleep' : 'wakeup'
}

hooks.dh2d.getOrCreatePlayer = ((prev) => (...args) => {
  const player = prev(...args)
  if (player.cover) {
    player.cover.style.filter = 'brightness(1.056) contrast(0.946)'
  }
  return player
})(hooks.dh2d.getOrCreatePlayer)
</script>

<template>
  <div :style="style" ref="containerRef" />
</template>

<style scoped></style>