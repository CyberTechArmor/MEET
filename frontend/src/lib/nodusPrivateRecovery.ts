import {DisconnectReason} from 'livekit-client';

/** The SDK reports connection state before the separate Disconnected reason event. */
export function privateRecovery(options:{retry:()=>Promise<void>;left:()=>void;reconnecting:()=>void;failed:()=>void;teardown:()=>void}){
 let closed=false,attempts=0,timer:ReturnType<typeof setTimeout>|undefined;
 const cancel=()=>{clearTimeout(timer);timer=undefined;};
 const terminal=new Set<number>([DisconnectReason.CLIENT_INITIATED,DisconnectReason.PARTICIPANT_REMOVED,DisconnectReason.ROOM_DELETED,DisconnectReason.ROOM_CLOSED,DisconnectReason.DUPLICATE_IDENTITY]);
 return {
  connected(){if(!closed){cancel();attempts=0;}},
  disconnected(reason:number){
   if(closed)return;
   cancel();
   if(terminal.has(reason)){closed=true;options.teardown();options.left();return;}
   if(attempts>=3){options.failed();return;}
   attempts++;options.reconnecting();timer=setTimeout(()=>{timer=undefined;if(!closed)void options.retry();},Math.min(5000,attempts*1500));
  },
  stop(){closed=true;cancel();},
  retry(){if(closed)return;cancel();attempts=0;void options.retry();},
 };
}
