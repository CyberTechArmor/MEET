// LDAP / LDAPS directory integration.
//
// Two independent uses, both off by default (see LdapSettings):
//   1. requireForFrontend — participants must sign in against the directory
//      before the meeting UI will hand out a room token.
//   2. adminsEnabled — directory users listed in ldap_admins can sign in to
//      the admin panel with their directory password.
//
// Connection model: a short-lived ldapts Client per operation. Admin logins
// and picker searches are rare, so there's nothing to gain from pooling,
// and a settings change takes effect on the next call without a restart.
//
// Authentication is search-then-bind: bind with the service account (or
// anonymously when no bind DN is configured), find the user's DN via
// userFilter, then bind AS THE USER with the supplied password on a fresh
// connection. Empty passwords are rejected up front — many directories
// treat an empty-password bind as a successful anonymous bind.

import { Client } from 'ldapts';
import type { Entry } from 'ldapts';
import * as tls from 'tls';
import type { LdapSettings } from './types.js';

export class LdapError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface LdapUser {
  dn: string;
  username: string;
  displayName: string;
  email: string;
}

export const LDAP_DEFAULTS: LdapSettings = {
  enabled: false,
  url: '',
  startTls: false,
  tlsRejectUnauthorized: true,
  caCert: '',
  bindDn: '',
  bindPassword: '',
  baseDn: '',
  userFilter: '(&(|(objectClass=person)(objectClass=user))(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}})))',
  searchFilter: '(&(|(objectClass=person)(objectClass=user))(|(uid=*{{q}}*)(sAMAccountName=*{{q}}*)(cn=*{{q}}*)(displayName=*{{q}}*)(mail=*{{q}}*)))',
  usernameAttribute: 'uid',
  displayNameAttribute: 'displayName',
  emailAttribute: 'mail',
  timeoutMs: 8000,
  requireForFrontend: false,
  adminsEnabled: false,
};

// Everything needed to actually talk to the directory.
export function isLdapConfigured(s: LdapSettings | null | undefined): s is LdapSettings {
  return !!s && !!s.url && !!s.baseDn && !!s.userFilter;
}

export function isLdapActive(s: LdapSettings | null | undefined): s is LdapSettings {
  return isLdapConfigured(s) && s.enabled;
}

export function isValidLdapUrl(url: string): boolean {
  return /^ldaps?:\/\/[^\s/]+$/i.test(url);
}

// RFC 4515 filter-value escaping. Anything a user types goes through this
// before being spliced into a filter — otherwise "*)(uid=*" is an
// injection.
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => {
    switch (c) {
      case '\\': return '\\5c';
      case '*': return '\\2a';
      case '(': return '\\28';
      case ')': return '\\29';
      default: return '\\00';
    }
  });
}

function attrToString(v: Entry[string] | undefined): string {
  if (v === undefined) return '';
  if (Array.isArray(v)) {
    const first = v[0];
    return first === undefined ? '' : Buffer.isBuffer(first) ? first.toString('utf8') : String(first);
  }
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

function entryToUser(s: LdapSettings, e: Entry): LdapUser {
  const username = attrToString(e[s.usernameAttribute])
    || attrToString(e['sAMAccountName'])
    || attrToString(e['uid']);
  const displayName = attrToString(e[s.displayNameAttribute])
    || attrToString(e['cn'])
    || username;
  const email = attrToString(e[s.emailAttribute]) || attrToString(e['mail']);
  return { dn: e.dn, username, displayName, email };
}

function attributesFor(s: LdapSettings): string[] {
  return Array.from(new Set([
    s.usernameAttribute, s.displayNameAttribute, s.emailAttribute,
    'uid', 'sAMAccountName', 'cn', 'mail',
  ].filter(Boolean)));
}

function tlsOptions(s: LdapSettings): tls.ConnectionOptions {
  const opts: tls.ConnectionOptions = { rejectUnauthorized: s.tlsRejectUnauthorized };
  if (s.caCert.trim()) opts.ca = s.caCert;
  // SNI for hostname-based certs.
  try {
    const host = new URL(s.url).hostname;
    if (host && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) opts.servername = host;
  } catch { /* url validated elsewhere */ }
  return opts;
}

function buildClient(s: LdapSettings): Client {
  // ldapts treats ANY defined tlsOptions value as "connect with TLS", so
  // only pass them for ldaps:// — a plain ldap:// connection (with or
  // without StartTLS, which gets its own options) must start in cleartext.
  const secure = s.url.toLowerCase().startsWith('ldaps://');
  return new Client({
    url: s.url,
    timeout: s.timeoutMs,
    connectTimeout: s.timeoutMs,
    ...(secure ? { tlsOptions: tlsOptions(s) } : {}),
    strictDN: false,
  });
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: string }).code;
    return code ? `${e.message} (${code})` : e.message;
  }
  return String(e);
}

// Open a connection (StartTLS if requested), run fn, always unbind.
async function withClient<T>(s: LdapSettings, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = buildClient(s);
  try {
    if (s.startTls && s.url.toLowerCase().startsWith('ldap://')) {
      await client.startTLS(tlsOptions(s));
    }
    return await fn(client);
  } finally {
    try { await client.unbind(); } catch { /* ignore */ }
  }
}

async function bindService(s: LdapSettings, c: Client): Promise<void> {
  if (!s.bindDn) return; // anonymous
  try {
    await c.bind(s.bindDn, s.bindPassword);
  } catch (e) {
    throw new LdapError(`Service account bind failed: ${describe(e)}`, 502);
  }
}

// ─────────────────────────────── operations ────────────────────────────

export interface TestResult {
  ok: true;
  message: string;
  matchedUsers: number;
}

// Connect, bind as the service account, and run the search filter once to
// prove baseDn + filter are sane. Returns how many user entries the first
// page of a wildcard search yields.
export async function testConnection(s: LdapSettings): Promise<TestResult> {
  return withClient(s, async (c) => {
    await bindService(s, c);
    let count = 0;
    try {
      const filter = s.searchFilter.replace(/\{\{q\}\}/g, '');
      const r = await c.search(s.baseDn, {
        scope: 'sub', filter, attributes: ['1.1'], sizeLimit: 10,
      });
      count = r.searchEntries.length;
    } catch (e) {
      // Some servers return SizeLimitExceeded even when entries came back;
      // ldapts throws for that. Treat "found some" as success.
      const partial = (e as { searchEntries?: unknown[] }).searchEntries;
      if (Array.isArray(partial) && partial.length > 0) {
        count = partial.length;
      } else {
        throw new LdapError(`Connected and bound, but the search failed: ${describe(e)}`, 502);
      }
    }
    return {
      ok: true,
      message: `Connected${s.bindDn ? ` and bound as ${s.bindDn}` : ' (anonymous bind)'}; search under ${s.baseDn} returned ${count} user(s)${count >= 10 ? ' (first 10)' : ''}.`,
      matchedUsers: count,
    };
  });
}

export async function findUser(s: LdapSettings, username: string): Promise<LdapUser | null> {
  const clean = username.trim();
  if (!clean) return null;
  const filter = s.userFilter.replace(/\{\{username\}\}/g, escapeFilterValue(clean));
  return withClient(s, async (c) => {
    await bindService(s, c);
    let entries: Entry[];
    try {
      const r = await c.search(s.baseDn, {
        scope: 'sub', filter, attributes: attributesFor(s), sizeLimit: 2,
      });
      entries = r.searchEntries;
    } catch (e) {
      throw new LdapError(`Directory search failed: ${describe(e)}`, 502);
    }
    if (entries.length === 0) return null;
    if (entries.length > 1) {
      throw new LdapError('Directory search matched more than one user for that name', 502);
    }
    return entryToUser(s, entries[0]);
  });
}

export async function lookupDn(s: LdapSettings, dn: string): Promise<LdapUser | null> {
  return withClient(s, async (c) => {
    await bindService(s, c);
    try {
      const r = await c.search(dn, { scope: 'base', filter: '(objectClass=*)', attributes: attributesFor(s), sizeLimit: 1 });
      return r.searchEntries.length ? entryToUser(s, r.searchEntries[0]) : null;
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 32) return null; // noSuchObject
      throw new LdapError(`Directory lookup failed: ${describe(e)}`, 502);
    }
  });
}

// Verify username + password. Returns the user on success; throws
// LdapError(401) on bad credentials and LdapError(502) on directory
// trouble, so callers can tell "wrong password" from "LDAP is down".
export async function authenticate(s: LdapSettings, username: string, password: string): Promise<LdapUser> {
  if (!password) throw new LdapError('Invalid username or password', 401);
  const user = await findUser(s, username);
  if (!user) throw new LdapError('Invalid username or password', 401);
  await withClient(s, async (c) => {
    try {
      await c.bind(user.dn, password);
    } catch (e) {
      const code = (e as { code?: number }).code;
      // 49 = invalidCredentials. Anything else is a directory problem.
      if (code === 49 || /invalid credentials/i.test(describe(e))) {
        throw new LdapError('Invalid username or password', 401);
      }
      throw new LdapError(`Directory bind failed: ${describe(e)}`, 502);
    }
  });
  return user;
}

export async function searchUsers(s: LdapSettings, q: string, limit = 25): Promise<LdapUser[]> {
  const clean = q.trim();
  const filter = s.searchFilter.replace(/\{\{q\}\}/g, escapeFilterValue(clean));
  return withClient(s, async (c) => {
    await bindService(s, c);
    let entries: Entry[] = [];
    try {
      const r = await c.search(s.baseDn, {
        scope: 'sub', filter, attributes: attributesFor(s), sizeLimit: limit,
      });
      entries = r.searchEntries;
    } catch (e) {
      const partial = (e as { searchEntries?: Entry[] }).searchEntries;
      if (Array.isArray(partial)) entries = partial;
      else throw new LdapError(`Directory search failed: ${describe(e)}`, 502);
    }
    return entries.map((e) => entryToUser(s, e)).sort((a, b) => a.displayName.localeCompare(b.displayName));
  });
}
