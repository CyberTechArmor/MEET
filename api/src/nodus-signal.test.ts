import {describe,it,expect} from 'vitest';
import {filterPrivateSignal} from './nodus-signal.js';
const field=(id:number,value:Buffer)=>Buffer.concat([id<16?Buffer.from([id*8+2]):Buffer.from([(id*8+2)%128+128,Math.floor((id*8+2)/128)]),Buffer.from([value.length]),value]);
describe('private signaling envelope',()=>{
 it('drops refresh credentials and rejects room moves carrying new credentials',()=>{const jwt=Buffer.from('synthetic-private-token');expect(filterPrivateSignal(field(16,jwt),'server')).toBeNull();expect(()=>filterPrivateSignal(field(24,field(2,jwt)),'server')).toThrow();});
 it('removes alternative URLs that could bypass the private gateway',()=>{const safe=field(2,Buffer.from('participant'));const message=field(1,Buffer.concat([safe,field(7,Buffer.from('wss://direct.example'))]));expect(filterPrivateSignal(message,'server')).toEqual(field(1,safe));});
 it('passes only known signaling envelopes and refuses malformed/oversized/ambiguous frames',()=>{const safe=field(3,Buffer.from('sdp'));expect(filterPrivateSignal(safe,'client')).toEqual(safe);expect(()=>filterPrivateSignal(field(13,Buffer.alloc(0)),'client')).toThrow();expect(()=>filterPrivateSignal(field(31,Buffer.alloc(0)),'server')).toThrow();expect(()=>filterPrivateSignal(Buffer.concat([safe,safe]),'server')).toThrow();expect(()=>filterPrivateSignal(Buffer.from([10,127]),'server')).toThrow();expect(()=>filterPrivateSignal(Buffer.alloc(1024*1024+1),'server')).toThrow();});
});
