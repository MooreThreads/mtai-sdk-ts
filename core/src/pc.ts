/**
 * Establishes a WebRTC connection by creating an offer, setting up ICE candidates,
 * and handling the signaling process with a remote server.
 * 
 * @param pc - The RTCPeerConnection instance to establish
 * @param url - The signaling server URL to exchange SDP information
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
export async function connectPc(pc: RTCPeerConnection, url: string) {
    let offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve) =>
            pc.addEventListener('icegatheringstatechange', function checkState() {
                if (pc.iceGatheringState === 'complete') {
                    pc.removeEventListener('icegatheringstatechange', checkState)
                    resolve()
                }
            })
        )
    }
    let resp = await fetch(url, {
        body: JSON.stringify(
            (({ type, sdp }) => ({ type, sdp }))(pc.localDescription!!)
        ),
        headers: {
            'Content-Type': 'application/json'
        },
        method: 'POST'
    })
    let body = await resp.json()
    await pc.setRemoteDescription(body)
}
