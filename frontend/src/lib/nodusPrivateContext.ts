import type {Room} from 'livekit-client';
import type {TokenResponse} from './livekit';
export interface PrivateCallContext {url:string;room?:Room;stopMedia?:()=>void;credentials:()=>Promise<TokenResponse>;onDisconnected?:(reason:number)=>void;post?:(event:{type:string;[key:string]:unknown})=>void;}
let active:PrivateCallContext|undefined;
export const privateCallContext=()=>active;
export function installPrivateCallContext(context:PrivateCallContext){active=context;return()=>{if(active===context)active=undefined;};}
