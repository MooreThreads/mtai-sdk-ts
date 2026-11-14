const assert=require('node:assert/strict');const fs=require('node:fs');const {Worker,MessageChannel}=require('node:worker_threads');const path=require('node:path');
const addonPath=path.resolve(process.argv[2]);const addon=require(addonPath);
const target=Buffer.concat(['session','generation','attachment'].map(value=>{const b=Buffer.from(value),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);}));
const u64=value=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(value));return b;};
function wire(kind,body=Buffer.alloc(0)){const h=Buffer.alloc(16);h.write('D2LM');h.writeUInt16LE(1,4);h.writeUInt16LE(kind,6);h.writeBigUInt64LE(BigInt(target.length+body.length),8);return Buffer.concat([h,target,body]);}
function layout(){const b=Buffer.alloc(70);let at=0;const n=(v,s)=>{if(s===8)b.writeBigUInt64LE(BigInt(v),at);else b.writeUIntLE(v,at,s);at+=s;};n(7,8);n(4,4);n(4,4);n(0x34324241,4);n(16,8);n(0,8);n(0,8);n(64,8);n(1,1);n(1,1);n(16000,4);n(1,2);n(1,2);return wire(2,b.subarray(0,at));}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function connection(){
  const peer=addon.testPeer();let borrowed,lease,resolve;const ended=new Promise(r=>resolve=r);const events=[];
  const output=addon.createConnection(peer.fd,wire(1),event=>{events.push(event.type);
    if(event.type==='layout'){borrowed=event.fd;lease=output.retainAllocation();assert.notEqual(lease.fd,borrowed);assert.equal(addon.testFdContent(borrowed),'rgba');assert.equal(peer.receive(),undefined);assert.throws(()=>output.acceptLayout(7),/Node connection|bigint/);assert.throws(()=>output.acceptLayout(-1n),/u64/);assert.throws(()=>output.acceptLayout(8n),/unmatched/);assert.throws(()=>output.sendControl(wire(3,u64(7))),/acceptance/);assert.throws(()=>output.sendControl(Buffer.alloc(0)),/truncated/);const wrong=wire(10,Buffer.alloc(8));wrong[20]^=1;assert.throws(()=>output.sendControl(wrong),/target/);output.acceptLayout(7n);assert.equal(peer.receive().readUInt16LE(6),3);
      peer.send(wire(4,u64(7)));peer.send(wire(5,Buffer.concat([u64(1),Buffer.from([1,0,1])])));
      peer.send(wire(6,Buffer.concat([u64(1),u64(7),u64(9007199254740993n),u64(0),u64(0),u64(1),u64(2),Buffer.from([1,2])])));
      peer.send(wire(8,Buffer.concat([u64(1),u64(1)])));
    }
    if(event.type==='eligible'){assert.equal(event.frame.readBigUInt64LE(16+target.length+16),9007199254740993n);for(const key of ['deadlineNs','originNs','initialOriginNs','revision'])assert.equal(typeof event[key],'bigint');assert.deepEqual(event.state,wire(5,Buffer.concat([u64(1),Buffer.from([1,0,1])])));assert.deepEqual(event.frame.subarray(-2),Buffer.from([1,2]));assert.equal(peer.receive(),undefined);
      output.sendControl(wire(7,Buffer.concat([u64(1),u64(7),u64(event.deadlineNs),u64(event.originNs),u64(event.revision),u64(1)])));
      assert.equal(peer.receive().readUInt16LE(6),7);
    }
    if(event.type==='eos')resolve();
  });
  fs.closeSync(peer.fd);assert.throws(()=>output.acceptLayout(7n),/accepting/);assert.throws(()=>output.sendControl(wire(3,u64(7))),/active/);await turn();assert.equal(peer.receive().readUInt16LE(6),1);peer.send(layout());await ended;
  assert.deepEqual(events,['layout','attached','eligible','eos']);assert.equal(addon.testFdContent(borrowed),'rgba');
  const {port1,port2}=new MessageChannel();port1.on('message',()=>{});port1.ref();port2.ref();await output.close();port1.close();port2.close();
  assert.equal(addon.testFdContent(borrowed),undefined);assert.equal(addon.testFdContent(lease.fd),'rgba');lease.close();assert.equal(addon.testFdContent(lease.fd),undefined);lease.close();assert.equal(typeof addon.monotonicNs(),'bigint');await output.close();peer.close();
}
async function callbackFailure(){
 const peer=addon.testPeer();let failed;const failure=new Promise(r=>failed=r);
 const output=addon.createConnection(peer.fd,wire(1),event=>{if(event.type==='layout')throw Error('caller');if(event.type==='failed')failed();});fs.closeSync(peer.fd);await turn();peer.receive();peer.send(layout());
 // Native owner fences/joins even if application callback aborts; close joins it.
 await failure;await output.close();peer.close();
}
async function closeReentry(){
  const {createHook}=require('node:async_hooks');const peer=addon.testPeer();const output=addon.createConnection(peer.fd,wire(1),()=>{});fs.closeSync(peer.fd);peer.receive();
  let nested,inside=false;const hook=createHook({init(_id,type){if(type==='PROMISE'&&!inside){inside=true;assert.throws(()=>output.acceptLayout(7n),/accepting/);assert.throws(()=>output.sendControl(wire(10,Buffer.alloc(8))),/closed/);nested=output.close();}}});
  hook.enable();const first=output.close();hook.disable();await Promise.all([first,nested]);peer.close();
}
async function startupFailure(mode){
  if(mode!==null)process.env.MTAI_TEST_CONNECTION_FAILURE=String(mode);
  const peer=addon.testPeer();if(mode===null)peer.close();let output,resolve;const failed=new Promise(r=>resolve=r);
  output=addon.createConnection(peer.fd,wire(1),event=>{if(event.type==='failed'){assert.ok(output);resolve();}});fs.closeSync(peer.fd);
  await failed;await output.close();peer.close();delete process.env.MTAI_TEST_CONNECTION_FAILURE;
}
async function teardown(active=false){const worker=new Worker(`const{parentPort}=require('node:worker_threads');const fs=require('node:fs');const addon=require(${JSON.stringify(addonPath)});const peer=addon.testPeer();addon.createConnection(peer.fd,Buffer.from(${JSON.stringify(wire(1).toString('hex'))},'hex'),()=>{});fs.closeSync(peer.fd);const ready=()=>{if(${active}){const attach=peer.receive();if(!attach||attach.readUInt16LE(6)!==1)throw Error('missing actual ATTACH');}parentPort.postMessage('active');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};if(${active})peer.waitAttach(ready);else ready();`,{eval:true});await new Promise((r,j)=>{worker.once('message',r);worker.once('error',j);});await worker.terminate();}
async function namedConnection(){const os=require('node:os');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mtai-socket-'));const socket=path.join(directory,'output');const listener=addon.testListen(socket);let output;try{output=addon.createConnection(socket,wire(1),()=>{});const peer=addon.testAccept(listener);await output.close();fs.closeSync(peer);}finally{if(output)await output.close();fs.closeSync(listener);fs.rmSync(directory,{recursive:true});}}
(async()=>{const peer=addon.testPeer();assert.throws(()=>addon.createConnection(peer.fd,new Uint8Array(wire(1)),()=>{}),/Buffer/);fs.closeSync(peer.fd);peer.close();await namedConnection();await connection();await callbackFailure();await closeReentry();await startupFailure(0);await startupFailure(1);await startupFailure(null);await teardown();await teardown(true);console.log('Node connection FD/explicit acceptance/B eligibility/joined cleanup passed');})().catch(error=>{console.error(error);process.exitCode=1;});
