/** @jest-environment jsdom */
import { installAvatarBridge, avatarChannels, type PreloadPorts } from './preload'
import type { TextureMessage } from './mainTexture'
import { ABGR8888 } from '../voice/localMediaProtocol'
import type { ImportedVideo } from './textureReceiver'
const submit=jest.fn(),dispose=jest.fn(),resize=jest.fn(),checkReady=jest.fn()
const defaultIpc={on:jest.fn(),removeListener:jest.fn(),send:jest.fn(),invoke:jest.fn(async()=>{})},defaultShared={setSharedTextureReceiver:jest.fn()},expose=jest.fn()
jest.mock('electron',()=>({ipcRenderer:defaultIpc,sharedTexture:defaultShared,contextBridge:{exposeInMainWorld:expose}}),{virtual:true})
jest.mock('./webglCover',()=>({WebGLCover:jest.fn().mockImplementation(()=>({checkReady:()=>checkReady(),submit:(...args:unknown[])=>submit(...args),dispose:()=>dispose(),resize:(...args:unknown[])=>resize(...args)}))}))
const target={sessionId:'dh',generation:'g',attachment:'a'}
const layout={allocation:7n,width:4,height:3,fourcc:ABGR8888,stride:16n,offset:0n,modifier:0n,extent:48n,rowOrigin:1,colorSpace:1,sampleRate:16000,channels:1,sampleFormat:1}
function fixture(){
 const handlers=new Map<string,Function>(),messages:[string,any][]=[];let receive!:(data:{importedSharedTexture:ImportedVideo},message:TextureMessage)=>Promise<void>
 const ports:PreloadPorts={ipc:{on:(channel,callback)=>{handlers.set(channel,callback)},removeListener:channel=>{handlers.delete(channel)},send:(channel,payload)=>{messages.push([channel,payload])}},sharedTexture:{setSharedTextureReceiver:callback=>{receive=callback}}}
 const bridge=installAvatarBridge({} as HTMLCanvasElement,ports)
 const close=jest.fn(),release=jest.fn(),frame={displayWidth:4,displayHeight:3,close} as unknown as VideoFrame
 const imported={getVideoFrame:()=>frame,release}
 return {bridge,handlers,messages,close,release,imported,receive:(sequence:bigint,generation='g')=>receive({importedSharedTexture:imported},{identity:{...target,generation,allocation:7n,sequence},rowOrigin:1})}
}
beforeEach(()=>{submit.mockReset();dispose.mockReset();resize.mockReset();checkReady.mockReset();defaultIpc.on.mockClear();defaultIpc.invoke.mockClear();expose.mockClear();defaultShared.setSharedTextureReceiver.mockClear()})
it('window bridge owns the hidden receiver and moves its same-avatar cover without another native attachment',async()=>{
 let observe!: (entries: {contentRect:{width:number,height:number}}[])=>void
 ;(globalThis as any).ResizeObserver=class {constructor(callback:typeof observe){observe=callback}observe(){}disconnect(){}}
 const one=document.createElement('div'),two=document.createElement('div');one.id='one';two.id='two';document.body.append(one,two)
 installAvatarBridge();const bridge=expose.mock.calls[0][1]
 bridge.mount('#one','avatar');const canvas=one.querySelector('canvas')!;expect(canvas.style.visibility).toBe('hidden')
 await bridge.attach({conversationSessionId:'voice',dh2dSessionId:'dh',generation:'g',attachment:'a',avatarId:'avatar'})
 const event=defaultIpc.on.mock.calls.find(([channel])=>channel==='mtai:avatar:event')![1]
 event(null,{type:'frameApplied',generation:'old',sequence:1n});expect(canvas.style.visibility).toBe('hidden')
 event(null,{type:'frameApplied',generation:'g',sequence:1n});expect(canvas.style.visibility).toBe('visible')
 bridge.unmount();bridge.mount('#two','avatar');expect(two.querySelector('canvas')).toBe(canvas);expect(canvas.style.visibility).toBe('visible')
 bridge.mount('#one','replacement');expect(canvas.style.visibility).toBe('hidden')
  event(null,{type:'frameApplied',generation:'g',sequence:2n});expect(canvas.style.visibility).toBe('hidden')
  let failure:unknown;bridge.subscribe((value:unknown)=>{failure=value})
  await bridge.attach({conversationSessionId:'voice',dh2dSessionId:'new',generation:'next',attachment:'b',avatarId:'new-avatar'})
  bridge.mount('#two','new-avatar');event(null,{type:'frameApplied',generation:'next',sequence:1n});expect(canvas.style.visibility).toBe('visible')
  event(null,{type:'failed',generation:'next',message:'new graphics failed'});expect(failure).toMatchObject({type:'failed',generation:'next'})
 expect(defaultIpc.invoke).toHaveBeenCalledTimes(2);await bridge.dispose();one.remove();two.remove()
})

it('default installation adapts Electron ipcRenderer and registers the real receiver entry',async()=>{
 const bridge=installAvatarBridge({} as HTMLCanvasElement);expect(defaultIpc.on).toHaveBeenCalledWith(avatarChannels.prepare,expect.any(Function));expect(defaultShared.setSharedTextureReceiver).toHaveBeenCalled();await bridge.dispose()
})
it('lost graphics before prepare fails the new target without acknowledging acceptance',async()=>{
 const f=fixture();checkReady.mockImplementation(()=>{throw Error('context lost')});f.handlers.get(avatarChannels.prepare)!(null,{target,layout});await expect(f.receive(0n)).rejects.toThrow('context lost');expect(f.messages.some(([channel])=>channel===avatarChannels.prepared||channel===avatarChannels.accepted)).toBe(false);expect(f.messages.some(([channel])=>channel===avatarChannels.failed)).toBe(true);await f.bridge.dispose()
})
it('explicit retry after joined retirement rebuilds failed graphics without replacing conversation bridge',async()=>{
 const f=fixture();checkReady.mockImplementationOnce(()=>{throw Error('context lost')})
 f.handlers.get(avatarChannels.prepare)!(null,{target,layout});expect(f.messages.some(([channel])=>channel===avatarChannels.failed)).toBe(true)
 f.handlers.get(avatarChannels.retire)!(null,target);await Promise.resolve()
 f.handlers.get(avatarChannels.prepare)!(null,{target:{...target,generation:'next'},layout})
 expect(dispose).toHaveBeenCalledTimes(1);expect(f.messages[f.messages.length-1]).toEqual([avatarChannels.prepared,{target:{...target,generation:'next'}}]);await f.bridge.dispose()
})

it('bridge disposal notifies main before removing its retirement listener',async()=>{
 const f=fixture();await f.bridge.dispose();expect(f.messages[0][0]).toBe(avatarChannels.disposed);expect(f.handlers.size).toBe(0)
})

it('prepares hidden receiver, validates allocation probe without copying/turn observation, then submits a real frame',async()=>{
 const f=fixture();f.handlers.get(avatarChannels.prepare)!(null,{target,layout});expect(f.messages[0][0]).toBe(avatarChannels.prepared)
 await f.receive(0n);expect(submit).not.toHaveBeenCalled();expect(f.messages[1]).toEqual([avatarChannels.accepted,{target}]);expect(f.close).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledTimes(1)
 await f.receive(1n);expect(submit).toHaveBeenCalledTimes(1);expect(f.messages[2][0]).toBe(avatarChannels.submitted)
 f.handlers.get(avatarChannels.retire)!(null,target);await Promise.resolve();expect(f.messages[3]).toEqual([avatarChannels.retired,{target}]);expect(dispose).not.toHaveBeenCalled()
 f.bridge.resize(8,6);expect(resize).toHaveBeenCalledWith(8,6);await f.bridge.dispose();expect(dispose).toHaveBeenCalledTimes(1)
})
it('rejects stale imported content without healthy callback and acknowledges retirement before prepare',async()=>{
 const f=fixture();f.handlers.get(avatarChannels.retire)!(null,target);expect(f.messages).toEqual([[avatarChannels.retired,{target}]])
 f.handlers.get(avatarChannels.prepare)!(null,{target,layout});await f.receive(1n,'old');expect(f.release).toHaveBeenCalledTimes(1);expect(submit).not.toHaveBeenCalled();expect(f.messages.some(([channel])=>channel===avatarChannels.submitted)).toBe(false);await f.bridge.dispose()
})
it('draw failure releases actual imports, reports media failure and never healthy submission',async()=>{
 const f=fixture();f.handlers.get(avatarChannels.prepare)!(null,{target,layout});submit.mockImplementationOnce(()=>{throw Error('GPU failed')});await f.receive(1n)
 expect(f.close).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledTimes(1);expect(f.messages.some(([channel])=>channel===avatarChannels.failed)).toBe(true);expect(f.messages.some(([channel])=>channel===avatarChannels.submitted)).toBe(false);await f.bridge.dispose()
})
