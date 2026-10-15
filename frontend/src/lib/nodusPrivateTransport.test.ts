import {describe,it,expect} from 'vitest';
import {PRIVATE_SIGNAL_SENTINEL,privateSignalRequest,privateWebSocket} from './nodusPrivateTransport';
const origin='https://meet.example',session={sessionToken:'a'.repeat(43),expiresAt:Date.now()+20000};
const url=`wss://meet.example/api/private/livekit/rtc?access_token=${PRIVATE_SIGNAL_SENTINEL}&protocol=15&sdk=js`;
describe('private frame signaling',()=>{
  it('moves only the opaque credential to a subprotocol and never sends a URL credential',()=>{const r=privateSignalRequest(url,origin,session);expect(new URL(r.url).searchParams.has('access_token')).toBe(false);expect(r.url).not.toContain(session.sessionToken);expect(r.protocols).toEqual(['nodus-private-v1','session.'+session.sessionToken]);expect(new URL(r.url).searchParams.get('protocol')).toBe('15');});
  it.each([url.replace('meet.example','other.example'),url.replace('/rtc?','/rtc/v1?'),url.replace(PRIVATE_SIGNAL_SENTINEL,'saved-jwt'),url+'&access_token='+PRIVATE_SIGNAL_SENTINEL,url+'&sid=old',url+'&reconnect=1',url+'#secret'])('refuses an unexpected endpoint, credential or partial resume',value=>{expect(()=>privateSignalRequest(value,origin,session)).toThrow();});
  it('refuses expired and missing opaque authorization',()=>{expect(()=>privateSignalRequest(url,origin,undefined)).toThrow();expect(()=>privateSignalRequest(url,origin,{...session,expiresAt:1})).toThrow();});
  it('preserves the real WebSocket surface while pinning constructor arguments',()=>{let passed:unknown[]=[];class Native{static OPEN=1;binaryType='blob';constructor(...args:unknown[]){passed=args;}}const Private=privateWebSocket(Native as unknown as typeof WebSocket,origin,()=>session);const socket=new Private(url);expect(socket).toBeInstanceOf(Native);expect(Private.OPEN).toBe(1);expect(passed).toEqual([privateSignalRequest(url,origin,session).url,['nodus-private-v1','session.'+session.sessionToken]]);expect(()=>new Private(url,['unexpected'])).toThrow();});
});
