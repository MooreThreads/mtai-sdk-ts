/** @jest-environment jsdom */
import { createPlayerErrorBadge, voiceNoticeMessage } from './serviceUnavailableBadge'

test('the service badge is a removable, non-interactive status over the existing player', () => {
    const player = document.createElement('div')
    const video = document.createElement('video')
    player.append(video)
    document.body.append(player)
    try {
        const badge = createPlayerErrorBadge(document, voiceNoticeMessage('service_fault', undefined, false)!)
        player.append(badge)
        expect(badge.getAttribute('role')).toBe('status')
        expect(badge.textContent).toContain('服务暂不可用，正在加紧修复')
        expect(badge.querySelector('[aria-hidden="true"] svg')).not.toBeNull()
        expect(window.getComputedStyle(badge).pointerEvents).toBe('none')
        expect(video.parentElement).toBe(player)
        badge.remove()
        expect(player.querySelector('[role="status"]')).toBeNull()
        expect(video.parentElement).toBe(player)
    } finally {
        player.remove()
    }
})

test('voiceNoticeMessage maps ttsUnavailable and respects precedence', () => {
    expect(voiceNoticeMessage(undefined, undefined, false, false, true)).toBe('语音合成服务暂不可用，请稍后重试。')
    expect(voiceNoticeMessage(undefined, undefined, true, false, true)).toBe('语音合成服务暂不可用，请稍后重试。')
    expect(voiceNoticeMessage(undefined, undefined, false, true, true)).toBe('语音识别服务暂不可用，请稍后重试。')
    expect(voiceNoticeMessage(undefined, 'permission_denied', false, false, true)).toBe('无法访问麦克风，请检查麦克风权限')
    expect(voiceNoticeMessage('service_fault', undefined, false, false, true)).toBe('服务暂不可用，正在加紧修复')
})
