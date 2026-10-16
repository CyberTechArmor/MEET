import {createHash,randomBytes} from 'node:crypto';
import {actor,bounded,exactOrigin,PRIVATE_ROOM_PREFIX,PrivateMeetError,type IntegrationBinding,type PrivateActor,type PrivateAuthority,type PrivateParticipant,type PrivateRoom,type PrivateRoomStore} from './nodus-contract.js';

export interface PrivateMedia {
 ensure(roomId:string):Promise<void>;
 token(roomId:string,identity:string,name:string,ttlSeconds:number):Promise<string>;
 remove(roomId:string,identity:string):Promise<void>;
 end(roomId:string):Promise<void>;
 participants(roomId:string):Promise<string[]>;
 iceServers?():Array<{urls:string[];username?:string;credential?:string}>|undefined;
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:'not_authorized'|'expired'|'ended'|'not_configured'='not_authorized')=>new PrivateMeetError(code==='not_configured'?503:403,code);
/** Never reuse a LiveKit identity: a late removal must only affect its original transport. */
export const transportIdentity=(p:Pick<PrivateParticipant,'identity'|'transportGeneration'>)=>`${p.identity}_g${p.transportGeneration}`;
class SupersededTransport extends Error {}
/** Existing MEET room/media implementation is injected; this module owns private authority only. */
export function privateMeet(store:PrivateRoomStore,media:PrivateMedia,bindingFor:(id:string)=>IntegrationBinding|undefined,now=Date.now){
 function binding(id:string){const value=bindingFor(id);if(!value)throw fail('not_configured');exactOrigin(value.origin);return value;}
 function active(id:string,integrationId?:string){bounded(id,512);const room=store.room(id);if(!room||integrationId&&room.integrationId!==integrationId)throw fail();if(room.ended)throw fail('ended');return room;}
 async function authorize(room:PrivateRoom,who:PrivateActor,operation:'join'|'end',allowEnded=false):Promise<PrivateAuthority&{authorityVersion:number}>{
  const authorityVersion=store.authority(room.roomId,who.subject,who.deviceId);
  const approved=await binding(room.integrationId).authorize({...who,roomId:room.roomId,callId:room.callId,conversationId:room.conversationId,generation:room.generation,operation});
  if(approved?.allowed!==true||!Number.isFinite(approved.expiresAt)||approved.expiresAt<=now()||approved.expiresAt>now()+30000||typeof approved.participantName!=='string'||approved.participantName.length>200||operation==='end'&&!approved.canEnd)throw fail();
  const latest=allowEnded?store.room(room.roomId):active(room.roomId,room.integrationId);
  if(!latest||latest.integrationId!==room.integrationId||store.authority(room.roomId,who.subject,who.deviceId)!==authorityVersion)throw fail();return {...approved,authorityVersion};
 }
 async function validate(room:PrivateRoom,p:PrivateParticipant){
  if(p.revoked)throw fail();const approved=await authorize(room,p,'join');
  // This CAS spans the awaited callback: neither a new grant nor a replacement socket may
  // be overwritten or revoked by the old transport's late positive/negative response.
  if(!store.refreshParticipant(p,approved.expiresAt))throw new SupersededTransport();return approved;
 }
 async function evict(room:PrivateRoom,p:PrivateParticipant){const marked=store.evictParticipant(p);await media.remove(room.roomId,transportIdentity(p));if(marked)store.evicted(p);}
 return {
  async create(integrationId:string,input:Record<string,unknown>){
   binding(integrationId);const callId=bounded(input.callId,64),conversationId=bounded(input.conversationId,64),generation=bounded(input.generation,256),who=actor(input);
   const roomId=PRIVATE_ROOM_PREFIX+hash(`${integrationId}\0${callId}`).slice(0,40);
   const proposed:PrivateRoom={roomId,integrationId,callId,conversationId,generation,ended:false,authorityVersion:0};
   // Authorize before persisting a new room; room construction has no public side effect.
   const approved=await binding(integrationId).authorize({...who,...proposed,operation:'join'});
   if(approved?.allowed!==true||approved.expiresAt<=now()||approved.expiresAt>now()+30000)throw fail();
   const room=store.create(proposed);if(room.ended)throw fail('ended');
   await media.ensure(roomId);active(roomId,integrationId);return {...room,private:true};
  },
  async ticket(integrationId:string,roomId:string,input:Record<string,unknown>){
   const room=active(roomId,integrationId),who=actor(input);if(input.generation!==room.generation)throw fail();
   const approved=await authorize(room,who,'join'),ticket=randomBytes(32).toString('base64url');
   const expiresAt=Math.min(now()+30000,approved.expiresAt);store.grant({...who,hash:hash(ticket),roomId,expiresAt,authorityVersion:approved.authorityVersion});
   return {ticket,roomId,generation:room.generation,expiresAt:new Date(expiresAt).toISOString()};
  },
  async exchange(roomId:string,ticket:string,origin:string){
   const room=active(roomId),connection=binding(room.integrationId);if(origin!==connection.origin)throw fail();
   const grant=store.consume(hash(bounded(ticket,128)),roomId,now());if(!grant||grant.authorityVersion!==store.authority(roomId,grant.subject,grant.deviceId))throw fail('expired');
   const approved=await authorize(room,grant,'join'),identity='np_'+hash(`${roomId}\0${grant.subject}\0${grant.deviceId}\0${grant.windowId}`).slice(0,40);
   active(roomId);if(store.authority(roomId,grant.subject,grant.deviceId)!==approved.authorityVersion)throw fail();
   if(store.participantCurrent(roomId,identity)?.evictionPending)throw new PrivateMeetError(503,'unavailable');
   const participant=store.replaceParticipant({...grant,identity,validUntil:approved.expiresAt,revoked:false,evictionPending:false});if(!participant)throw new PrivateMeetError(503,'unavailable');
   const sessionToken=randomBytes(32).toString('base64url'),iceServers=media.iceServers?.();
   store.session({hash:hash(sessionToken),roomId,identity,expiresAt:approved.expiresAt,authorityVersion:approved.authorityVersion,participantRevision:participant.revision});
   return {sessionToken,identity,roomId,generation:room.generation,expiresAt:new Date(approved.expiresAt).toISOString(),signalingPath:'/api/private/livekit',...(iceServers?{iceServers}: {})};
  },
  /** Internal to the signaling proxy. Never serialize this return value to a browser. */
  async connect(sessionToken:string,origin:string){
   const session=store.sessionCurrent(hash(bounded(sessionToken,128)),now());if(!session)throw fail('expired');
   const room=active(session.roomId),connection=binding(room.integrationId);if(![connection.origin,connection.embedOrigin].includes(origin))throw fail();
   const participant=store.participantCurrent(room.roomId,session.identity);if(!participant||participant.revision!==session.participantRevision||store.authority(room.roomId,participant.subject,participant.deviceId)!==session.authorityVersion)throw fail();
   const approved=await validate(room,participant);
   const transport=store.beginTransport(participant);if(!transport)throw new SupersededTransport();
   const identity=transportIdentity(transport),token=await media.token(room.roomId,identity,approved.participantName,30);
   active(room.roomId);if(store.authority(room.roomId,participant.subject,participant.deviceId)!==session.authorityVersion)throw fail();
   const current=store.participantCurrent(room.roomId,session.identity);if(!current||current.revoked||current.evictionPending||current.revision!==transport.revision||current.transportGeneration!==transport.transportGeneration)throw new SupersededTransport();
   return {roomId:room.roomId,participantId:session.identity,participantRevision:transport.revision,transportGeneration:transport.transportGeneration,identity,token};
  },
  async revalidate(roomId:string,identity:string,revision:number,transportGeneration:number){const room=store.room(roomId),p=store.participantCurrent(roomId,identity);if(!room||!p)throw fail();if(p.revision!==revision||p.transportGeneration!==transportGeneration)throw new SupersededTransport();try{if(room.ended)throw fail('ended');return await validate(room,p);}catch(error){await evict(room,p);throw error;}},
  async disconnect(roomId:string,identity:string,revision:number,transportGeneration:number){const room=store.room(roomId),current=store.participantCurrent(roomId,identity);if(room&&current)await evict(room,{...current,revision,transportGeneration});},
  async revoke(integrationId:string,roomId:string,subject:string,deviceId?:string){
   active(roomId,integrationId);store.revoke(roomId,bounded(subject,256),deviceId===undefined?undefined:bounded(deviceId,128));
   const targets=store.participants(roomId).filter(p=>p.subject===subject&&(!deviceId||p.deviceId===deviceId));
   const results=await Promise.allSettled(targets.map(async p=>{await media.remove(roomId,transportIdentity(p));store.evicted(p);}));
   if(results.some(r=>r.status==='rejected'))throw new PrivateMeetError(503,'unavailable');return {revoked:true};
  },
  async end(integrationId:string,roomId:string,input:Record<string,unknown>){
   const room=store.room(roomId);if(!room||room.integrationId!==integrationId)throw fail();await authorize(room,actor(input),'end',true);
   if(!room.ended)store.end(roomId);await media.end(roomId);return {ended:true};
  },
  async retire(integrationId:string,roomId:string){
   binding(integrationId);bounded(roomId,512);const room=store.room(roomId);if(!room)return {ended:true};if(room.integrationId!==integrationId)throw fail();
   store.end(roomId);await media.end(roomId);return {ended:true};
  },
  async auditRoom(roomId:string){
   const room=store.room(roomId);if(!room)return;
   const identities=await media.participants(roomId);if(identities.length>500){store.end(roomId);await media.end(roomId);return;}
   // Every actual participant is checked, including saved-token entry absent from our tracked set.
   const tracked=new Map(store.participants(roomId).map(p=>[transportIdentity(p),p]));
   for(let at=0;at<identities.length;at+=8)await Promise.all(identities.slice(at,at+8).map(async identity=>{const p=tracked.get(identity);try{if(room.ended||!p)throw fail();if(p.revoked||p.validUntil<=now())await validate(room,p);}catch{if(p)await evict(room,p);else await media.remove(roomId,identity);}}));
   for(const p of store.participants(roomId).filter(p=>p.evictionPending&&!identities.includes(transportIdentity(p)))){await media.remove(roomId,transportIdentity(p));store.evicted(p);}
  },
  async audit(after?:string){const rooms=store.activeRooms(after,25);for(const room of rooms)await this.auditRoom(room.roomId);return rooms.length===25?rooms.at(-1)!.roomId:undefined;},
 };
}
