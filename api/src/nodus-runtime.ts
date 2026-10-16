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
export function installNodusPrivate(input:{app:Express;db:PrivateDatabase;authenticate:RequestHandler;media:PrivateMedia;livekitUrl:string;keyId:string;nodusOrigin:string;embedOrigin:string;key:(id:string)=>{key:string;permissions:string[]}|undefined;report:()=>void}){
 const store=privateRoomStore(input.db);
 const selected=()=>{if(!input.keyId||!input.nodusOrigin)return undefined;try{exactOrigin(input.nodusOrigin);exactOrigin(input.embedOrigin);}catch{return undefined;}const key=input.key(input.keyId);return key?.permissions.some(p=>p==='write'||p==='admin')?key:undefined;};
 const service=privateMeet(store,input.media,id=>{const key=selected();return key&&id===input.keyId?callbackBinding({id,origin:input.nodusOrigin,embedOrigin:input.embedOrigin,credential:key.key}):undefined;});
 input.app.use('/api/integrations/nodus',nodusRoutes(service,input.authenticate,()=>!!selected(),()=>selected()?{keyId:input.keyId,nodusOrigin:input.nodusOrigin}:undefined));
 // These guards remain active even without a configured connection: a reserved private name
 // must never become public because a connection was disabled or a process restarted.
 input.app.post('/api/token',rejectPrivateLegacy);
 input.app.post('/api/rooms',rejectPrivateLegacy);
 input.app.put('/api/rooms/:roomName',rejectPrivateLegacy);
 input.app.post('/api/end-meeting',rejectPrivateLegacy);
 const signals=privateSignaling(service,input.livekitUrl),watchdog=privateWatchdog(service,store,input.report);
 return {upgrade:(req:IncomingMessage,socket:Duplex,head:Buffer)=>signals.upgrade(req,socket,head),stop(){watchdog.stop();signals.stop();}};
}
