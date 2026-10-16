import type {Express} from 'express';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import {privateMeet,type PrivateMedia} from './nodus-private.js';
import {privateRoomStore,type PrivateDatabase} from './nodus-private-store.js';
import {callbackBinding} from './nodus-callback.js';
import {nodusRoutes,privateWatchdog,rejectPrivateLegacy} from './nodus-routes.js';
import {privateSignaling} from './nodus-signaling.js';
import {exactOrigin} from './nodus-contract.js';
import type {RequestHandler} from 'express';

/** Existing credential ID only. Its value remains inside the existing MEET server store. */
/** `connection` is read on every use, so an administrator's change applies at once without a restart. */
export function installNodusPrivate(input:{app:Express;db:PrivateDatabase;authenticate:RequestHandler;media:PrivateMedia;livekitUrl:string;connection:()=>{keyId:string;nodusOrigin:string};embedOrigin:string;key:(id:string)=>{key:string;permissions:string[]}|undefined;report:()=>void}){
 const store=privateRoomStore(input.db);
 const selected=()=>{const {keyId,nodusOrigin}=input.connection();if(!keyId||!nodusOrigin)return undefined;try{exactOrigin(nodusOrigin);exactOrigin(input.embedOrigin);}catch{return undefined;}const key=input.key(keyId);return key?.permissions.some(p=>p==='write'||p==='admin')?{keyId,nodusOrigin,key}:undefined;};
 const service=privateMeet(store,input.media,id=>{const current=selected();return current&&id===current.keyId?callbackBinding({id,origin:current.nodusOrigin,embedOrigin:input.embedOrigin,credential:current.key.key}):undefined;});
 input.app.use('/api/integrations/nodus',nodusRoutes(service,input.authenticate,()=>!!selected(),()=>{const current=selected();return current?{keyId:current.keyId,nodusOrigin:current.nodusOrigin,embedOrigin:input.embedOrigin}:undefined;}));
 // These guards remain active even without a configured connection: a reserved private name
 // must never become public because a connection was disabled or a process restarted.
 input.app.post('/api/token',rejectPrivateLegacy);
 input.app.post('/api/rooms',rejectPrivateLegacy);
 input.app.put('/api/rooms/:roomName',rejectPrivateLegacy);
 input.app.post('/api/end-meeting',rejectPrivateLegacy);
 const signals=privateSignaling(service,input.livekitUrl),watchdog=privateWatchdog(service,store,input.report);
 return {configured:()=>!!selected(),upgrade:(req:IncomingMessage,socket:Duplex,head:Buffer)=>signals.upgrade(req,socket,head),stop(){watchdog.stop();signals.stop();}};
}
