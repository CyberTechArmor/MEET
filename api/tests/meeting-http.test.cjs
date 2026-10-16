const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

test('HTTP handlers reject untrusted callers before touching LiveKit', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meet-access-test-'));
  process.env.MEET_DATA_DIR = dir;
  const store = require('../dist/store.js');
  const db = require('../dist/db.js').getDb();
  store.saveSettings({ publicAccessEnabled: false, maxParticipantsPerMeeting: 100, maxConcurrentMeetings: 10, iframeAllowedDomains: [], defaultVideoQuality: 'auto' });
  for (const permission of ['read', 'write', 'admin']) {
    const key = 'unit-test-' + permission;
    store.saveApiKey({ id: permission, name: permission, key, keyHash: crypto.createHash('sha256').update(key).digest('hex'), permissions: [permission], createdAt: new Date(), lastUsedAt: null });
  }
  const server = spawn(process.execPath, ['dist/index.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: '18089', LIVEKIT_URL: 'http://127.0.0.1:1', LIVEKIT_API_KEY: 'unit-test', LIVEKIT_API_SECRET: 'unit-test-only-secret' }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:18089';
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(ready, 'isolated API started');
    const post = (route, headers = {}, body = { roomName: 'isolated', participantName: 'test', participantIdentity: 'host' }) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/api/token')).status, 403);
    assert.equal((await post('/api/token', { 'X-API-Key': 'invalid' })).status, 401);
    assert.equal((await post('/api/token', { 'X-API-Key': 'unit-test-read' })).status, 403);
    assert.equal((await post('/api/token', { 'X-API-Key': 'unit-test-write' })).status, 503, 'LiveKit failure must fail closed');
    assert.equal((await post('/api/end-meeting')).status, 401);
    assert.equal((await post('/api/end-meeting', { Authorization: 'Bearer forged' })).status, 401);
    assert.equal((await post('/api/end-meeting', { 'X-API-Key': 'invalid' })).status, 401);
    assert.equal((await post('/api/end-meeting', { 'X-API-Key': 'unit-test-read' })).status, 403);
    assert.equal((await fetch(base + '/api/admin/settings', { headers: { 'X-API-Key': 'unit-test-read' } })).status, 403);
    assert.equal((await fetch(base + '/api/admin/settings', { headers: { 'X-API-Key': 'unit-test-admin' } })).status, 200);
    assert.equal((await fetch(base + '/api/room-code', { headers: { 'X-API-Key': 'invalid' } })).status, 401);
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => server.once('exit', r));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
