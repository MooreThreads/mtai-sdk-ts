import type { DHInputMessage } from 'mtai'

export type ManualInputType = Extract<
  DHInputMessage,
  { type: 'wakeup' | 'sleep' | 'input' }
>['type']

export function createManualInputMessage(
  type: ManualInputType,
  text: string,
): Extract<DHInputMessage, { type: ManualInputType }> {
  return text === ''
    ? { type }
    : { type, text }
}
