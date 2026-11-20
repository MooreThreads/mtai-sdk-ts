const svgNamespace = 'http://www.w3.org/2000/svg'

const badgeStyles = `
[data-mtai-service-unavailable] {
    position: absolute;
    top: 28px;
    right: 32px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 17px 12px 12px;
    max-width: calc(100% - 64px);
    box-sizing: border-box;
    border: 0;
    border-radius: 13px;
    background: rgba(24, 26, 29, .36);
    color: #fff7eb;
    text-shadow: 0 1px 4px rgba(0, 0, 0, .7);
    font: 600 20px/1.4 system-ui, sans-serif;
    letter-spacing: .3px;
    pointer-events: none;
}
[data-mtai-service-unavailable] > [aria-hidden] {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 34px;
    height: 34px;
    color: #ffd18a;
}
[data-mtai-service-unavailable] .mtai-service-gear {
    transform-origin: 15.8px 15.8px;
    animation: mtaiServiceGear 1.8s infinite ease-in-out;
}
[data-mtai-service-unavailable] .mtai-service-wrench {
    transform-origin: 12.4px 12.4px;
    animation: mtaiServiceWrench 1.8s infinite ease-in-out;
}
[data-mtai-service-unavailable] .mtai-service-sparks {
    animation: mtaiServiceSparks 1.8s infinite linear;
}
@keyframes mtaiServiceGear {
    0%, 10% { transform: rotate(0deg); }
    28%, 43% { transform: rotate(-40deg); }
    61%, 76% { transform: rotate(-80deg); }
    94%, 100% { transform: rotate(-120deg); }
}
@keyframes mtaiServiceWrench {
    0%, 10%, 30%, 43%, 63%, 76%, 96%, 100% { transform: rotate(4deg); }
    20%, 53%, 86% { transform: rotate(-11deg); }
}
@keyframes mtaiServiceSparks {
    0%, 12%, 30%, 46%, 64%, 79%, 97%, 100% { opacity: .24; }
    20%, 54%, 87% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
    [data-mtai-service-unavailable] svg [class] { animation: none; }
}
`

/** Build the approved overlay for a positioned player container. The player owns its lifetime. */
export function createServiceUnavailableBadge(doc: Document,
    reason: 'service_fault' | 'local_network' | 'unknown' = 'service_fault'): HTMLDivElement {
    function svgElement<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string>) {
        const el = doc.createElementNS(svgNamespace, name)
        for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
        return el
    }

    const badge = doc.createElement('div')
    badge.setAttribute('data-mtai-service-unavailable', '')
    badge.setAttribute('role', 'status')
    const style = doc.createElement('style')
    style.textContent = badgeStyles

    const icon = doc.createElement('span')
    icon.setAttribute('aria-hidden', 'true')
    const svg = svgElement('svg', {
        width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', 'stroke-width': '1.35',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    })
    const wrench = svgElement('g', { class: 'mtai-service-wrench' })
    wrench.append(svgElement('path', {
        transform: 'translate(7.8 7.8) rotate(45)',
        d: 'M-7 .8H-.9C-.2 2.1 1.5 2.6 3.1 1.85L1.55 .8V-.8L3.1-1.85C1.5-2.6-.2-2.1-.9-.8H-7A.8 .8 0 0 0-7 .8Z',
    }))
    const gear = svgElement('g', { class: 'mtai-service-gear' })
    gear.append(
        svgElement('circle', { cx: '15.8', cy: '15.8', r: '4.1' }),
        svgElement('circle', { cx: '15.8', cy: '15.8', r: '1.45' }),
        svgElement('path', { d: 'M15.8 10.2v1.4m4.85 1.4-1.2.7m1.2 4.9-1.2-.7m-3.65 3.5V20m-4.85-1.4 1.2-.7m-1.2-4.9 1.2.7' }),
    )
    svg.append(wrench, gear, svgElement('path', {
        class: 'mtai-service-sparks', d: 'M18 5v2.8m-1.4-1.4h2.8M21.5 9.1l.8-.8',
    }))
    icon.append(svg)
    const text = doc.createElement('span')
    text.textContent = reason === 'local_network' ? '本地网络异常，请检查网络连接'
        : reason === 'unknown' ? '暂时无法连接服务，请稍后重试' : '服务暂不可用，正在加紧修复'
    badge.append(style, icon, text)
    return badge
}
