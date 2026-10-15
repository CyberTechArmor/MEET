import {useEffect,useMemo,useRef,useState} from 'react';
import {ConnectionState} from 'livekit-client';
import VideoRoom from './components/VideoRoom';
import {useLiveKit} from './hooks/useLiveKit';
import {useRoomStore} from './stores/roomStore';
import {frameBinding,privateFrameBridge,validFrameMessage} from './lib/nodusPrivateBridge';
import {installPrivateCallContext,type PrivateCallContext} from './lib/nodusPrivateContext';
import {privateWebSocket,PRIVATE_SIGNAL_SENTINEL,type OpaqueSignalSession} from './lib/nodusPrivateTransport';
import './nodus-private.css';
import {privateRecovery} from './lib/nodusPrivateRecovery';

/** Separate entry: PublicApp and its token/session/legacy bridge hooks never mount here. */
export default function NodusPrivateApp(){
  const binding=useMemo(()=>{try{return frameBinding(new URL(location.href));}catch{return null;}},[]);
  const {connect,disconnect}=useLiveKit(),actions=useRef({connect,disconnect});actions.current={connect,disconnect};
  const view=useRoomStore(s=>s.view),state=useRoomStore(s=>s.connectionState);
  const [error,setError]=useState(''),retry=useRef<()=>void>(()=>{});
  useEffect(()=>{
    if(!binding||window.parent===window){setError('Open this private call from Nodus.');return;}
    const bridge=privateFrameBridge(binding,window.parent),Native=window.WebSocket;
    let lastState=useRoomStore.getState().connectionState;
    let closed=false,joining=false,leaving=false,currentSession:OpaqueSignalSession|undefined;
    const context:PrivateCallContext={post:event=>{const {type,...payload}=event;bridge.emit(type.replace(/^meet:/,''),payload);},url:location.origin.replace(/^http/,'ws')+'/api/private/livekit',credentials:async()=>{
      const session=await bridge.requestSession();if(closed||leaving)throw Error('Call closed.');
      currentSession={sessionToken:session.sessionToken,expiresAt:Date.parse(session.expiresAt)};
      useRoomStore.getState().setHideEndCall(true);
      bridge.emit('authorized',{canEnd:session.canEnd});
      return {token:PRIVATE_SIGNAL_SENTINEL,roomName:binding.roomId,participantName:'Nodus participant',participantIdentity:'',isHost:false,quality:'auto',iceServers:session.iceServers};
    }};
    const clearContext=installPrivateCallContext(context),Wrapped=privateWebSocket(Native,location.origin,()=>currentSession);window.WebSocket=Wrapped;
    const join=async()=>{if(closed||joining||leaving)return;joining=true;setError('');bridge.emit('connecting');try{await actions.current.connect(binding.roomId,'Nodus participant',{silent:true});}catch{if(!closed&&!leaving){setError('The call could not connect. Check your connection and try again.');bridge.emit('error');}}finally{joining=false;}};
    const recovery=privateRecovery({retry:join,left:()=>bridge.emit('left'),reconnecting:()=>bridge.emit('reconnecting'),failed:()=>{setError('The call was interrupted. Try reconnecting.');bridge.emit('error');},teardown:()=>{leaving=true;currentSession=undefined;void actions.current.disconnect();}});
    context.onDisconnected=reason=>{if(!closed&&!leaving)recovery.disconnected(reason);};
    retry.current=()=>recovery.retry();
    const unsubscribe=useRoomStore.subscribe(s=>{
      if(closed||lastState===s.connectionState)return;lastState=s.connectionState;
      if(s.connectionState===ConnectionState.Connected){recovery.connected();bridge.emit('joined',{participants:s.remoteParticipants.length+1});}
    });
    const command=async(event:MessageEvent)=>{if(closed||event.source!==window.parent||event.origin!==binding.origin||!validFrameMessage(event.data,binding)||event.data.type!=='leave')return;leaving=true;recovery.stop();try{await actions.current.disconnect();if(!closed)bridge.emit('left',{requestId:event.data.requestId});}catch{if(!closed){setError('The call could not close. Try again.');bridge.emit('error');}}};
    window.addEventListener('message',command);bridge.emit('ready');void join();
    return()=>{closed=true;recovery.stop();unsubscribe();window.removeEventListener('message',command);bridge.close();context.stopMedia?.();clearContext();currentSession=undefined;void context.room?.disconnect();if(window.WebSocket===Wrapped)window.WebSocket=Native;};
  },[binding]);
  if(view==='room')return <div className="nodus-private-root h-full w-full"><VideoRoom/></div>;
  return <main className="nodus-private-root h-full w-full bg-meet-bg flex flex-col items-center justify-center p-6" aria-live="polite"><h1 className="text-2xl text-meet-text-primary">Nodus call</h1><p className="text-meet-text-secondary">{error||(state===ConnectionState.Connecting?'Connecting…':'Preparing your call…')}</p>{error&&binding&&<button onClick={()=>retry.current()} className="px-4 py-3">Try again</button>}</main>;
}
