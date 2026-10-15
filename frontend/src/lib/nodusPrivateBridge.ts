export const PRIVATE_BRIDGE='nodus-private-room-v1';
export interface FrameBinding {origin:string;callId:string;roomId:string;generation:string;channel:string;}
export interface PrivateFrameSession {sessionToken:string;expiresAt:string;canEnd:boolean;iceServers?:RTCIceServer[];}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function validIce(value:unknown):boolean {
  return value===undefined||Array.isArray(value)&&value.length<=8&&value.every(s=>object(s)&&Object.keys(s).every(k=>['urls','username','credential'].includes(k))&&Array.isArray(s.urls)&&s.urls.length>0&&s.urls.length<=8&&s.urls.every(u=>typeof u==='string'&&u.length<=512&&/^(?:stun|stuns|turn|turns):[^\s@/]+(?:\?transport=(?:udp|tcp))?$/.test(u))&&(s.username===undefined||typeof s.username==='string'&&s.username.length<=512)&&(s.credential===undefined||typeof s.credential==='string'&&s.credential.length<=512));
}
export function frameBinding(url:URL):FrameBinding {
  const p=url.searchParams,origin=p.get('parentOrigin'),callId=p.get('callId'),roomId=p.get('roomId'),generation=p.get('generation'),channel=p.get('channel');
  if(p.get('private')!=='nodus'||!origin||new URL(origin).origin!==origin||new URL(origin).protocol!=='https:'||!uuid(callId)||!uuid(channel)||!roomId||!/^nodus_[a-f0-9]{40}$/.test(roomId)||!generation||generation.length>256)throw Error('This private call link is incomplete.');
  for(const name of ['parentOrigin','callId','roomId','generation','channel','private'])if(p.getAll(name).length!==1)throw Error('This private call link is ambiguous.');
  if([...p.keys()].some(k=>!['parentOrigin','callId','roomId','generation','channel','private'].includes(k)))throw Error('Unexpected private call link data.');
  return {origin,callId:callId!,roomId,generation,channel:channel!};
}
export function validFrameMessage(value:unknown,binding:FrameBinding):value is Record<string,unknown> {
  return object(value)&&value.source==='nodus'&&value.contract===PRIVATE_BRIDGE&&value.callId===binding.callId&&value.roomId===binding.roomId&&value.generation===binding.generation&&value.channel===binding.channel&&typeof value.type==='string'&&uuid(value.requestId);
}

/** Exact peer/source/origin and per-request ownership; no wildcard or durable secret storage. */
export function privateFrameBridge(binding:FrameBinding,peer:Window,host:Window=window) {
  const pending=new Map<string,{resolve:(s:PrivateFrameSession)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();let stopped=false;
  const base={contract:PRIVATE_BRIDGE,callId:binding.callId,roomId:binding.roomId,generation:binding.generation,channel:binding.channel};
  const emit=(type:string,payload:Record<string,unknown>={})=>{if(!stopped)peer.postMessage({...base,source:'meet',type,...payload},binding.origin);};
  const listener=(event:MessageEvent)=>{
    if(stopped||event.source!==peer||event.origin!==binding.origin||!validFrameMessage(event.data,binding))return;
    const data=event.data,requestId=data.requestId as string,item=pending.get(requestId);
    if(!item||!['session','denied'].includes(data.type as string))return;
    pending.delete(requestId);clearTimeout(item.timer);
    if(data.type==='denied'){item.reject(Error('Call access is unavailable.'));return;}
    const s=data.session;if(!object(s)||Object.keys(s).some(k=>!['sessionToken','expiresAt','canEnd','iceServers'].includes(k))||typeof s.sessionToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(s.sessionToken)||typeof s.expiresAt!=='string'||Date.parse(s.expiresAt)<=Date.now()||Date.parse(s.expiresAt)>Date.now()+30000||!Number.isFinite(Date.parse(s.expiresAt))||typeof s.canEnd!=='boolean'||!validIce(s.iceServers)){item.reject(Error('Invalid private call authorization.'));return;}
    item.resolve(s as unknown as PrivateFrameSession);
  };
  host.addEventListener('message',listener);
  return {
    emit,
    requestSession():Promise<PrivateFrameSession>{
      if(stopped)return Promise.reject(Error('Private call frame closed.'));
      if(pending.size)return Promise.reject(Error('Private call authorization is already pending.'));
      const requestId=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Call authorization timed out.'));},6000);pending.set(requestId,{resolve,reject,timer});emit('need-session',{requestId});});
    },
    close(){stopped=true;host.removeEventListener('message',listener);for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Private call frame closed.'));}pending.clear();},
  };
}
