import {createServer} from 'node:http';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {describe,it,expect} from 'vitest';
import {privateSignaling} from './nodus-signaling.js';
import type {privateMeet} from './nodus-private.js';
describe('actual private signaling proxy transport',()=>{
 it('keeps the upstream credential out of browser frames and checks active authority after connect',async()=>{
  const upstreamHttp=createServer(),upstreamWs=new WebSocketServer({server:upstreamHttp});upstreamHttp.listen(0,'127.0.0.1');await once(upstreamHttp,'listening');const upPort=(upstreamHttp.address() as {port:number}).port;
  let allowed=true,connected=0;const engine={disconnect:async()=>{},connect:async(handle:string,origin:string)=>{expect(handle).toBe('h'.repeat(43));expect(origin).toBe('https://nodus.example');if(!allowed)throw Error('denied');connected++;return {roomId:'room',participantId:'person',participantRevision:1,transportGeneration:1,identity:'person_g1',token:'server-only-fixture-token'};},revalidate:async()=>{if(!allowed)throw Error('revoked');return {};}} as unknown as ReturnType<typeof privateMeet>;
  const proxy=privateSignaling(engine,`http://127.0.0.1:${upPort}`),front=createServer();front.on('upgrade',(req,socket,head)=>{expect(req.url).not.toContain('access_token');void proxy.upgrade(req,socket,head);});front.listen(0,'127.0.0.1');await once(front,'listening');const port=(front.address() as {port:number}).port;
  upstreamWs.on('connection',(ws,req)=>{expect(new URL(req.url!,'http://upstream').searchParams.get('access_token')).toBe('server-only-fixture-token');ws.send(Buffer.concat([Buffer.from([130,1,25]),Buffer.from('server-only-fixture-token')]));ws.send(Buffer.from([26,3,115,100,112]));});
  const client=new WebSocket(`ws://127.0.0.1:${port}/api/private/livekit/rtc?protocol=15`,['nodus-private-v1','session.'+'h'.repeat(43)],{origin:'https://nodus.example'});
  try{const [data,isBinary]=await once(client,'message');expect(isBinary).toBe(true);expect(Buffer.from(data).toString()).not.toContain('fixture-token');expect(Buffer.from(data)).toEqual(Buffer.from([26,3,115,100,112]));expect(client.protocol).toBe('nodus-private-v1');allowed=false;await once(client,'close');expect(connected).toBe(1);}finally{client.terminate();proxy.stop();for(const c of upstreamWs.clients)c.terminate();await new Promise<void>(resolve=>upstreamWs.close(()=>resolve()));await Promise.all([new Promise<void>(resolve=>front.close(()=>resolve())),new Promise<void>(resolve=>upstreamHttp.close(()=>resolve()))]);}
 });
 it('rejects credentials carried in a URL before invoking the current-authority adapter',async()=>{
  let called=false;const engine={connect:async()=>{called=true;throw Error('should not run');}} as unknown as ReturnType<typeof privateMeet>,proxy=privateSignaling(engine,'http://127.0.0.1:1'),server=createServer();server.on('upgrade',(req,socket,head)=>{void proxy.upgrade(req,socket,head);});server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
  const client=new WebSocket(`ws://127.0.0.1:${port}/api/private/livekit?access_token=secret`,['nodus-private-v1','session.'+'h'.repeat(43)],{origin:'https://nodus.example'});client.on('error',()=>{});try{await new Promise<void>(resolve=>client.once('close',()=>resolve()));expect(called).toBe(false);}finally{client.terminate();proxy.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
});


describe('replacement signaling transport',()=>{
 it('keeps the replacement open when an old in-flight revalidation later fails',async()=>{
  const upstreamHttp=createServer(),upstreamWs=new WebSocketServer({server:upstreamHttp});upstreamHttp.listen(0,'127.0.0.1');await once(upstreamHttp,'listening');const upPort=(upstreamHttp.address() as {port:number}).port;
  let generation=0,rejectOld!:(e:Error)=>void,markChecked!:()=>void;const oldChecked=new Promise<void>(resolve=>{markChecked=resolve;}),disconnected:number[]=[];
  const engine={connect:async()=>{generation++;return {roomId:'room',participantId:'window',participantRevision:1,transportGeneration:generation,identity:'window_g'+generation,token:'fixture'};},disconnect:async(_r:string,_i:string,_revision:number,g:number)=>{disconnected.push(g);},revalidate:async(_r:string,_i:string,_revision:number,g:number)=>{if(g===1)return new Promise((_ok,no)=>{rejectOld=no;markChecked();});return {};}} as unknown as ReturnType<typeof privateMeet>;
  const proxy=privateSignaling(engine,'http://127.0.0.1:'+upPort),front=createServer();front.on('upgrade',(req,socket,head)=>{void proxy.upgrade(req,socket,head);});front.listen(0,'127.0.0.1');await once(front,'listening');const port=(front.address() as {port:number}).port;
  const client=()=>new WebSocket('ws://127.0.0.1:'+port+'/api/private/livekit',['nodus-private-v1','session.'+'h'.repeat(43)],{origin:'https://nodus.example'});const first=client();let second:WebSocket|undefined;
  try{await once(first,'open');await oldChecked;second=client();await once(second,'open');rejectOld(Error('old authority failed'));await new Promise(resolve=>setTimeout(resolve,30));expect(second.readyState).toBe(WebSocket.OPEN);expect(disconnected).toEqual([1]);}
  finally{first.terminate();second?.terminate();proxy.stop();for(const c of upstreamWs.clients)c.terminate();await new Promise<void>(resolve=>upstreamWs.close(()=>resolve()));await Promise.all([new Promise<void>(resolve=>front.close(()=>resolve())),new Promise<void>(resolve=>upstreamHttp.close(()=>resolve()))]);}
 },5000);
});
