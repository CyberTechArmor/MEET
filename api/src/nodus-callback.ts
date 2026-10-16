import {createHmac} from 'node:crypto';
import {NODUS_MEET_CONTRACT,PrivateMeetError,exactOrigin,type AuthorizationRequest,type IntegrationBinding,type PrivateAuthority} from './nodus-contract.js';

export function callbackBinding(input:{id:string;origin:string;embedOrigin?:string;credential:string},request:typeof fetch=fetch,now=Date.now):IntegrationBinding {
 const origin=exactOrigin(input.origin);if(!input.id||!input.credential)throw Error('Missing configured integration');
 return {id:input.id,origin,embedOrigin:input.embedOrigin?exactOrigin(input.embedOrigin):undefined,async authorize(value:AuthorizationRequest):Promise<PrivateAuthority>{
  const body=JSON.stringify({contract:NODUS_MEET_CONTRACT,...value}),sentAt=String(now());
  const signature=createHmac('sha256',input.credential).update(`${sentAt}\n${body}`).digest('hex');
  let response:Response;try{response=await request(origin+'/api/meet/authorize',{method:'POST',redirect:'error',headers:{'content-type':'application/json','cache-control':'no-store','x-nodus-integration':input.id,'x-nodus-sent-at':sentAt,'x-nodus-signature':signature},body,signal:AbortSignal.timeout(2000)});}catch{throw new PrivateMeetError(503,'unavailable');}
  if(!response.ok){await response.body?.cancel();throw new PrivateMeetError(response.status===403||response.status===401?403:503,response.status===403||response.status===401?'not_authorized':'unavailable');}
  if(!response.body)throw new PrivateMeetError(503,'unavailable');
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let length=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;if(length>4096)throw new PrivateMeetError(503,'unavailable');parts.push(chunk.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  let data:Record<string,unknown>;try{data=JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string,unknown>;}catch{throw new PrivateMeetError(503,'unavailable');}
  if(data.contract!==NODUS_MEET_CONTRACT||data.allowed!==true||data.roomId!==value.roomId||data.callId!==value.callId||data.generation!==value.generation||typeof data.canEnd!=='boolean'||typeof data.participantName!=='string'||data.participantName.length>200||typeof data.expiresAt!=='string')throw new PrivateMeetError(403,'not_authorized');
  const expiresAt=Date.parse(data.expiresAt);if(!Number.isFinite(expiresAt)||expiresAt<=now()||expiresAt>now()+30000)throw new PrivateMeetError(403,'expired');
  return {allowed:true,canEnd:data.canEnd,participantName:data.participantName,expiresAt};
 }};
}
