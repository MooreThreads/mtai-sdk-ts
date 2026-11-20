/** @jest-environment jsdom */
import { createServiceUnavailableBadge } from './serviceUnavailableBadge'

test('the service badge is a removable, non-interactive status over the existing player', () => {
    const player = document.createElement('div')
    const video = document.createElement('video')
    player.append(video)
    document.body.append(player)
    try {
        const badge = createServiceUnavailableBadge(document)
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
