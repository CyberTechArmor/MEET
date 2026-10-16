const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');

async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function rawUpgrade(port,target){await new Promise((resolve,reject)=>{const socket=net.connect(port,'127.0.0.1');socket.setTimeout(2000,()=>socket.destroy(new Error('Upgrade socket did not close')));socket.once('error',error=>error.code==='ECONNRESET'?resolve():reject(error));socket.once('close',resolve);socket.once('connect',()=>socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));socket.on('data',()=>{});});}

test('malformed public upgrade targets close their sockets and leave the API healthy',{timeout:15000},async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'meet-upgrade-test-')),port=await freePort();
 // Only operating-system runtime paths are inherited. All MEET state and keys
 // belong to this fixture; no production config, credentials or DB are read.
 const env={PATH:process.env.PATH||'',SystemRoot:process.env.SystemRoot||'',TEMP:os.tmpdir(),TMP:os.tmpdir(),NODE_ENV:'test',PORT:String(port),MEET_DATA_DIR:dir,LIVEKIT_URL:'http://127.0.0.1:1',LIVEKIT_API_KEY:'synthetic-upgrade-test',LIVEKIT_API_SECRET:'synthetic-upgrade-test-only'};
 const child=spawn(process.execPath,['dist/index.js'],{cwd:path.resolve(__dirname,'..'),env,stdio:'ignore'}),base=`http://127.0.0.1:${port}`;
 try{
  let ready=false;for(let attempt=0;attempt<100;attempt++){assert.equal(child.exitCode,null,'isolated API must stay running');try{if((await fetch(base+'/health',{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert(ready,'isolated API started');
  for(const target of ['http://[','http://[::1','http://%']){await rawUpgrade(port,target);assert.equal(child.exitCode,null,'malformed request must not terminate API');assert.equal((await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).status,200);}
 }finally{
  if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await exited;clearTimeout(timer);}
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));rmSync(dir,{recursive:true,force:true});
 }
});

test('private signaling rejects malformed URL before authorization or media work',async()=>{
 const {privateSignaling}=require('../dist/nodus-signaling.js');let destroyed=0,calls=0;
 const signals=privateSignaling({connect:async()=>{calls++;throw Error('must not authorize malformed URL');}},'http://127.0.0.1:1');
 try{for(const url of ['http://[','http://[::1','http://%'])await signals.upgrade({url,headers:{}},{destroy(){destroyed++;}},Buffer.alloc(0));assert.equal(destroyed,3);assert.equal(calls,0);}finally{signals.stop();}
});
