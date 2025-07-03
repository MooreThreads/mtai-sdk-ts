<script lang="ts" setup>
import {
  onMounted,
  onUnmounted,
  ref,
  watch,
  computed,
  type Ref,
  type CSSProperties,
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

defineExpose({
  send: (msg: any) => session.value?.send(msg),
  close: () => session.value?.close()
})

// 同步sessionRef
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

// 组合状态变化
watchEffect(() => {
  props.onStatusChanged?.(asrSessionActive.value ? 'listening' : status.value)
})

watch(
    () => [
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

watch(
    () => session.value,
    (newSession) => {
      if (newSession && props.onSessionStatusChanged) {
        newSession.on('statuschange', props.onSessionStatusChanged)
      }
    }
)

// 初始化会话
onMounted(() => {
  if (!containerRef.value) {
    console.error('containerRef is null')
    return
  }

  const newSession = createDH2DSession(containerRef.value, {
    videoId: props.videoId,
    audioInput: props.audioInput
  })

  const unsub = newSession.on('statuschange', (newStatus) => {
    if (newStatus === 'connected') {
      unsub()
      setTimeout(() => {
        const text = latestGreetingMsg.value
        if (text) newSession.send({ type: 'wakeup', text })
      }, 5000)
    }
  })

  newSession.on('message', (message) => {
    if (message.type === 'status_change') {
      upstreamStatus.value = message.status
      status.value = message.status
    } else if (message.type === 'asr_session') {
      const { sentence } = message
      if (sentence) {
        props.onAsrOutput?.(sentence)
        if (message.completed) {
          newSession.send({
            type: getInteractionType(upstreamStatus.value),
            text: sentence
          })
          appendHistory({ role: 'user', content: sentence })
          status.value = 'talking'
        }
      } else if (message.completed) {
        status.value = 'sleeping'
      }
    } else if (message.type === 'audio_text') {
      props.onBotOutput?.(message.text)
    } else if (message.type === 'message_record') {
      appendHistory(message.message)
      if (message.message.role === 'user' &&
          message.message.content.match(/.*(?:拜拜|再见|睡觉)(?:吧)?$/)) {
        newSession.send({ type: 'sleep' })
      }
    }
  })

  session.value = newSession
})

onUnmounted(() => {
  session.value?.close()
})

// 按键监听
if (props.asrKey) {
  const handleKey = (event: KeyboardEvent) => {
    if (event.key === props.asrKey) {
      asrSessionActive.value = event.type === 'keydown'
    }
  }

  onMounted(() => {
    document.addEventListener('keydown', handleKey)
    document.addEventListener('keyup', handleKey)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', handleKey)
    document.removeEventListener('keyup', handleKey)
  })
}

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

// 覆盖默认的getOrCreatePlayer方法
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