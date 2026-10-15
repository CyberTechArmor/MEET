import {WebSocket,WebSocketServer,type RawData} from 'ws';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import type {privateMeet} from './nodus-private.js';
import {filterPrivateSignal} from './nodus-signal.js';

type Engine=ReturnType<typeof privateMeet>;
const bytes=(value:RawData)=>Buffer.isBuffer(value)?value:Array.isArray(value)?Buffer.concat(value):Buffer.from(value);
/** Private signaling uses an opaque subprotocol credential, never a JWT or credential in a URL. */
export function privateSignaling(engine:Engine,configuredLivekitUrl:string){
 const origin=new URL(configuredLivekitUrl);if(!['http:','https:','ws:','wss:'].includes(origin.protocol)||origin.username||origin.password)throw Error('Invalid LiveKit upstream');
 const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,handleProtocols:protocols=>protocols.has('nodus-private-v1')?'nodus-private-v1':false});
 const sockets=new Map<string,{client:WebSocket;upstream:WebSocket;stop:()=>void}>();let pending=0,stopped=false;
 async function upgrade(req:IncomingMessage,socket:Duplex,head:Buffer){
  let requested:URL;
  try{requested=new URL(req.url??'/', 'http://private.invalid');}catch{socket.destroy();return;}
  if(stopped||pending>=64||!['/api/private/livekit','/api/private/livekit/rtc'].includes(requested.pathname)){socket.destroy();return;}
  const protocols=String(req.headers['sec-websocket-protocol']??'').split(',').map(s=>s.trim()),handles=protocols.filter(s=>/^session\.[A-Za-z0-9_-]{43}$/.test(s));
  if(handles.length!==1||!protocols.includes('nodus-private-v1')||requested.searchParams.has('access_token')){socket.destroy();return;}
  pending++;
  try{
   const access=await engine.connect(handles[0].slice(8),String(req.headers.origin??''));if(socket.destroyed)return;
   const url=new URL('/rtc',origin);url.protocol=['https:','wss:'].includes(origin.protocol)?'wss:':'ws:';
   for(const key of ['protocol','sdk','version','auto_subscribe','adaptive_stream','reconnect','sid']){const value=requested.searchParams.get(key);if(value!==null&&value.length<=128)url.searchParams.set(key,value);}
   url.searchParams.set('access_token',access.token);
   wss.handleUpgrade(req,socket,head,client=>{
    const key=access.roomId+':'+access.participantId,previous=sockets.get(key);
    const upstream=new WebSocket(url,{handshakeTimeout:5000,maxPayload:1024*1024});
    let closed=false,checking=false;const queued:Buffer[]=[];let queuedBytes=0;
    const cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);if(sockets.get(key)?.client===client)sockets.delete(key);void engine.disconnect(access.roomId,access.participantId,access.participantRevision,access.transportGeneration).catch(()=>{});client.terminate();upstream.terminate();};
    const timer=setInterval(()=>{if(checking||closed)return;checking=true;void engine.revalidate(access.roomId,access.participantId,access.participantRevision,access.transportGeneration).catch(cleanup).finally(()=>{checking=false;});},1000);timer.unref();
    sockets.set(key,{client,upstream,stop:cleanup});previous?.stop();
    client.on('error',cleanup);client.on('close',cleanup);upstream.on('error',cleanup);upstream.on('close',cleanup);
    client.on('message',(data,isBinary)=>{try{if(!isBinary)throw Error('Binary signaling required');const frame=filterPrivateSignal(bytes(data),'client');if(!frame)return;if(upstream.readyState===WebSocket.CONNECTING){queuedBytes+=frame.length;if(queuedBytes>1024*1024)throw Error('Signal queue full');queued.push(frame);}else if(upstream.readyState===WebSocket.OPEN&&upstream.bufferedAmount<1024*1024)upstream.send(frame,{binary:true});else throw Error('Signal unavailable');}catch{cleanup();}});
    upstream.on('open',()=>{for(const frame of queued)upstream.send(frame,{binary:true});queued.length=0;queuedBytes=0;});
    upstream.on('message',(data,isBinary)=>{try{if(!isBinary)throw Error('Binary signaling required');const frame=filterPrivateSignal(bytes(data),'server');if(frame){if(client.readyState!==WebSocket.OPEN||client.bufferedAmount>=1024*1024)throw Error('Signal queue full');client.send(frame,{binary:true});}}catch{cleanup();}});
   });
  }catch{socket.destroy();}finally{pending--;}
 }
 return {upgrade,stop(){stopped=true;for(const c of sockets.values())c.stop();wss.close();}};
}
