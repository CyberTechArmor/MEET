/** Private iframe only. Never pass an opaque handle to Room.connect or put it in a URL. */
export const PRIVATE_SIGNAL_SENTINEL = 'nodus-private-v1';
export interface OpaqueSignalSession {sessionToken:string;expiresAt:number;}

export function privateSignalRequest(input:string|URL,origin:string,session:OpaqueSignalSession|undefined,now=Date.now()) {
  const url=new URL(input);
  const expected=new URL(origin);
  expected.protocol=expected.protocol==='https:'?'wss:':'ws:';
  if(url.origin!==expected.origin||url.pathname!=='/api/private/livekit/rtc'||url.username||url.password||url.hash)throw Error('Private signaling endpoint mismatch.');
  if(url.searchParams.getAll('access_token').length!==1||url.searchParams.get('access_token')!==PRIVATE_SIGNAL_SENTINEL)throw Error('Unexpected private signaling credential.');
  // Physical identities are new for each full join. A partial SDK resume would bind its old SID.
  if(url.searchParams.has('reconnect')||url.searchParams.has('sid'))throw Error('A fresh private call authorization is required.');
  if(!session||!/^[A-Za-z0-9_-]{43}$/.test(session.sessionToken)||!Number.isFinite(session.expiresAt)||session.expiresAt<=now)throw Error('Private call authorization expired.');
  url.searchParams.delete('access_token');
  return {url:url.toString(),protocols:['nodus-private-v1','session.'+session.sessionToken]};
}

/** Return a constructor without mutating the caller. Only PrivateApp installs it in its own realm. */
export function privateWebSocket(Native:typeof WebSocket,origin:string,current:()=>OpaqueSignalSession|undefined):typeof WebSocket {
  return class PrivateWebSocket extends Native {
    constructor(url:string|URL,protocols?:string|string[]) {
      if(protocols&&(typeof protocols==='string'||protocols.length))throw Error('Unexpected private signaling protocol.');
      const request=privateSignalRequest(url,origin,current());
      super(request.url,request.protocols);
    }
  };
}
