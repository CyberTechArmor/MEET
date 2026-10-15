/** Versioned private-room capability. Public MEET/NEON rooms keep their existing API. */
export const NODUS_MEET_CONTRACT = 'nodus-private-room-v1';
export const PRIVATE_ROOM_PREFIX = 'nodus_';
export const isPrivateRoom = (name: string) => /^nodus_[a-f0-9]{40}$/.test(name);
export type PrivateRoom = {roomId:string;integrationId:string;callId:string;conversationId:string;generation:string;ended:boolean;authorityVersion:number};
export type PrivateActor = {subject:string;deviceId:string;windowId:string};
export type PrivateAuthority = {allowed:true;canEnd:boolean;expiresAt:number;participantName:string};
export type AuthorizationRequest = PrivateActor & {callId:string;conversationId:string;generation:string;roomId:string;operation:'join'|'end'};
export type IntegrationBinding = {id:string;origin:string;embedOrigin?:string;authorize:(input:AuthorizationRequest)=>Promise<PrivateAuthority>};
export type PrivateGrant = PrivateActor & {hash:string;roomId:string;expiresAt:number;authorityVersion:number};
export type PrivateParticipant = PrivateActor & {roomId:string;identity:string;validUntil:number;revoked:boolean;evictionPending:boolean;revision:number;transportGeneration:number};
export type PrivateSession={hash:string;roomId:string;identity:string;expiresAt:number;authorityVersion:number;participantRevision:number};
export interface PrivateRoomStore {
 create(room:PrivateRoom):PrivateRoom;
 room(roomId:string):PrivateRoom|undefined;
 authority(roomId:string,subject:string,deviceId:string):number;
 grant(grant:PrivateGrant):void;
 consume(hash:string,roomId:string,now:number):PrivateGrant|undefined;
 replaceParticipant(row:Omit<PrivateParticipant,'revision'|'transportGeneration'>):PrivateParticipant|undefined;
 refreshParticipant(row:PrivateParticipant,validUntil:number):boolean;
 beginTransport(row:PrivateParticipant):PrivateParticipant|undefined;
 evictParticipant(row:PrivateParticipant):boolean;
 participantCurrent(roomId:string,identity:string):PrivateParticipant|undefined;
 session(value:PrivateSession):void;
 sessionCurrent(hash:string,now:number):PrivateSession|undefined;
 participants(roomId:string):PrivateParticipant[];
 revoke(roomId:string,subject?:string,deviceId?:string):void;
 evicted(row:PrivateParticipant):boolean;
 end(roomId:string):void;
 activeRooms(after:string|undefined,limit:number):PrivateRoom[];
}
export class PrivateMeetError extends Error {
 constructor(readonly status:number, readonly code:'invalid_request'|'not_authorized'|'not_configured'|'unavailable'|'expired'|'ended'){super(code);}
}
export function exactOrigin(origin:string){const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw new Error('An exact HTTPS origin is required');return origin;}
export function bounded(value:unknown,max:number):string {if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f]/.test(value))throw new PrivateMeetError(400,'invalid_request');return value;}
export function actor(input:Record<string,unknown>):PrivateActor{return {subject:bounded(input.subject,256),deviceId:bounded(input.deviceId,128),windowId:bounded(input.windowId,128)};}
