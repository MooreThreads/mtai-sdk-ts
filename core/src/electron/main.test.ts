import { installAvatarHost, type MainPorts, type AvatarWindow } from './main'
import { avatarChannels } from './preload'
import type { AvatarNative, ConnectionEvent } from './attachmentRuntime'
import { encodeLocalMedia, ABGR8888 } from '../voice/localMediaProtocol'
import type { TextureMessage } from './mainTexture'
const target={sessionId:'dh',generation:'g',attachment:'a'}
const attachment={conversationSessionId:'voice',dh2dSessionId:'dh',generation:'g',attachment:'a'}
const layout={kind:'layout' as const,target,allocation:7n,width:4,height:3,fourcc:ABGR8888,stride:16n,offset:0n,modifier:0n,extent:48n,rowOrigin:1,colorSpace:1,sampleRate:16000,channels:1,sampleFormat:1}
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
function fixture(playbackFailure?: Error){
 const handlers=new Map<string,Function>(),windowHandlers=new Map<string,Function>(),sent:any[]=[],controlsIpc=new Map<string,Function>()
 const contents={mainFrame:{},send:jest.fn((channel:string,payload:unknown)=>{sent.push([channel,payload])}),on:(name:string,listener:Function)=>{windowHandlers.set(name,listener)},removeListener:(name:string)=>{windowHandlers.delete(name)}}
 const window:AvatarWindow={webContents:contents,on:(name,listener)=>{windowHandlers.set(name,listener)},removeListener:name=>{windowHandlers.delete(name)}}
 let receive!:(event:ConnectionEvent)=>void,audio!:(event:{type:string})=>void
 const controls:any[]=[],release=jest.fn(),connection={retainAllocation:()=>({fd:43,close:release}),acceptLayout:jest.fn(),sendControl:jest.fn(),close:jest.fn(async()=>{})}
 const playback={submitEligible:jest.fn(),stop:jest.fn(async()=>{}),end:jest.fn(),close:jest.fn(async()=>{})}
 const native:AvatarNative={createConnection:(_path,_wire,callback)=>{receive=callback;return connection},createPlayback:(_wire,callback)=>{if(playbackFailure)throw playbackFailure;audio=callback;return playback},monotonicNs:()=>123n}
 const ports:MainPorts={ipcMain:{handle:(channel,handler)=>{controlsIpc.set(channel,handler)},removeHandler:channel=>{controlsIpc.delete(channel)},on:(channel,handler)=>{handlers.set(channel,handler)},removeListener:channel=>{handlers.delete(channel)}},sharedTexture:{importSharedTexture:options=>({release:()=>options.allReferencesReleased()}),sendSharedTexture:async(_options,message)=>{controls.push(message)}}}
 const host=installAvatarHost(window,{socketPath:'/trusted',nativeAddonPath:'/unused'},ports,native)
 const ipc=(channel:string,value:unknown,trusted=true)=>handlers.get(channel)?.({sender:trusted?contents:{},senderFrame:contents.mainFrame},value)
 return {host,controlsIpc,contents,handlers,sent,controls,connection,playback,release,ipc,windowHandlers,receive:(event:ConnectionEvent)=>receive(event),audio:()=>audio({type:'audioReady'})}
}
it('closed window never sends to destroyed contents and removes host registrations after joined retirement',async()=>{
 const f=fixture();const attaching=f.host.attach(attachment);const failure=expect(attaching).rejects.toThrow();await tick();f.receive({type:'layout',wire:encodeLocalMedia(layout),fd:42});await tick()
 f.contents.send.mockImplementation(()=>{throw Error('Object has been destroyed')})
 expect(()=>f.windowHandlers.get('closed')!()).not.toThrow();await failure;await tick();await f.host.dispose()
 expect(f.connection.close).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledTimes(1);expect(f.controlsIpc.size).toBe(0);expect(f.handlers.size).toBe(0)
 const replacement=fixture();expect(replacement.controlsIpc.has('mtai:avatar:control')).toBe(true);await replacement.host.dispose()
})

it('installed control entry rejects a foreign frame and routes only typed SDK attachment/stop operations',async()=>{
 const f=fixture(),control=f.controlsIpc.get('mtai:avatar:control')!
 await expect(control({sender:{},senderFrame:f.contents.mainFrame},{operation:'attach',target:attachment})).rejects.toThrow('sender rejected')
 await expect(control({sender:f.contents,senderFrame:f.contents.mainFrame},{operation:'arbitrary-native-call'})).rejects.toThrow('invalid avatar control')
 await control({sender:f.contents,senderFrame:f.contents.mainFrame},{operation:'stop',request:{generation:'g',reason:'detach'}})
 await f.host.dispose();expect(f.controlsIpc.size).toBe(0)
})

it('authenticates main-frame preparation/submission and resolves only selected ATTACHED',async()=>{
 const f=fixture(),events:any[]=[];f.host.subscribe(event=>events.push(event));let ready=false
 const attaching=f.host.attach(attachment).then(()=>{ready=true});await tick();f.receive({type:'layout',wire:encodeLocalMedia(layout),fd:42});f.audio()
 f.ipc(avatarChannels.prepared,{target},false);await tick();expect(f.controls).toEqual([])
 f.ipc(avatarChannels.prepared,{target});await tick();expect(f.controls[0].identity.sequence).toBe(0n)
 f.ipc(avatarChannels.accepted,{target:{...target,generation:'stale'}});await tick();expect(f.connection.acceptLayout).not.toHaveBeenCalled()
 f.ipc(avatarChannels.accepted,{target});await tick();expect(f.connection.acceptLayout).toHaveBeenCalledWith(7n);expect(ready).toBe(false)
 f.receive({type:'attached'});await attaching
 f.receive({type:'eligible',frame:encodeLocalMedia({kind:'frame',target,sequence:1n,allocation:7n,rendererFrame:1n,producedNs:0n,sampleStart:0n,sampleCount:0n,pcm:new Uint8Array()}),state:encodeLocalMedia({kind:'state',target,effectiveFrame:1n,snapshot:true,turnId:'A1',audioActive:true}),originNs:1n,revision:0n});await tick()
 const message:TextureMessage=f.controls[1];f.ipc(avatarChannels.submitted,{identity:message.identity,ok:true},false);expect(events).toEqual([])
 f.ipc(avatarChannels.submitted,{identity:message.identity,ok:true});expect(events[0]).toMatchObject({type:'frameApplied',sequence:1n});expect(f.connection.sendControl).toHaveBeenCalledTimes(1)
 const disposal=f.host.dispose();await tick();expect(f.release).not.toHaveBeenCalled();f.ipc(avatarChannels.retired,{target});await disposal;expect(f.release).toHaveBeenCalledTimes(1);expect(f.handlers.size).toBe(0)
})
it('navigation during delayed audio acceptance fences the old document and joins without an impossible receiver ack',async()=>{
 const f=fixture();const attaching=f.host.attach(attachment);const failure=expect(attaching).rejects.toThrow();await tick();f.receive({type:'layout',wire:encodeLocalMedia(layout),fd:42});await tick();f.ipc(avatarChannels.prepared,{target});await tick()
 f.windowHandlers.get('did-start-navigation')!(null,'file:///replacement',false,true);await failure;await tick();f.audio();await tick();await f.host.dispose();expect(f.connection.acceptLayout).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledTimes(1)
})
it('bridge disposal while window survives cancels preparation and does not wait for a removed retire listener',async()=>{
 const f=fixture();const attaching=f.host.attach(attachment);const failure=expect(attaching).rejects.toThrow();await tick();f.receive({type:'layout',wire:encodeLocalMedia(layout),fd:42});await tick()
 f.ipc(avatarChannels.disposed,{});await failure;await tick();await f.host.dispose();expect(f.release).toHaveBeenCalledTimes(1)
})

it('load completion does not erase a preload failure or wait for a missing receiver',async()=>{
 const f=fixture()
 f.windowHandlers.get('preload-error')!(null,'preload.js',Error('WebGL unavailable'))
 f.windowHandlers.get('did-finish-load')!()
 const attaching=f.host.attach(attachment);const failure=expect(attaching).rejects.toThrow('renderer unavailable')
 await tick();f.receive({type:'layout',wire:encodeLocalMedia(layout),fd:42});await failure;await f.host.dispose()
 expect(f.sent.some(([channel])=>channel===avatarChannels.prepare)).toBe(false)
 expect(f.connection.acceptLayout).not.toHaveBeenCalled()
 expect(f.playback.close).toHaveBeenCalledTimes(1);expect(f.connection.close).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledTimes(1)
})
it('a genuinely new document can prepare afresh after a previous preload failure',async()=>{
 const f=fixture()
 f.windowHandlers.get('preload-error')!(null,'preload.js',Error('WebGL unavailable'));f.windowHandlers.get('did-finish-load')!()
 f.windowHandlers.get('did-start-navigation')!(null,'file:///replacement',false,true);f.windowHandlers.get('did-finish-load')!()
 const attaching=f.host.attach(attachment);await tick();f.receive({type:'layout',wire:encodeLocalMedia(layout),fd:42});f.audio();await tick()
 expect(f.sent[0][0]).toBe(avatarChannels.prepare)
 f.ipc(avatarChannels.prepared,{target});await tick();f.ipc(avatarChannels.accepted,{target});await tick();f.receive({type:'attached'});await attaching
 const disposal=f.host.dispose();await tick();f.ipc(avatarChannels.retired,{target});await disposal
})

it('synchronous native playback construction failure rejects attachment and joins without an unhandled audio rejection',async()=>{
 const f=fixture(Error('native playback initialization failed'))
 const attaching=f.host.attach(attachment);const failure=expect(attaching).rejects.toThrow('native playback initialization failed')
 await tick();f.receive({type:'layout',wire:encodeLocalMedia(layout),fd:42});await failure;await f.host.dispose()
 // Give unhandled-rejection reporting a full event-loop turn, without adding a
 // timeout or altering the runtime's lifecycle.
 await new Promise<void>(resolve=>setImmediate(resolve))
 expect(f.connection.acceptLayout).not.toHaveBeenCalled();expect(f.connection.close).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledTimes(1)
 expect(f.playback.close).not.toHaveBeenCalled()
})

it('peer failure before graphics preparation retires without waiting for an uncreated receiver',async()=>{
 const f=fixture();const attaching=f.host.attach(attachment);const failure=expect(attaching).rejects.toThrow('socket failed');await tick();f.receive({type:'failed',message:'socket failed'});await failure;await tick();await f.host.dispose();expect(f.connection.close).toHaveBeenCalled()
})
