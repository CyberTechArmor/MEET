const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AccessToken, TokenVerifier } = require('livekit-server-sdk');
const { permitsApiOperation, isHostForMeeting } = require('../dist/meeting-access.js');
test('API scopes cannot escalate read to write/admin', () => {
  assert.equal(permitsApiOperation(['read'], 'write'), false);
  assert.equal(permitsApiOperation(['write'], 'admin'), false);
  assert.equal(permitsApiOperation([], 'read'), false);
  assert.equal(permitsApiOperation(['write'], 'write'), true);
  assert.equal(permitsApiOperation(['admin'], 'write'), true);
});
test('meeting host must match signed room, identity and host grant', async () => {
  const key = 'regression-only';
  const secret = 'ephemeral-unit-test-signing-material';
  const verifier = new TokenVerifier(key, secret);
  const token = new AccessToken(key, secret, { identity: 'host', ttl: 60 });
  token.addGrant({ room: 'isolated', roomJoin: true, roomAdmin: true });
  const jwt = await token.toJwt();
  const claims = await verifier.verify(jwt);
  assert.equal(isHostForMeeting(claims, 'isolated', 'host'), true);
  assert.equal(isHostForMeeting(claims, 'other-room', 'host'), false);
  assert.equal(isHostForMeeting(claims, 'isolated', 'forged-identity'), false);
  assert.equal(isHostForMeeting({ ...claims, video: { ...claims.video, roomAdmin: false } }, 'isolated', 'host'), false);
  await assert.rejects(verifier.verify(jwt.slice(0, -8) + 'tampered'));
  const expired = new AccessToken(key, secret, { identity: 'host', ttl: -120 });
  expired.addGrant({ room: 'isolated', roomJoin: true, roomAdmin: true });
  await assert.rejects(verifier.verify(await expired.toJwt()));
});
