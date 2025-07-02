<script lang="ts" setup>
import {
  onMounted,
  onUnmounted,
  ref,
  watch,
  computed,
  type Ref,
  type CSSProperties
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
const historyRef = ref<ChatMessage[]>([])
const latestGreetingMsg = computed(() => props.greetingMessage)

// 状态管理 - 与React版本保持一致
const status = behaviorSubject<typeof DHStatus[number]>('sleeping')
const upstreamStatus = behaviorSubject<typeof DHStatus[number]>('sleeping')
const asrSession = behaviorSubject(false)
const statusLock = asyncLock()


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
      (historyRef.value.length === 0 || historyRef.value[historyRef.value.length - 1]?.role !== message.role)
  ) {
    historyRef.value = [...historyRef.value, message]
    props.onHistoryChanged(historyRef.value)
  }
}

combineLatest(status, asrSession, (s, a) => {
  props.onStatusChanged?.(a ? 'listening' : s)
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

  const unsub = newSession.on('statuschange', (status) => {
    if (status === 'connected') {
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
            type: interactionType(upstreamStatus.value),
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

useKey(props.asrKey, (down) => {
  asrSession.value = down
})

watch(
    () => asrSession.value,
    async (val) => {
      if (!session.value || !props.asrKey) return

      await statusLock(async () => {
        if (val && status.value !== 'sleeping') {
          session.value!.send({ type: 'sleep' })
          await new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 5000)
            const unsubscribe = status.subscribe((status) => {
              if (status === 'sleeping') {
                resolve()
                unsubscribe()
              }
            })
          })
        }
        session.value!.send({
          type: 'asr_session',
          command: val ? 'start' : 'stop',
        })
      })
    }
)

// 工具函数
function useKey(key: string | undefined, callback: (down: boolean) => void) {
  const handler = (event: KeyboardEvent) => {
    if (event.key === key) {
      callback(event.type === 'keydown')
    }
  }

  if (key) {
    onMounted(() => {
      document.addEventListener('keydown', handler)
      document.addEventListener('keyup', handler)
    })

    onUnmounted(() => {
      document.removeEventListener('keydown', handler)
      document.removeEventListener('keyup', handler)
    })
  }
}

function asyncLock() {
  let released = Promise.resolve()

  return async function lock<T>(f: () => Promise<T>): Promise<T> {
    await released
    let resolve: () => void
    released = new Promise<void>(r => resolve = r)
    return f().finally(() => resolve?.())
  }
}

function behaviorSubject<T>(initialValue: T) {
  const subscribers = new Set<(value: T) => void>()
  const state = ref<T>(initialValue)

  return {
    get value() {
      return state.value
    },
    set value(newValue: T) {
      if (state.value !== newValue) {
        state.value = newValue
        subscribers.forEach(fn => fn(newValue))
      }
    },
    subscribe(fn: (value: T) => void) {
      fn(state.value)
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    }
  }
}

function combineLatest<A, B>(
    a: ReturnType<typeof behaviorSubject<A>>,
    b: ReturnType<typeof behaviorSubject<B>>,
    cb: (a: A, b: B) => void
) {
  let aValue = a.value
  let bValue = b.value

  const publish = () => cb(aValue, bValue)

  const unsubA = a.subscribe((v) => {
    aValue = v
    publish()
  })

  const unsubB = b.subscribe((v) => {
    bValue = v
    publish()
  })

  publish()

  onUnmounted(() => {
    unsubA()
    unsubB()
  })
}

function interactionType(type: typeof DHStatus[number]) {
  return type === 'listening' || type === 'talking' ? 'sleep' : 'wakeup'
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