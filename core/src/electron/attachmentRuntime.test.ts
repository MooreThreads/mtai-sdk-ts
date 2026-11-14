import { AttachmentRuntime, type AvatarNative, type ConnectionEvent } from './attachmentRuntime'
import { encodeLocalMedia, decodeLocalMedia, ABGR8888, type LocalMediaRecord } from '../voice/localMediaProtocol'
import type { SharedTextures, TextureIdentity } from './mainTexture'
const target = { sessionId: 'dh', generation: 'g', attachment: 'a' }
const attachment = { conversationSessionId: 'voice', dh2dSessionId: 'dh', generation: 'g', attachment: 'a' }
const layout = { kind: 'layout' as const, target, allocation: 7n, width: 4, height: 3, fourcc: ABGR8888,
  stride: 16n, offset: 0n, modifier: 0n, extent: 48n, rowOrigin: 1, colorSpace: 1, sampleRate: 16000, channels: 1, sampleFormat: 1 }
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((a,b) => { resolve=a;reject=b });return {promise,resolve,reject} }
const tick = async () => { for (let i=0;i<8;i++) await Promise.resolve() }
function fixture() {
  let connectionEvent!: (event: ConnectionEvent) => void, audioEvent!: (event: {type:string,message?:string}) => void
  const gpu=deferred(), accepted=deferred(), references: (()=>void)[]=[]
  const controls: LocalMediaRecord[]=[], effects: string[]=[], events: any[]=[]
  const lease={fd:43,close:jest.fn(()=>effects.push('allocation close'))}
  const playback={submitEligible:jest.fn(()=>effects.push('pcm')),stop:jest.fn(async()=>{}),end:jest.fn(),close:jest.fn(async()=>{effects.push('audio close')})}
  const selected=deferred()
  const connection={retainAllocation:()=>lease,acceptLayout:jest.fn(()=>selected.resolve()),sendControl:(wire:Uint8Array)=>controls.push(decodeLocalMedia(wire)),close:jest.fn(async()=>{effects.push('socket close')})}
  const native: AvatarNative={createConnection:(_path,_wire,callback)=>{connectionEvent=callback;return connection},createPlayback:(_wire,callback)=>{audioEvent=callback;return playback},monotonicNs:()=>123n}
  const textures: SharedTextures={importSharedTexture:options=>{references.push(options.allReferencesReleased);return {release:()=>{effects.push('main release');options.allReferencesReleased()}}},
    sendSharedTexture:jest.fn(async(_options,message)=>{effects.push(message.identity.sequence===0n?'probe':'video')})}
  let accepting=false,preparing=false
  const destination={frame:'main-frame',prepare:()=>{preparing=true;return gpu.promise},accepted:()=>{accepting=true;return accepted.promise},retire:jest.fn(async()=>{if(preparing)gpu.reject(Error('retired'));if(accepting)accepted.reject(Error('retired'))})}
  const runtime=new AttachmentRuntime(attachment,'/trusted/socket',native,textures,destination,event=>events.push(event))
  return {runtime,gpu,accepted,selected,connection,playback,textures,effects,events,lease,controls,
    send:(event:ConnectionEvent)=>connectionEvent(event),audio:(type:string)=>audioEvent({type})}
}
it('waits actual audio and receiver allocation acceptance before READY, then selected ATTACHED',async()=>{
 const f=fixture();let ready=false;const attaching=f.runtime.attach().then(()=>{ready=true})
 f.send({type:'layout',wire:encodeLocalMedia(layout),fd:42});f.audio('audioReady');await tick();expect(f.connection.acceptLayout).not.toHaveBeenCalled()
 f.gpu.resolve();await tick();expect(f.effects).toContain('probe');expect(f.connection.acceptLayout).not.toHaveBeenCalled()
 f.accepted.resolve();await tick();expect(f.connection.acceptLayout).toHaveBeenCalledWith(7n);expect(ready).toBe(false);expect(f.events).toEqual([])
 f.send({type:'attached'});await attaching;expect(ready).toBe(true);await f.runtime.close();expect(f.effects[f.effects.length-1]).toBe('allocation close')
})
it('dispatches one native-eligible pair and applies only healthy submission; EOS is not a turn event',async()=>{
 const f=fixture();const attaching=f.runtime.attach();f.send({type:'layout',wire:encodeLocalMedia(layout),fd:42});f.audio('audioReady');f.gpu.resolve();f.accepted.resolve();await f.selected.promise;f.send({type:'attached'});await attaching
 const frame={kind:'frame' as const,target,sequence:1n,allocation:7n,rendererFrame:9n,producedNs:0n,sampleStart:0n,sampleCount:1n,pcm:Uint8Array.of(1,2)}
 f.send({type:'eligible',frame:encodeLocalMedia(frame),state:encodeLocalMedia({kind:'state',target,effectiveFrame:1n,snapshot:true,turnId:'A1',audioActive:true}),originNs:7n,revision:2n})
 await tick();expect(f.effects.slice(-3)).toEqual(['pcm','video','main release']);expect(f.events).toEqual([])
 const id:TextureIdentity={...target,allocation:7n,sequence:1n};f.runtime.submitted(id,true)
 expect(f.events).toEqual([{type:'frameApplied',generation:'g',sequence:1n,turnId:'A1',audioActive:true}]);expect(f.controls[0]).toMatchObject({kind:'reuseAck',submissionReceiptNs:123n,phaseOriginNs:7n})
 await f.runtime.stop('A1');expect(f.playback.stop).toHaveBeenCalledWith('dh','g','a','A1');f.send({type:'eos'});expect(f.playback.end).toHaveBeenCalledTimes(1);expect(f.events).toHaveLength(1);await f.runtime.close()
})
it('close during audio/graphics preparation cancels and joins without READY or released allocation early',async()=>{
 const f=fixture();const attaching=f.runtime.attach();const outcome=expect(attaching).rejects.toThrow('retired');f.send({type:'layout',wire:encodeLocalMedia(layout),fd:42});await f.runtime.close();await outcome
 expect(f.connection.acceptLayout).not.toHaveBeenCalled();expect(f.playback.close).toHaveBeenCalledTimes(1);expect(f.lease.close).toHaveBeenCalledTimes(1)
})
