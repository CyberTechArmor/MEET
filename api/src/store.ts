// Typed CRUD wrappers over the schema in db.ts. Every mutation is a
// single SQL statement (so atomic without an explicit transaction);
// reads return rehydrated objects with Date instances rather than raw
// ISO strings, matching the shapes index.ts already operates on.

import { getDb } from './db.js';
import * as crypto from 'crypto';
import type {
  ApiKey,
  Webhook,
  AdminSession,
  PersistedSettings,
  AdminCredentials,
  Passkey,
} from './types.js';

// ─────────────────────────────── api_keys ──────────────────────────────

export function listApiKeys(): ApiKey[] {
  const rows = getDb()
    .prepare('SELECT * FROM api_keys ORDER BY created_at ASC')
    .all() as ApiKeyRow[];
  return rows.map(rowToApiKey);
}

export function getApiKey(id: string): ApiKey | undefined {
  const row = getDb()
    .prepare('SELECT * FROM api_keys WHERE id = ?')
    .get(id) as ApiKeyRow | undefined;
  return row ? rowToApiKey(row) : undefined;
}

export function findApiKeyByHash(keyHash: string): ApiKey | undefined {
  const row = getDb()
    .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
    .get(keyHash) as ApiKeyRow | undefined;
  return row ? rowToApiKey(row) : undefined;
}

export function saveApiKey(k: ApiKey): void {
  getDb()
    .prepare(
      `INSERT INTO api_keys
         (id, name, key, key_hash, permissions, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         key = excluded.key,
         key_hash = excluded.key_hash,
         permissions = excluded.permissions,
         last_used_at = excluded.last_used_at`,
    )
    .run(
      k.id,
      k.name,
      k.key,
      k.keyHash,
      JSON.stringify(k.permissions),
      k.createdAt.toISOString(),
      k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
    );
}

export function deleteApiKey(id: string): boolean {
  const r = getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  return r.changes > 0;
}

export function countApiKeys(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM api_keys')
    .get() as { c: number };
  return row.c;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key: string;
  key_hash: string;
  permissions: string;
  created_at: string;
  last_used_at: string | null;
}

function rowToApiKey(r: ApiKeyRow): ApiKey {
  return {
    id: r.id,
    name: r.name,
    key: r.key,
    keyHash: r.key_hash,
    permissions: JSON.parse(r.permissions) as string[],
    createdAt: new Date(r.created_at),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
  };
}

// ─────────────────────────────── webhooks ──────────────────────────────

export function listWebhooks(): Webhook[] {
  const rows = getDb()
    .prepare('SELECT * FROM webhooks ORDER BY created_at ASC')
    .all() as WebhookRow[];
  return rows.map(rowToWebhook);
}

export function getWebhook(id: string): Webhook | undefined {
  const row = getDb()
    .prepare('SELECT * FROM webhooks WHERE id = ?')
    .get(id) as WebhookRow | undefined;
  return row ? rowToWebhook(row) : undefined;
}

export function saveWebhook(w: Webhook): void {
  getDb()
    .prepare(
      `INSERT INTO webhooks
         (id, name, url, events, enabled, secret,
          created_at, last_triggered_at, failure_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         url = excluded.url,
         events = excluded.events,
         enabled = excluded.enabled,
         secret = excluded.secret,
         last_triggered_at = excluded.last_triggered_at,
         failure_count = excluded.failure_count`,
    )
    .run(
      w.id,
      w.name,
      w.url,
      JSON.stringify(w.events),
      w.enabled ? 1 : 0,
      w.secret,
      w.createdAt.toISOString(),
      w.lastTriggeredAt ? w.lastTriggeredAt.toISOString() : null,
      w.failureCount,
    );
}

export function deleteWebhook(id: string): boolean {
  const r = getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  return r.changes > 0;
}

export function countWebhooks(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM webhooks')
    .get() as { c: number };
  return row.c;
}

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string;
  enabled: number;
  secret: string;
  created_at: string;
  last_triggered_at: string | null;
  failure_count: number;
}

function rowToWebhook(r: WebhookRow): Webhook {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    events: JSON.parse(r.events) as string[],
    enabled: r.enabled === 1,
    secret: r.secret,
    createdAt: new Date(r.created_at),
    lastTriggeredAt: r.last_triggered_at ? new Date(r.last_triggered_at) : null,
    failureCount: r.failure_count,
  };
}

// ─────────────────────────────── settings ──────────────────────────────

const SETTINGS_KEY = 'server';

export function loadSettings(): PersistedSettings | undefined {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(SETTINGS_KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as PersistedSettings) : undefined;
}

export function saveSettings(s: PersistedSettings): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(SETTINGS_KEY, JSON.stringify(s));
}

// ────────────────────────── admin credentials ──────────────────────────

interface AdminCredentialsRow {
  username: string;
  password: string;       // legacy plaintext column (cleared on lazy migration)
  password_hash: string;  // scrypt hash (added in v2 migration)
  first_login_done: number;
  user_handle: Buffer | null;  // stable 16 bytes for WebAuthn (v3 migration)
}

// Internal: returns the raw row including the legacy plaintext column so
// the startup hook in index.ts can lazy-migrate v1 plaintext to scrypt
// AND ensure the v3 user_handle is populated. Buffer columns come back
// as Node Buffer instances from better-sqlite3 — we mint a fresh 16-byte
// handle here on first read if it's still NULL.
export function loadAdminCredentialsRaw(): {
  username: string;
  password: string;
  passwordHash: string;
  firstLoginDone: boolean;
  userHandle: Buffer;
} {
  const row = getDb()
    .prepare(
      'SELECT username, password, password_hash, first_login_done, user_handle FROM admin_credentials WHERE id = 1',
    )
    .get() as AdminCredentialsRow | undefined;
  if (!row) {
    return {
      username: '', password: '', passwordHash: '',
      firstLoginDone: false, userHandle: ensureUserHandle(null),
    };
  }
  return {
    username: row.username,
    password: row.password,
    passwordHash: row.password_hash,
    firstLoginDone: row.first_login_done === 1,
    userHandle: ensureUserHandle(row.user_handle),
  };
}

// First read after the v3 migration: user_handle is NULL. Mint a stable
// random 16-byte identifier and persist it. After this, subsequent reads
// return the same value forever (changing it would invalidate every
// registered passkey).
function ensureUserHandle(existing: Buffer | null): Buffer {
  if (existing && existing.length > 0) return existing;
  const handle = crypto.randomBytes(16);
  getDb()
    .prepare('UPDATE admin_credentials SET user_handle = ? WHERE id = 1')
    .run(handle);
  return handle;
}

export function loadAdminCredentials(): AdminCredentials {
  const r = loadAdminCredentialsRaw();
  return {
    username: r.username,
    passwordHash: r.passwordHash,
    firstLoginDone: r.firstLoginDone,
    userHandle: r.userHandle,
  };
}

export function saveAdminCredentials(c: AdminCredentials): void {
  // Always clear the legacy plaintext column on save — the lazy-migration
  // hook should already have done it, but this is the belt-and-braces.
  // user_handle is preserved (it's set by ensureUserHandle and never
  // overwritten here).
  getDb()
    .prepare(
      `UPDATE admin_credentials
         SET username = ?, password_hash = ?, first_login_done = ?, password = ''
         WHERE id = 1`,
    )
    .run(c.username, c.passwordHash, c.firstLoginDone ? 1 : 0);
}

// ──────────────────────── webauthn credentials ─────────────────────────

interface PasskeyRow {
  id: string;
  credential_id: Buffer;
  public_key: Buffer;
  counter: number;
  transports: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

function rowToPasskey(r: PasskeyRow): Passkey {
  return {
    id: r.id,
    credentialId: r.credential_id,
    publicKey: r.public_key,
    counter: r.counter,
    transports: JSON.parse(r.transports) as string[],
    label: r.label,
    createdAt: new Date(r.created_at),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
  };
}

export function listPasskeys(): Passkey[] {
  const rows = getDb()
    .prepare('SELECT * FROM webauthn_credentials ORDER BY created_at ASC')
    .all() as PasskeyRow[];
  return rows.map(rowToPasskey);
}

export function findPasskeyByCredentialId(credentialId: Buffer): Passkey | undefined {
  const row = getDb()
    .prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?')
    .get(credentialId) as PasskeyRow | undefined;
  return row ? rowToPasskey(row) : undefined;
}

export function savePasskey(p: Passkey): void {
  getDb()
    .prepare(
      `INSERT INTO webauthn_credentials
         (id, credential_id, public_key, counter, transports, label, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         counter = excluded.counter,
         label = excluded.label,
         last_used_at = excluded.last_used_at`,
    )
    .run(
      p.id, p.credentialId, p.publicKey, p.counter,
      JSON.stringify(p.transports), p.label,
      p.createdAt.toISOString(),
      p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
    );
}

export function deletePasskey(id: string): boolean {
  const r = getDb().prepare('DELETE FROM webauthn_credentials WHERE id = ?').run(id);
  return r.changes > 0;
}

export function deleteAllPasskeys(): number {
  const r = getDb().prepare('DELETE FROM webauthn_credentials').run();
  return r.changes;
}

// ──────────────────────────── admin sessions ───────────────────────────

interface AdminSessionRow {
  token: string;
  created_at: string;
  expires_at: string;
}

function rowToSession(r: AdminSessionRow): AdminSession {
  return {
    token: r.token,
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
  };
}

export function getAdminSession(token: string): AdminSession | undefined {
  const row = getDb()
    .prepare('SELECT * FROM admin_sessions WHERE token = ?')
    .get(token) as AdminSessionRow | undefined;
  return row ? rowToSession(row) : undefined;
}

export function saveAdminSession(s: AdminSession): void {
  getDb()
    .prepare(
      `INSERT INTO admin_sessions (token, created_at, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at`,
    )
    .run(s.token, s.createdAt.toISOString(), s.expiresAt.toISOString());
}

export function deleteAdminSession(token: string): boolean {
  const r = getDb().prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  return r.changes > 0;
}

// Reap expired sessions. Cheap (indexed on expires_at); call from the
// login handler after issuing a new session.
export function purgeExpiredAdminSessions(): number {
  const r = getDb()
    .prepare('DELETE FROM admin_sessions WHERE expires_at < ?')
    .run(new Date().toISOString());
  return r.changes;
}
