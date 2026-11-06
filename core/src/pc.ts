/**
 * Establishes a WebRTC connection by creating an offer, setting up ICE candidates,
 * and handling the signaling process with a remote server.
 * 
 * @param pc - The RTCPeerConnection instance to establish
 * @param url - The signaling server URL to exchange SDP information
 * @param signal - Optional owning lifecycle cancellation. Native async work is
 * awaited to retirement; cancellation prevents its subsequent signaling steps.
 * @returns A promise that resolves when the connection is established
 * 
 * @example
 * ```typescript
 * const pc = new RTCPeerConnection({
 *   iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
 * });
 * 
 * // Set up data channels or media tracks before connecting
 * const dataChannel = pc.createDataChannel('chat');
 * 
 * // Connect to the signaling server
 * await connectPc(pc, 'https://example.com/signaling');
 * 
 * // The connection is now established
 * ```
 */
export async function connectPc(pc: RTCPeerConnection, url: string, signal?: AbortSignal) {
    const checkCancelled = () => {
        if (signal?.aborted) throw new Error('connection aborted')
    }
    checkCancelled()
    let offer = await pc.createOffer()
    checkCancelled()
    await pc.setLocalDescription(offer)
    checkCancelled()
    if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                pc.removeEventListener('icegatheringstatechange', checkState)
                signal?.removeEventListener('abort', onAbort)
            }
            const onAbort = () => {
                cleanup()
                reject(new Error('connection aborted'))
            }
            const checkState = () => {
                if (pc.iceGatheringState === 'complete') {
                    cleanup()
                    resolve()
                }
            }
            pc.addEventListener('icegatheringstatechange', checkState)
            signal?.addEventListener('abort', onAbort)
            if (signal?.aborted) onAbort()
            else checkState()
        })
    }
    checkCancelled()
    let resp = await fetch(url, {
        signal,
        body: JSON.stringify(
            (({ type, sdp }) => ({ type, sdp }))(pc.localDescription!!)
        ),
        headers: {
            'Content-Type': 'application/json'
        },
        method: 'POST'
    })
    checkCancelled()
    let body = await resp.json()
    checkCancelled()
    await pc.setRemoteDescription(body)
    checkCancelled()
}
