const assert = require('node:assert/strict');
const { Worker, MessageChannel } = require('node:worker_threads');
const fs = require('node:fs');const os = require('node:os');
const path = require('node:path');
const addonPath = path.resolve(process.argv[2]);
const addon = require(addonPath);const { createPlayback } = addon;
const target = Buffer.concat(['session', 'generation', 'attachment'].map(value => {
  const bytes = Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); return Buffer.concat([length, bytes]);
}));
function u64(value) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; }
function wire(kind, body) { const header = Buffer.alloc(16); header.write('D2LM'); header.writeUInt16LE(1, 4); header.writeUInt16LE(kind, 6); header.writeBigUInt64LE(BigInt(target.length + body.length), 8); return Buffer.concat([header, target, body]); }
function layout() {
  const fields = Buffer.alloc(70); let at = 0;
  const n = (value, size) => { if (size === 8) fields.writeBigUInt64LE(BigInt(value), at); else fields.writeUIntLE(value, at, size); at += size; };
  n(7,8);n(4,4);n(4,4);n(0x34324241,4);n(16,8);n(0,8);n(0,8);n(64,8);n(1,1);n(1,1);n(16000,4);n(1,2);n(1,2);
  return wire(2, fields.subarray(0, at));
}
function frame(sequence) { return wire(6, Buffer.concat([u64(sequence),u64(7),u64(sequence),u64(0),u64(0),u64(0),u64(0)])); }
function state(sequence) { return wire(5, Buffer.concat([u64(sequence),Buffer.from([1,0,1])])); }
async function basic() {
  delete process.env.MTAI_TEST_OUTPUT_MODE;
  const events=[];let resolve;const done=new Promise(r=>resolve=r);
  const output=createPlayback(layout(),event=>{events.push(event);if(event.type==='audioReady')output.submitEligible(frame(9007199254740993n),state(9007199254740993n));if(event.type==='pcmCompleted')resolve();});
  await done;assert.equal(events[1].sequence,9007199254740993n);assert.equal(events[1].sampleCount,0n);
  assert.throws(()=>output.submitEligible('not-buffer',state(1)),/Buffer/);
  assert.throws(()=>output.submitEligible(new Uint8Array(frame(1)),state(1)),/Buffer/);
  const {port1,port2}=new MessageChannel();port1.on('message',()=>{});port1.ref();port2.ref();
  await output.close();port1.close();port2.close();await output.close();assert.throws(()=>output.end(),/closed/);
}
async function callbackThrow() {
  let output;let resolve;const done=new Promise(r=>resolve=r);output=createPlayback(layout(),event=>{if(event.type==='audioReady')throw new Error('caller');if(event.type==='failed')resolve();});
  await done;await output.close();
}
async function retry() {
  process.env.MTAI_TEST_OUTPUT_MODE='close-fail';let resolve;const ready=new Promise(r=>resolve=r);
  const output=createPlayback(layout(),event=>{if(event.type==='audioReady')resolve();});await ready;
  await assert.rejects(output.close());await output.close();delete process.env.MTAI_TEST_OUTPUT_MODE;
}
async function closeThenThrow() {
  process.env.MTAI_TEST_OUTPUT_MODE='close-fail';let output;let rejection;let resolve;const failed=new Promise(r=>resolve=r);
  let failures=0;output=createPlayback(layout(),event=>{if(event.type==='audioReady'){rejection=output.close().catch(()=>{});throw new Error('close then throw');}if(event.type==='failed' && ++failures===2)resolve();});
  await failed;await rejection;assert.equal(addon.testAttempts(),1);await output.close();delete process.env.MTAI_TEST_OUTPUT_MODE;
}
async function closeAllocationFault() {
  let resolve;const ready=new Promise(r=>resolve=r);const output=createPlayback(layout(),event=>{if(event.type==='audioReady')resolve();});await ready;
  addon.testFault(0);assert.throws(()=>output.close(),/bad_alloc|allocation/);addon.testFault(-1);await output.close();
}
async function threadStartFailure() {
  let resolve;const failed=new Promise(r=>resolve=r);addon.testThreadFault();
  const output=createPlayback(layout(),event=>{if(event.type==='failed')resolve();});await failed;await output.close();
  const worker=new Worker(`const{parentPort}=require('node:worker_threads');const addon=require(${JSON.stringify(addonPath)});addon.testThreadFault();addon.createPlayback(Buffer.from(${JSON.stringify(layout().toString('hex'))},'hex'),()=>{});parentPort.postMessage('activated');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`,{eval:true});
  await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});await worker.terminate();
}
async function promiseReentry() {
  const {createHook}=require('node:async_hooks');process.env.MTAI_TEST_OUTPUT_MODE='close-fail';
  let resolve;const ready=new Promise(r=>resolve=r);const output=createPlayback(layout(),event=>{if(event.type==='audioReady')resolve();});await ready;
  let nested,inside=false;const init=createHook({init(_id,type){if(type==='PROMISE'&&!inside){inside=true;assert.throws(()=>output.submitEligible(frame(1),state(1)),/closed/);assert.throws(()=>output.stop('session','generation','attachment','A1'),/closed/);assert.throws(()=>output.end(),/closed/);nested=output.close();}}});
  init.enable();const first=output.close();init.disable();
  const results=await Promise.allSettled([first,nested]);assert(results.every(value=>value.status==='rejected'));
  let retry;
  // A fresh instance supplies a rejection while the hook enqueues a distinct retry.
  await output.close();delete process.env.MTAI_TEST_OUTPUT_MODE;
  process.env.MTAI_TEST_OUTPUT_MODE='close-fail';let accepted;const acceptedPromise=new Promise(r=>accepted=r);
  const second=createPlayback(layout(),event=>{if(event.type==='audioReady')accepted();});await acceptedPromise;
  const hook=createHook({promiseResolve(){if(!inside){inside=true;retry=second.close();}}});inside=false;hook.enable();
  const failed=second.close();const outcome=await Promise.allSettled([failed]);hook.disable();assert.equal(outcome[0].status,'rejected');await retry;delete process.env.MTAI_TEST_OUTPUT_MODE;
}
async function throwingFailureObserver() {
  process.env.MTAI_TEST_OUTPUT_MODE='close-fail';let accepted;const ready=new Promise(r=>accepted=r);
  const output=createPlayback(layout(),event=>{if(event.type==='audioReady')accepted();if(event.type==='failed')throw new Error('observer');});await ready;
  const {port1,port2}=new MessageChannel();port1.on('message',()=>{});port1.ref();port2.ref();
  await output.close().then(()=>assert.fail('first close must fail'),()=>output.close());
  port1.close();port2.close();delete process.env.MTAI_TEST_OUTPUT_MODE;
}
async function microtaskFence() {
  let output;let resolve,failed;const fenced=new Promise(r=>resolve=r);const failure=new Promise(r=>failed=r);
  output=createPlayback(layout(),event=>{if(event.type==='failed')failed();if(event.type==='audioReady'){queueMicrotask(()=>{assert.throws(()=>output.submitEligible(frame(1),state(1)),/closed/);resolve();});throw new Error('fence');}});
  await fenced;await failure;await output.close();
}
async function teardown(mode) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mtai-node-wait-'));const marker=path.join(directory,'wait');
  process.env.MTAI_TEST_OUTPUT_MODE=mode;process.env.MTAI_TEST_WAIT_FILE=marker;
  const observed=new Promise((resolve,reject)=>{const watcher=fs.watch(directory,()=>{if(fs.existsSync(marker)){watcher.close();resolve();}});watcher.on('error',reject);});
  const worker = new Worker(`const {createPlayback}=require(${JSON.stringify(addonPath)});let output=createPlayback(Buffer.from(${JSON.stringify(layout().toString('hex'))},'hex'),event=>{if(event.type==='audioReady'&&${JSON.stringify(mode)}==='drain')output.end();});`,{eval:true});
  await Promise.race([observed,new Promise((_,reject)=>worker.once('error',reject))]);await worker.terminate();
  delete process.env.MTAI_TEST_OUTPUT_MODE;delete process.env.MTAI_TEST_WAIT_FILE;fs.rmSync(directory,{recursive:true});
}
(async()=>{assert.throws(()=>createPlayback(new Uint8Array(layout()),()=>{}),/Buffer/);assert.throws(()=>createPlayback(Buffer.alloc(0),()=>{}));await basic();await callbackThrow();await retry();await closeThenThrow();await closeAllocationFault();await threadStartFailure();await promiseReentry();await throwingFailureObserver();await microtaskFence();await teardown('pending');await teardown('drain');console.log('Node playback BigInt/callback/close-retry/environment cleanup passed');})().catch(error=>{console.error(error);process.exitCode=1;});
