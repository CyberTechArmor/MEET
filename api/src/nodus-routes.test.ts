import express from 'express';
import request from 'supertest';
import {describe,it,expect} from 'vitest';
import {rejectPrivateLegacy,nodusRoutes} from './nodus-routes.js';
describe('private and legacy HTTP boundaries',()=>{
 it('preserves ordinary public callers while blocking private names before old token/create/end code',async()=>{
  const app=express();app.use(express.json());for(const route of ['/api/token','/api/rooms','/api/end-meeting'])app.post(route,rejectPrivateLegacy,(_req,res)=>res.json({legacy:true}));app.put('/api/rooms/:roomName',rejectPrivateLegacy,(_req,res)=>res.json({legacy:true}));
  const privateName='nodus_'+'a'.repeat(40);
  for(const route of ['/api/token','/api/rooms','/api/end-meeting']){expect((await request(app).post(route).send({roomName:'ordinary-public'})).body.legacy).toBe(true);expect((await request(app).post(route).send({roomName:'nodus_public_team'})).body.legacy).toBe(true);expect((await request(app).post(route).send({roomName:privateName})).status).toBe(403);expect((await request(app).post(route).send({roomName:'!'+privateName})).status).toBe(403);}
  expect((await request(app).put('/api/rooms/'+privateName).send({displayName:'change'})).status).toBe(403);
 });
 it('requires the selected API key identity and never treats an admin browser as a Nodus actor',async()=>{
  let called=0;const engine={create:async()=>{called++;return {};}} as any;
  const app=express();app.use(express.json());app.use('/api/integrations/nodus',nodusRoutes(engine,(_req,_res,next)=>next(),()=>true));
  expect((await request(app).post('/api/integrations/nodus/rooms').send({})).status).toBe(403);expect(called).toBe(0);
  const status=await request(app).get('/api/integrations/nodus/capabilities');expect(status.body).toMatchObject({contract:'nodus-private-room-v1',configured:true});expect(status.headers['cache-control']).toBe('no-store');
 });
 it('tells the presenting key its own ID and whether it is the selected Nodus key, and nothing else',async()=>{
  const app=express();app.use(express.json());let configured=true;
  // Stands in for the real API-key middleware: a header names the presenting key.
  const authenticate=(req:any,_res:any,next:any)=>{const id=req.get('x-test-key');if(id)req.apiKey={id};next();};
  app.use('/api/integrations/nodus',nodusRoutes({} as any,authenticate,()=>configured,()=>({keyId:'k-nodus',nodusOrigin:'https://nodus.example.test'})));
  const ask=(key?:string)=>{const r=request(app).post('/api/integrations/nodus/identity').send({});return key?r.set('x-test-key',key):r;};
  const selected=await ask('k-nodus');expect(selected.body).toEqual({contract:'nodus-private-room-v1',integrationId:'k-nodus',selected:true,nodusOrigin:'https://nodus.example.test'});expect(selected.headers['cache-control']).toBe('no-store');
  expect((await ask('k-other')).body).toEqual({contract:'nodus-private-room-v1',integrationId:'k-other',selected:false});
  configured=false;expect((await ask('k-nodus')).body).toEqual({contract:'nodus-private-room-v1',integrationId:'k-nodus',selected:false});
  expect((await ask()).status).toBe(403);
 });
});
