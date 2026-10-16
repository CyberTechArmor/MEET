const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port; }

// Only operating-system runtime paths are inherited; every MEET setting and key belongs to this fixture.
function startApi(dir, port, extra) {
  const env = { PATH: process.env.PATH || '', TEMP: os.tmpdir(), TMP: os.tmpdir(), NODE_ENV: 'test', PORT: String(port), MEET_DATA_DIR: dir, LIVEKIT_URL: 'http://127.0.0.1:1', LIVEKIT_API_KEY: 'synthetic-nodus-admin', LIVEKIT_API_SECRET: 'synthetic-nodus-admin-only-secret', PUBLIC_BASE_URL: 'https://meet.example.test', ...extra };
  return spawn(process.execPath, ['dist/index.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore' });
}
async function healthy(base, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, 'isolated API must stay running');
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('isolated API did not become healthy');
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await exited; clearTimeout(timer);
}

test('an administrator chooses the Nodus key and address in MEET; it applies at once and a key cannot select itself', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meet-nodus-admin-test-'));
  process.env.MEET_DATA_DIR = dir;
  const store = require('../dist/store.js');
  const db = require('../dist/db.js').getDb();
  const keys = { 'k-admin': ['admin'], 'k-nodus': ['write'], 'k-read': ['read'], 'k-other': ['write'] };
  for (const [id, permissions] of Object.entries(keys)) {
    const key = 'synthetic-' + id;
    store.saveApiKey({ id, name: id, key, keyHash: crypto.createHash('sha256').update(key).digest('hex'), permissions, createdAt: new Date(), lastUsedAt: null });
  }
  const as = id => ({ 'X-API-Key': 'synthetic-' + id, 'Content-Type': 'application/json' });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { NODUS_INTEGRATION_KEY_ID: 'k-other', NODUS_ORIGIN: 'https://old-nodus.example.test' };
  const call = (method, route, id, body) => fetch(base + route, { method, headers: id ? as(id) : { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const view = async () => (await call('GET', '/api/admin/nodus', 'k-admin')).json();
  const identity = async id => (await call('POST', '/api/integrations/nodus/identity', id, {})).json();
  let child = startApi(dir, port, env);
  try {
    await healthy(base, child);
    // Only administrators read or change it.
    assert.equal((await call('GET', '/api/admin/nodus')).status, 401);
    assert.equal((await call('GET', '/api/admin/nodus', 'k-nodus')).status, 403);
    assert.equal((await call('PUT', '/api/admin/nodus', 'k-nodus', { keyId: 'k-nodus', nodusOrigin: 'https://nodus.example.test' })).status, 403);
    // Without a saved choice the server settings apply.
    assert.deepEqual(await view(), { source: 'environment', keyId: 'k-other', keyName: 'k-other', nodusOrigin: 'https://old-nodus.example.test', configured: true, problem: null, updatedAt: null, updatedBy: null, environmentSet: true });
    assert.equal((await identity('k-nodus')).selected, false);
    assert.equal((await identity('k-other')).selected, true);
    // Refuses a missing key, a key without write access and anything but an exact https origin.
    for (const body of [{ keyId: 'missing', nodusOrigin: 'https://nodus.example.test' }, { keyId: 'k-read', nodusOrigin: 'https://nodus.example.test' }, { keyId: 'k-nodus', nodusOrigin: 'http://nodus.example.test' }, { keyId: 'k-nodus', nodusOrigin: 'https://nodus.example.test/app' }, { keyId: 'k-nodus', nodusOrigin: 'https://user@nodus.example.test' }, { keyId: 'k-nodus' }]) {
      assert.equal((await call('PUT', '/api/admin/nodus', 'k-admin', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await view()).keyId, 'k-other', 'a refused change leaves the connection as it was');
    // Saving applies at once, without a restart.
    const saved = await (await call('PUT', '/api/admin/nodus', 'k-admin', { keyId: 'k-nodus', nodusOrigin: ' https://Nodus.example.test/ ' })).json();
    assert.equal(saved.source, 'settings'); assert.equal(saved.keyId, 'k-nodus'); assert.equal(saved.nodusOrigin, 'https://nodus.example.test'); assert.equal(saved.configured, true); assert.equal(saved.problem, null); assert.equal(saved.updatedBy, 'apikey:k-admin');
    assert.deepEqual(await identity('k-nodus'), { contract: 'nodus-private-room-v1', integrationId: 'k-nodus', selected: true, nodusOrigin: 'https://nodus.example.test', embedOrigin: 'https://meet.example.test' });
    assert.equal((await identity('k-other')).selected, false);
    // It survives a restart and still wins over the server settings.
    await stop(child); child = startApi(dir, port, env); await healthy(base, child);
    assert.equal((await view()).keyId, 'k-nodus');
    // Revoking the selected key turns calls off and says why.
    assert.equal((await call('DELETE', '/api/admin/api-keys/k-nodus', 'k-admin')).status, 200);
    const revoked = await view();
    assert.equal(revoked.configured, false); assert.match(revoked.problem, /no longer exists/);
    // Forgetting the saved choice falls back to the server settings.
    const cleared = await (await call('DELETE', '/api/admin/nodus', 'k-admin')).json();
    assert.equal(cleared.source, 'environment'); assert.equal(cleared.keyId, 'k-other'); assert.equal(cleared.configured, true);
    assert.equal((await identity('k-other')).selected, true);
  } finally {
    await stop(child);
    db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with nothing saved and no server settings, private calls stay off', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meet-nodus-admin-test-'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = startApi(dir, port, {});
  try {
    await healthy(base, child);
    const caps = await (await fetch(base + '/api/integrations/nodus/capabilities')).json();
    assert.equal(caps.configured, false);
  } finally {
    await stop(child);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});
