import {Router,type RequestHandler} from 'express';
import {NODUS_MEET_CONTRACT,PrivateMeetError,isPrivateRoom,type PrivateRoomStore} from './nodus-contract.js';
import type {privateMeet} from './nodus-private.js';
type Engine=ReturnType<typeof privateMeet>;
type KeyRequest={apiKey?:{id:string}};
/** Installed before legacy token/create/update/end handlers, including when unconfigured. */
export const rejectPrivateLegacy:RequestHandler=(req,res,next)=>{
 const raw=req.params.roomName??req.body?.roomName;
 const normalized=typeof raw==='string'?raw.replace(/[^a-zA-Z0-9-_]/g,'').slice(0,50):'';
 if(isPrivateRoom(normalized)){res.status(403).json({error:'A current private meeting grant is required.'});return;}next();
};
export function nodusRoutes(engine:Engine,authenticate:RequestHandler,ready:()=>boolean){
 const router=Router();
 const wrapped=(handler:(req:any,res:any)=>Promise<void>|void):RequestHandler=>async(req,res)=>{res.setHeader('Cache-Control','no-store');try{await handler(req,res);}catch(error){const status=error instanceof PrivateMeetError?error.status:503;res.status(status).json({error:error instanceof PrivateMeetError?error.code:'unavailable'});}};
 const key=(req:KeyRequest)=>{if(!ready())throw new PrivateMeetError(503,'not_configured');if(!req.apiKey?.id)throw new PrivateMeetError(403,'not_authorized');return req.apiKey.id;};
 router.get('/capabilities',(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json({contract:NODUS_MEET_CONTRACT,configured:ready(),privateRooms:true,singleUseGrants:true,liveAuthorization:true,publicTokenBypass:false,browserCredential:'opaque-subprotocol',signalingPath:'/api/private/livekit',signalEncoding:'protobuf'});});
 router.post('/rooms',authenticate,wrapped(async(req,res)=>{res.json(await engine.create(key(req),req.body??{}));}));
 router.post('/rooms/:roomId/tickets',authenticate,wrapped(async(req,res)=>{res.json(await engine.ticket(key(req),req.params.roomId,req.body??{}));}));
 router.post('/exchange',wrapped(async(req,res)=>{const value=await engine.exchange(req.body?.roomId,req.body?.ticket,req.get('origin')??'');res.json(value);}));
 router.post('/rooms/:roomId/revoke',authenticate,wrapped(async(req,res)=>{res.json(await engine.revoke(key(req),req.params.roomId,req.body?.subject,req.body?.deviceId));}));
 router.post('/rooms/:roomId/end',authenticate,wrapped(async(req,res)=>{res.json(await engine.end(key(req),req.params.roomId,req.body??{}));}));
 router.post('/rooms/:roomId/retire',authenticate,wrapped(async(req,res)=>{res.json(await engine.retire(key(req),req.params.roomId));}));
 return router;
}
/** Bounded, non-overlapping watchdog. Error means no acknowledgement, never a successful eviction. */
export function privateWatchdog(engine:Engine,_store:PrivateRoomStore,report:()=>void,intervalMs=1000){
 let running=false,stopped=false;let cursor:string|undefined;
 const tick=async()=>{if(running||stopped)return;running=true;try{cursor=await engine.audit(cursor);}catch{report();}finally{running=false;}};
 const timer=setInterval(()=>{void tick();},intervalMs);timer.unref();void tick();
 return {tick,stop(){stopped=true;clearInterval(timer);}};
}
