import { createElement, useEffect, useId, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { DH2DSession } from './dh2d/types'
import type { AvatarStatus } from './voice/avatarMediaHost'

/** Presentation only: the session/conversation and native output survive a
 * view remount. Hidden windows keep this mounted and continue submissions. */
export function Avatar({ session, onStatusChange, style }: {
  session: DH2DSession, onStatusChange?: (status: AvatarStatus) => void, style?: CSSProperties,
}): ReactElement {
  const id = `mtai-avatar-${useId().replace(/:/g, '')}`
  useEffect(() => {
    session.mountAvatar(`#${id}`)
    return () => session.unmountAvatar()
  }, [session, id])
  const [status, setStatus] = useState<AvatarStatus>(session.mediaStatus)
  useEffect(() => session.on('mediaStatus', value => { setStatus(value); onStatusChange?.(value) }), [session, onStatusChange])
  return createElement('div', { style: { position: 'absolute', inset: 0, width: '100%', height: '100%', ...style } },
    createElement('div', { id, style: { width: '100%', height: '100%' } }),
    status === 'failed' ? createElement('div', { role: 'alert', style: { position: 'absolute', bottom: 0, left: 0, right: 0, color: 'white', background: '#702020', padding: '8px' } }, 'Avatar media unavailable') : null)
}
