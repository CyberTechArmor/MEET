import {describe,it,expect} from 'vitest';
import {privateMeet} from './nodus-private.js';
import type {PrivateRoomStore,PrivateRoom,PrivateParticipant,PrivateGrant,PrivateSession} from './nodus-contract.js';
function fixture(){
 let clock=10000,allowed=true,canEnd=false;
 const rooms=new Map<string,PrivateRoom>(),grants=new Map<string,PrivateGrant>(),participants=new Map<string,PrivateParticipant>(),live=new Set<string>(),removed:string[]=[];
 const key=(r:string,i:string)=>r+':'+i;
 const sessions=new Map<string,PrivateSession>(),revocations=new Map<string,number>();
 const current=(p:PrivateParticipant)=>{const c=participants.get(key(p.roomId,p.identity));return c&&c.revision===p.revision&&c.transportGeneration===p.transportGeneration?c:undefined;};
 const store:PrivateRoomStore={
 authority:(r,s,d)=>(rooms.get(r)?.authorityVersion??0)+(revocations.get(r+':'+s+':*')??0)+(revocations.get(r+':'+s+':'+d)??0),
 evicted:p=>{const c=current(p);if(!c||!c.revoked)return false;c.evictionPending=false;return true;},
 session:s=>{sessions.set(s.hash,{...s});},sessionCurrent:(h,n)=>{const s=sessions.get(h);return s&&s.expiresAt>n?{...s}:undefined;},
 create:r=>{const old=rooms.get(r.roomId);if(old&&(old.generation!==r.generation||old.conversationId!==r.conversationId))throw Error('identity');if(!old)rooms.set(r.roomId,{...r});return {...rooms.get(r.roomId)!};},room:id=>{const r=rooms.get(id);return r?{...r}:undefined;},
 grant:g=>{grants.set(g.hash,g);},consume:(h,r,n)=>{const g=grants.get(h);if(!g||g.roomId!==r)return;grants.delete(h);return g.expiresAt>n?g:undefined;},
 replaceParticipant:p=>{const old=participants.get(key(p.roomId,p.identity));if(old?.evictionPending)return undefined;const next={...p,revision:(old?.revision??0)+1,transportGeneration:old?old.transportGeneration+1:0};participants.set(key(p.roomId,p.identity),next);return {...next};},
 refreshParticipant:(p,until)=>{const c=current(p);if(!c||c.revoked||c.evictionPending)return false;c.validUntil=until;return true;},
 beginTransport:p=>{const c=current(p);if(!c||c.revoked||c.evictionPending)return undefined;c.transportGeneration++;return {...c};},
 evictParticipant:p=>{const c=current(p);if(!c)return false;c.revoked=true;c.evictionPending=true;for(const[h,s]of sessions)if(s.roomId===p.roomId&&s.identity===p.identity&&s.participantRevision===p.revision)sessions.delete(h);return true;},
 participantCurrent:(r,i)=>{const p=participants.get(key(r,i));return p?{...p}:undefined;},participants:r=>[...participants.values()].filter(p=>p.roomId===r).map(p=>({...p})),
 revoke:(r,s,d)=>{if(s){const k=r+':'+s+':'+(d??'*');revocations.set(k,(revocations.get(k)??0)+1);}else rooms.get(r)!.authorityVersion++;for(const[h,g]of grants)if(g.roomId===r&&(!s||g.subject===s)&&(!d||g.deviceId===d))grants.delete(h);for(const p of participants.values())if(p.roomId===r&&(!s||p.subject===s)&&(!d||p.deviceId===d)){p.revoked=true;p.evictionPending=true;}},
 end:r=>{rooms.get(r)!.ended=true;store.revoke(r);},activeRooms:(after,limit)=>[...rooms.values()].filter(r=>!r.ended&&(!after||r.roomId>after)).sort((a,b)=>a.roomId.localeCompare(b.roomId)).slice(0,limit)};
 let authorize=async()=>{if(!allowed)throw Error('denied');return {allowed:true as const,canEnd,expiresAt:clock+20000,participantName:'Review person'};};
 let remove=async(_r:string,id:string)=>{removed.push(id);live.delete(id);};
 const service=privateMeet(store,{ensure:async()=>{},token:async(_r,id)=>'signed:'+id,remove:(_r,id)=>remove(_r,id),end:async()=>{live.clear();},participants:async()=>[...live]},id=>id==='integration'?{id,origin:'https://nodus.example',authorize:()=>authorize()}:undefined,()=>clock);
 const input={callId:'call',conversationId:'conversation',generation:'1:1',subject:'person',deviceId:'device',windowId:'window'};
 return {service,store,input,live,removed,clock:(n:number)=>{clock=n;},deny:()=>{allowed=false;},owner:()=>{canEnd=true;},authorizer:(f:typeof authorize)=>{authorize=f;},remover:(f:typeof remove)=>{remove=f;}};
}
describe('private MEET authority',()=>{
 it('creates one durable identity for concurrent retries and rejects changed conversation/generation',async()=>{const f=fixture(),[a,b]=await Promise.all([f.service.create('integration',f.input),f.service.create('integration',f.input)]);expect(a.roomId).toBe(b.roomId);await expect(f.service.create('integration',{...f.input,generation:'1:2'})).rejects.toThrow();});
 it('requires a configured integration and current authorization before a room exists',async()=>{const f=fixture();await expect(f.service.create('other',f.input)).rejects.toMatchObject({code:'not_configured'});f.deny();await expect(f.service.create('integration',f.input)).rejects.toThrow();expect(f.store.activeRooms(undefined,10)).toHaveLength(0);});
 it('issues one-use origin-bound tickets and keeps devices/windows distinct',async()=>{const f=fixture(),r=await f.service.create('integration',f.input),t=await f.service.ticket('integration',r.roomId,f.input);await expect(f.service.exchange(r.roomId,t.ticket,'https://evil.example')).rejects.toThrow();const a=await f.service.exchange(r.roomId,t.ticket,'https://nodus.example');await expect(f.service.exchange(r.roomId,t.ticket,'https://nodus.example')).rejects.toThrow();const other=await f.service.ticket('integration',r.roomId,{...f.input,windowId:'second'});const b=await f.service.exchange(r.roomId,other.ticket,'https://nodus.example');expect(a.identity).not.toBe(b.identity);});
 it('rejects expired tickets and revalidates membership at exchange',async()=>{const f=fixture(),r=await f.service.create('integration',f.input),t=await f.service.ticket('integration',r.roomId,f.input);f.clock(40000);await expect(f.service.exchange(r.roomId,t.ticket,'https://nodus.example')).rejects.toThrow();const t2=await f.service.ticket('integration',r.roomId,f.input);f.deny();await expect(f.service.exchange(r.roomId,t2.ticket,'https://nodus.example')).rejects.toThrow();});
 it('removes both tracked revoked sessions and unknown saved-token entry',async()=>{const f=fixture(),r=await f.service.create('integration',f.input),t=await f.service.ticket('integration',r.roomId,f.input),join=await f.service.exchange(r.roomId,t.ticket,'https://nodus.example');const access=await f.service.connect(join.sessionToken,'https://nodus.example');f.live.add(access.identity);f.live.add('untracked');f.deny();f.clock(31000);await f.service.auditRoom(r.roomId);expect(f.removed.sort()).toEqual([access.identity,'untracked'].sort());});
 it('does not grant end authority to the first entrant',async()=>{const f=fixture(),r=await f.service.create('integration',f.input);await expect(f.service.end('integration',r.roomId,f.input)).rejects.toMatchObject({code:'not_authorized'});expect(f.store.room(r.roomId)?.ended).toBe(false);f.owner();expect(await f.service.end('integration',r.roomId,f.input)).toEqual({ended:true});await expect(f.service.ticket('integration',r.roomId,f.input)).rejects.toMatchObject({code:'ended'});});
 it('does not let an in-flight successful callback revive a revoked participant',async()=>{const f=fixture(),r=await f.service.create('integration',f.input),t=await f.service.ticket('integration',r.roomId,f.input),join=await f.service.exchange(r.roomId,t.ticket,'https://nodus.example');const access=await f.service.connect(join.sessionToken,'https://nodus.example');let release!:()=>void;f.authorizer(()=>new Promise(resolve=>{release=()=>resolve({allowed:true,canEnd:false,expiresAt:30000,participantName:'person'});}));const check=f.service.revalidate(r.roomId,access.participantId,access.participantRevision,access.transportGeneration);await Promise.resolve();f.store.revoke(r.roomId,'person');release();await expect(check).rejects.toThrow();expect(f.store.participantCurrent(r.roomId,join.identity)?.revoked).toBe(true);});
 it('revoking one person preserves another current participant and that participant’s reconnect handle',async()=>{const f=fixture(),r=await f.service.create('integration',f.input),other={...f.input,subject:'other',deviceId:'second'},ticket=await f.service.ticket('integration',r.roomId,other),joined=await f.service.exchange(r.roomId,ticket.ticket,'https://nodus.example');await f.service.revoke('integration',r.roomId,'person');expect(await f.service.connect(joined.sessionToken,'https://nodus.example')).toMatchObject({participantId:joined.identity});});
 it('refuses a ticket whose authorization was superseded before the callback returned',async()=>{const f=fixture(),r=await f.service.create('integration',f.input);let release!:()=>void;f.authorizer(()=>new Promise(resolve=>{release=()=>resolve({allowed:true,canEnd:false,expiresAt:30000,participantName:'person'});}));const ticket=f.service.ticket('integration',r.roomId,f.input);await Promise.resolve();f.store.revoke(r.roomId,'person');release();await expect(ticket).rejects.toThrow();});
 it('can retire a start that never reached MEET and can retry an uncertain successful end',async()=>{const f=fixture();expect(await f.service.retire('integration','not-created')).toEqual({ended:true});const r=await f.service.create('integration',f.input);f.owner();expect(await f.service.end('integration',r.roomId,f.input)).toEqual({ended:true});expect(await f.service.end('integration',r.roomId,f.input)).toEqual({ended:true});});
});

async function joined(f:ReturnType<typeof fixture>,roomId:string,windowId='window') {const t=await f.service.ticket('integration',roomId,{...f.input,windowId});const s=await f.service.exchange(roomId,t.ticket,'https://nodus.example');return {...s,access:await f.service.connect(s.sessionToken,'https://nodus.example')};}
const healthy=async()=>({allowed:true as const,canEnd:false,expiresAt:30000,participantName:'person'});
describe('window and transport ownership',()=>{
 it('closing window A preserves window B on the same person/device and its opaque reconnect handle',async()=>{
  const f=fixture(),r=await f.service.create('integration',f.input),a=await joined(f,r.roomId,'A'),b=await joined(f,r.roomId,'B');
  await f.service.disconnect(r.roomId,a.identity,a.access.participantRevision,a.access.transportGeneration);
  expect(f.store.participantCurrent(r.roomId,a.identity)?.revoked).toBe(true);expect(f.store.participantCurrent(r.roomId,b.identity)?.revoked).toBe(false);
  expect(await f.service.connect(b.sessionToken,'https://nodus.example')).toMatchObject({participantId:b.identity});expect(f.removed).toEqual([a.access.identity]);
  await f.service.revoke('integration',r.roomId,'person','device');await expect(f.service.connect(b.sessionToken,'https://nodus.example')).rejects.toThrow();expect(f.store.participantCurrent(r.roomId,b.identity)?.revoked).toBe(true);
 });
 it('a late denied callback only evicts its old physical transport, never the replacement',async()=>{
  const f=fixture(),r=await f.service.create('integration',f.input),a=await joined(f,r.roomId);let reject!:(e:Error)=>void;f.authorizer(()=>new Promise((_resolve,no)=>{reject=no;}));
  const check=f.service.revalidate(r.roomId,a.identity,a.access.participantRevision,a.access.transportGeneration);const rejected=expect(check).rejects.toThrow();await Promise.resolve();f.authorizer(healthy);
  const newer=await f.service.connect(a.sessionToken,'https://nodus.example');reject(Error('old denied'));await rejected;
  expect(newer.identity).not.toBe(a.access.identity);expect(f.removed).toEqual([a.access.identity]);expect(f.store.participantCurrent(r.roomId,a.identity)).toMatchObject({revoked:false,transportGeneration:newer.transportGeneration});
  expect(await f.service.connect(a.sessionToken,'https://nodus.example')).toMatchObject({participantId:a.identity});
 });
 it('a late successful callback cannot overwrite a fresh grant revision',async()=>{
  const f=fixture(),r=await f.service.create('integration',f.input),a=await joined(f,r.roomId);let release!:(v:Awaited<ReturnType<typeof healthy>>)=>void;f.authorizer(()=>new Promise(resolve=>{release=resolve;}));const check=f.service.revalidate(r.roomId,a.identity,a.access.participantRevision,a.access.transportGeneration);const rejected=expect(check).rejects.toThrow();await Promise.resolve();f.authorizer(healthy);
  const newer=await joined(f,r.roomId);release({...await healthy(),expiresAt:15000});await rejected;
  expect(f.store.participantCurrent(r.roomId,a.identity)).toMatchObject({revoked:false,revision:newer.access.participantRevision,validUntil:30000});await expect(f.service.connect(a.sessionToken,'https://nodus.example')).rejects.toThrow();
 });
 it('a delayed old removal and cleanup cannot revoke a replacement transport',async()=>{
  const f=fixture(),r=await f.service.create('integration',f.input),a=await joined(f,r.roomId),newer=await f.service.connect(a.sessionToken,'https://nodus.example');let done!:()=>void;f.remover(async(_room,id)=>{f.removed.push(id);await new Promise<void>(resolve=>{done=resolve;});});
  const cleanup=f.service.disconnect(r.roomId,a.identity,a.access.participantRevision,a.access.transportGeneration);await Promise.resolve();expect(f.removed).toEqual([a.access.identity]);expect(f.store.participantCurrent(r.roomId,a.identity)?.revoked).toBe(false);done();await cleanup;
  expect(f.store.participantCurrent(r.roomId,a.identity)).toMatchObject({revoked:false,transportGeneration:newer.transportGeneration});
 });
});
