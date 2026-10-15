/** LiveKit protobuf envelope firewall. Unknown fields fail closed; private-room moves are unsupported.
 * Schema: https://github.com/livekit/protocol/blob/main/protobufs/livekit_rtc.proto
 * SignalResponse.refresh_token=16 and RoomMovedResponse=24 must never reach the browser.
 */
type Field={id:number;wire:number;raw:Buffer;value:Buffer};
function fields(data:Buffer):Field[]{
 if(data.length>1024*1024)throw Error('Signal frame too large');
 let offset=0;const out:Field[]=[];
 function variable(){let value=0,multiplier=1;for(let i=0;i<10;i++){if(offset>=data.length)throw Error('Incomplete signal');const byte=data[offset++];value+=(byte&127)*multiplier;if(!Number.isSafeInteger(value))throw Error('Unsafe signal length');if(!(byte&128))return value;multiplier*=128;}throw Error('Invalid signal varint');}
 while(offset<data.length){if(out.length>=512)throw Error('Too many signal fields');const start=offset,tag=variable(),id=Math.floor(tag/8),wire=tag%8;if(!id)throw Error('Invalid signal tag');let payload=offset,end:number;
  if(wire===0){variable();end=offset;}else if(wire===1){end=offset+8;}else if(wire===5){end=offset+4;}else if(wire===2){const length=variable();payload=offset;end=offset+length;}else throw Error('Unsupported signal wire type');
  if(end>data.length)throw Error('Incomplete signal field');out.push({id,wire,raw:data.subarray(start,end),value:data.subarray(payload,end)});offset=end;
 }return out;
}
function varint(n:number){const bytes:number[]=[];do{let b=n%128;n=Math.floor(n/128);if(n)b|=128;bytes.push(b);}while(n);return Buffer.from(bytes);}
export function filterPrivateSignal(data:Buffer,direction:'client'|'server'):Buffer|null{
 const parsed=fields(data);if(parsed.length!==1)throw Error('A single signal message is required');const field=parsed[0];
 if(direction==='client'){if(![1,2,3,4,5,6,7,8,10,11,12,14,15,16,17,18].includes(field.id))throw Error('Unsupported private client signal');return data;}
 if(field.id===16){if(field.wire!==2)throw Error('Invalid token update');return null;}
 if(field.id===24||field.id>23)throw Error('Unsupported private server signal');
 if(![1,2,3,4,5,6,8,9,10,11,12,13,14,15,17,18,19,20,21,22,23].includes(field.id))throw Error('Unknown private server signal');
 if(field.id===1){if(field.wire!==2)throw Error('Invalid join message');const join=fields(field.value);if(join.some(f=>f.id>15))throw Error('Unsupported join response');const body=Buffer.concat(join.filter(f=>f.id!==7).map(f=>f.raw));return Buffer.concat([varint(10),varint(body.length),body]);}
 return data;
}
