import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync,readFileSync} from 'node:fs';
import path from 'node:path';
const frontend=createRequire(new URL('../frontend/package.json',import.meta.url));
const sdkRoot=realpathSync(path.resolve(path.dirname(frontend.resolve('livekit-client')),'..'));
const sdk=createRequire(path.join(sdkRoot,'package.json')),p=sdk('@livekit/protocol');
const {filterPrivateSignal}=createRequire(import.meta.url)('../api/dist/nodus-signal.js');
const wire=(caseName,value,Type=p.SignalRequest)=>Buffer.from(new Type({message:{case:caseName,value}}).toBinary());

test('private signaling compatibility uses the pinned real SDK and generated protocol',()=>{
 const lock=JSON.parse(readFileSync(new URL('../frontend/package-lock.json',import.meta.url),'utf8'));
 assert.equal(JSON.parse(readFileSync(path.join(sdkRoot,'package.json'),'utf8')).version,lock.packages['node_modules/livekit-client'].version);
 const protocolEntry=sdk.resolve('@livekit/protocol'),protocolPackage=JSON.parse(readFileSync(path.join(path.dirname(path.dirname(protocolEntry)),'package.json'),'utf8'));
 assert.equal(protocolPackage.version,lock.packages['node_modules/@livekit/protocol'].version);
 for(const [kind,value]of[
  ['offer',new p.SessionDescription({type:'offer',sdp:'v=0\r\n'})],
  ['answer',new p.SessionDescription({type:'answer',sdp:'v=0\r\n'})],
  ['trickle',new p.TrickleRequest({candidateInit:'{"candidate":"synthetic"}',target:0})],
  ['addTrack',new p.AddTrackRequest({cid:'synthetic',name:'microphone',type:0,source:2})],
  ['mute',new p.MuteTrackRequest({sid:'TR_fixture',muted:true})],
  ['leave',new p.LeaveRequest()],
  ['pingReq',new p.Ping({timestamp:1n})],
 ]){const data=wire(kind,value);assert.deepEqual(filterPrivateSignal(data,'client'),data,kind);}
});
test('actual generated join keeps media metadata but strips alternate endpoints and refreshed JWTs',()=>{
 const join=new p.JoinResponse({room:new p.Room({sid:'RM_fixture',name:'private-room'}),participant:new p.ParticipantInfo({sid:'PA_fixture',identity:'private-person'}),alternativeUrl:'https://untrusted.invalid',serverInfo:new p.ServerInfo({version:'1.9.0',protocol:15})});
 const cleaned=p.SignalResponse.fromBinary(filterPrivateSignal(wire('join',join,p.SignalResponse),'server'));
 assert.equal(cleaned.message.case,'join');assert.equal(cleaned.message.value.alternativeUrl,'');assert.equal(cleaned.message.value.participant.identity,'private-person');assert.equal(cleaned.message.value.serverInfo.version,'1.9.0');
 assert.equal(filterPrivateSignal(wire('refreshToken','synthetic-server-token',p.SignalResponse),'server'),null);
 assert.throws(()=>filterPrivateSignal(wire('roomMoved',new p.RoomMovedResponse(),p.SignalResponse),'server'));
});
