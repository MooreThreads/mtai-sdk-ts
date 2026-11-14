import { DH2DSessionConfig, DH2DSession, ResolvedDH2DSessionConfig } from './types'
import { Abortable, Box } from '../types'
import { box } from '../box'
import { config as rootConfig } from '../config'

function defaultConfig(config?: DH2DSessionConfig): ResolvedDH2DSessionConfig {
  return { ...config, voiceClient: config?.voiceClient || rootConfig().voiceClient,
    rtcConfiguration: config?.rtcConfiguration || {}, audioInput: config?.audioInput || false,
    sessionId: config?.sessionId || Math.random().toString(36).substring(2, 15), videoId: config?.videoId || 'liruyun',
    frameRate: config?.frameRate || 25, reconnectInterval: config?.reconnectInterval || 20 * 60 * 1000,
    connectTimeout: config?.connectTimeout || 60 * 1000, maxAudioVideoDurationDifference: config?.maxAudioVideoDurationDifference || 10 * 1000,
    pingInterval: config?.pingInterval || 10 * 1000, pingTimeout: config?.pingTimeout || 5 * 1000 }
}
export const globalDH2DSessions: Box<DH2DSession[]> = box([])
export const untilSessionCountLessThanOrEqualTo = (count: number) => async (session: DH2DSession, abortable: Abortable) => {
  await new Promise<void>(resolve => {
    let finished = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let unsubscribe = () => {}, unregister = () => {}
    const finish = () => { finished = true; unsubscribe(); unregister(); timers.forEach(clearTimeout); timers.clear(); resolve() }
    const claim = () => {
      if (finished || globalDH2DSessions.value.length > count) return
      finish(); globalDH2DSessions.value = [...globalDH2DSessions.value, session]
    }
    unregister = abortable.onabort(finish)
    if (finished) return
    unsubscribe = globalDH2DSessions.on('value', () => { const timer = setTimeout(() => { timers.delete(timer); claim() }, 1000); timers.add(timer) })
    claim()
  })
}
async function afterClosingSession(session: DH2DSession) { globalDH2DSessions.value = globalDH2DSessions.value.filter(s => s !== session) }
export const dh2dHooks = { defaultConfig, beforeConnectingSession: untilSessionCountLessThanOrEqualTo(0), afterClosingSession }
