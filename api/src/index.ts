import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const app = express();
const server = http.createServer(app);

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 8080;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'http://localhost:7880';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// Admin configuration
// MEET_ADMIN_USERNAME/MEET_ADMIN_PASSWORD: If not set, first login sets credentials
const ADMIN_USERNAME = process.env.MEET_ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.MEET_ADMIN_PASSWORD || '';

const API_VERSION = '1.0.0';
const SERVER_START_TIME = Date.now();

// Initialize RoomServiceClient for room management
const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// ============================================================================
// PERSISTENT STORAGE
// ============================================================================
//
// API keys, webhooks, server settings, and admin credentials live in SQLite
// at ${MEET_DATA_DIR:-/data}/meet.db so they survive
// `docker compose down && up`. CRUD goes through ./store; this file keeps
// hot caches only for the per-request settings reads.
//
// Admin sessions stay in memory: they're TTL-bound (24h) and re-issued on
// login, so losing them on restart is acceptable. Room metadata is also
// transient (display names while a room exists).

import type { ApiKey, Webhook, PersistedSettings, VideoQualityPreset, SmtpSettings, LdapSettings } from './types.js';
import { isValidVideoQuality, VIDEO_QUALITY_PRESET_VALUES } from './types.js';
import * as store from './store.js';
import { getDb } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import * as webauthn from './webauthn.js';
import * as mailer from './mailer.js';
import * as otp from './otp.js';
import * as ldap from './ldap.js';

// Open the database before anything else can touch it.
getDb();

// Configure WebAuthn from the public-facing URL. Three-domain mode passes
// the API URL as an extra origin so a passkey registered against
// meet.<host> can also be used when the SPA is served by api.<host>.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || '';
const PUBLIC_LIVEKIT_URL = process.env.PUBLIC_LIVEKIT_URL || '';
webauthn.configureWebAuthn(PUBLIC_BASE_URL, [PUBLIC_API_URL, PUBLIC_LIVEKIT_URL]);

// TURN — coturn lives in the same compose stack. We don't talk to it
// directly; we just embed its URL + creds in the iceServers field of
// every /api/token response so the browser's RTCPeerConnection adds it
// to its ICE candidate pool. When TURN_ENABLED=false, omit the field
// entirely (no STUN/TURN ICE servers — the client falls back to its
// browser defaults, which is fine for wifi).
const TURN_ENABLED = (process.env.TURN_ENABLED || 'false').toLowerCase() === 'true';
const TURN_DOMAIN = process.env.TURN_DOMAIN || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_PASSWORD = process.env.TURN_PASSWORD || '';
const TURN_TLS_PORT = parseInt(process.env.TURN_TLS_PORT || '5349', 10);
const TURN_UDP_PORT = parseInt(process.env.TURN_UDP_PORT || '3478', 10);

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

function buildIceServers(): IceServer[] | undefined {
  if (!TURN_ENABLED || !TURN_DOMAIN || !TURN_USERNAME || !TURN_PASSWORD) {
    return undefined;
  }
  // Order matters: browsers try ICE candidates in roughly the order
  // they're advertised. Put TURN/TLS first because it's the most
  // restrictive-network-friendly path; then UDP (faster when it works),
  // then TCP via the same TLS port. STUN is bundled separately by the
  // browser; we don't override it here.
  return [
    {
      urls: [
        `turns:${TURN_DOMAIN}:${TURN_TLS_PORT}?transport=tcp`,
        `turn:${TURN_DOMAIN}:${TURN_UDP_PORT}?transport=udp`,
        `turn:${TURN_DOMAIN}:${TURN_TLS_PORT}?transport=tcp`,
      ],
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    },
  ];
}

// Lazy-migrate any v1 plaintext admin password into the v2 password_hash
// column. Runs once per process; subsequent reads see only the hash.
{
  const raw = store.loadAdminCredentialsRaw();
  if (raw.password && !raw.passwordHash) {
    const hash = hashPassword(raw.password);
    store.saveAdminCredentials({
      username: raw.username,
      passwordHash: hash,
      firstLoginDone: raw.firstLoginDone,
      userHandle: raw.userHandle,
    });
    console.log('[migration] hashed legacy plaintext admin password (scrypt)');
  }
}

// Room metadata for display names — transient.
// videoQuality, when set, overrides the platform default for any token
// minted against this room. Lost across restarts; re-set per room via the
// admin API or implicitly when a room is created with `quality`.
interface RoomMetadata {
  displayName: string;
  createdAt: Date;
  videoQuality?: VideoQualityPreset;
}

// Admin credentials. Resolved with this priority:
//   env vars (if both set)  >  values previously stored in db  >  empty
// "First login" mode is on whenever neither the env nor the db gives us
// a complete pair. Passwords (whether from env or db) are kept as scrypt
// hashes in adminPasswordHash; verifyPassword() compares with timing-safe
// equality.
let adminUsername: string;
let adminPasswordHash: string;
let isFirstLogin: boolean;
{
  const stored = store.loadAdminCredentials();
  if (ADMIN_USERNAME && ADMIN_PASSWORD) {
    // Hash env-supplied password fresh on every boot. We never persist this
    // hash to the db — env is source of truth when set.
    adminUsername = ADMIN_USERNAME;
    adminPasswordHash = hashPassword(ADMIN_PASSWORD);
    isFirstLogin = false;
  } else if (stored.username && stored.passwordHash) {
    adminUsername = stored.username;
    adminPasswordHash = stored.passwordHash;
    isFirstLogin = false;
  } else {
    adminUsername = '';
    adminPasswordHash = '';
    isFirstLogin = true;
  }
}

const roomMetadata: Map<string, RoomMetadata> = new Map();

// Email (SMTP) settings for one-time sign-in codes. In-memory hot copy of
// the persisted blob; every mutation writes through to SQLite.
let smtpSettings: SmtpSettings | null = store.loadSmtpSettings() ?? null;

// Email sign-in is only offered once the admin has proven the SMTP config
// works by completing a test code round trip (`verified`). This is also
// the exact condition under which password login is switched off, so an
// unreachable mail server can never lock the admin out.
function smtpVerified(): boolean {
  return !!smtpSettings && smtpSettings.verified && mailer.isSmtpComplete(smtpSettings);
}

// Directory (LDAP) settings. Off by default; persisted under settings key
// 'ldap'. Old blobs are merged over the defaults so new fields pick up
// sane values.
let ldapSettings: LdapSettings = { ...ldap.LDAP_DEFAULTS, ...(store.loadLdapSettings() ?? {}) };

// The built-in ("local") account can be switched off by a directory
// admin. Every local credential — password, passkeys, emailed codes —
// is refused while it is off. Cached here; written through on change.
let localAccountDisabled = store.loadAdminCredentials().localDisabled;

function localAccountEnabled(): boolean {
  return !localAccountDisabled;
}

function ldapActive(): boolean {
  return ldap.isLdapActive(ldapSettings);
}

// Directory users listed in ldap_admins may sign in to the admin panel.
function ldapAdminsActive(): boolean {
  return ldapActive() && ldapSettings.adminsEnabled;
}

// Participants must sign in against the directory before /api/token
// hands out a room token (API-key callers are exempt).
function ldapRequiredForFrontend(): boolean {
  return ldapActive() && ldapSettings.requireForFrontend;
}

function otpLoginAvailable(): boolean {
  return localAccountEnabled() && smtpVerified();
}

function passwordLoginEnabled(): boolean {
  return localAccountEnabled() && !smtpVerified();
}

function ldapView() {
  const s = ldapSettings;
  return {
    configured: ldap.isLdapConfigured(s),
    active: ldapActive(),
    adminsActive: ldapAdminsActive(),
    requiredForFrontend: ldapRequiredForFrontend(),
    localAccountEnabled: localAccountEnabled(),
    ldapAdminCount: store.countLdapAdmins(),
    settings: {
      enabled: s.enabled,
      url: s.url,
      startTls: s.startTls,
      tlsRejectUnauthorized: s.tlsRejectUnauthorized,
      caCert: s.caCert,
      bindDn: s.bindDn,
      hasBindPassword: !!s.bindPassword,
      baseDn: s.baseDn,
      userFilter: s.userFilter,
      searchFilter: s.searchFilter,
      usernameAttribute: s.usernameAttribute,
      displayNameAttribute: s.displayNameAttribute,
      emailAttribute: s.emailAttribute,
      timeoutMs: s.timeoutMs,
      requireForFrontend: s.requireForFrontend,
      adminsEnabled: s.adminsEnabled,
    },
  };
}

function sendLdapError(res: Response, e: unknown): void {
  if (e instanceof ldap.LdapError) {
    res.status(e.statusCode).json({ error: e.message });
    return;
  }
  console.error('LDAP error:', e);
  res.status(502).json({ error: 'Directory error' });
}

function ldapAdminToJson(a: import('./types.js').LdapAdmin) {
  return {
    id: a.id,
    dn: a.dn,
    username: a.username,
    displayName: a.displayName,
    email: a.email,
    addedBy: a.addedBy,
    createdAt: a.createdAt.toISOString(),
    lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
  };
}

// Frontend (participant) auth when the meeting UI is gated behind the
// directory: accept a participant session or an admin session as Bearer.
function bearerToken(req: { headers: Request['headers'] }): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.substring(7) : null;
}

function participantSessionFromRequest(req: { headers: Request['headers'] }): { username: string; displayName: string } | null {
  const token = bearerToken(req);
  if (!token) return null;
  const us = store.getUserSession(token);
  if (us && us.expiresAt > new Date()) return { username: us.username, displayName: us.displayName };
  const as = store.getAdminSession(token);
  if (as && as.expiresAt > new Date()) return { username: as.displayName || 'admin', displayName: as.displayName || 'admin' };
  return null;
}

function smtpView() {
  const s = smtpSettings;
  return {
    configured: mailer.isSmtpComplete(s),
    verified: !!s?.verified,
    passwordLoginEnabled: passwordLoginEnabled(),
    settings: s
      ? {
          host: s.host,
          port: s.port,
          secure: s.secure,
          username: s.username,
          hasPassword: !!s.password,
          fromAddress: s.fromAddress,
          adminEmail: s.adminEmail,
          verified: s.verified,
          verifiedAt: s.verifiedAt,
        }
      : null,
  };
}

function sendOtpError(res: Response, e: unknown): void {
  if (e instanceof otp.OtpError) {
    if (e.retryAfterSeconds) res.setHeader('Retry-After', String(e.retryAfterSeconds));
    res.status(e.statusCode).json({ error: e.message });
    return;
  }
  console.error('OTP error:', e);
  res.status(500).json({ error: 'One-time code error' });
}

// Server settings
interface ServerSettings {
  publicAccessEnabled: boolean;
  maxParticipantsPerMeeting: number; // 0 = unlimited
  maxConcurrentMeetings: number; // 0 = unlimited
  recommendedMaxParticipants: number;
  recommendedMaxMeetings: number;
  iframeAllowedDomains: string[]; // Empty array = allow all (*)
  defaultVideoQuality: VideoQualityPreset; // platform-wide default
}

// Calculate recommended limits based on available resources
function getRecommendedLimits(): { participants: number; meetings: number } {
  // Estimate based on typical server resources
  // Each participant uses ~2-5 Mbps bandwidth and ~100MB RAM
  // These are conservative estimates for a typical cloud VM
  const estimatedRAMGB = 4; // Assume 4GB available for meetings
  const estimatedBandwidthMbps = 100; // Assume 100 Mbps

  // ~100MB per participant, so 4GB = ~40 participants total
  // ~3 Mbps per participant (average), so 100 Mbps = ~33 participants total
  const byRAM = Math.floor(estimatedRAMGB * 1024 / 100);
  const byBandwidth = Math.floor(estimatedBandwidthMbps / 3);

  const recommendedParticipants = Math.min(byRAM, byBandwidth, 50); // Cap at 50 per meeting
  const recommendedMeetings = Math.max(5, Math.floor(recommendedParticipants / 10)); // ~10 participants per meeting avg

  return {
    participants: recommendedParticipants,
    meetings: recommendedMeetings,
  };
}

const recommendedLimits = getRecommendedLimits();

// Load persisted settings or fall back to defaults; either way save back so
// subsequent reads bypass the defaults.
const SETTINGS_DEFAULTS: PersistedSettings = {
  publicAccessEnabled: true,
  maxParticipantsPerMeeting: 0, // 0 = unlimited
  maxConcurrentMeetings: 0, // 0 = unlimited
  iframeAllowedDomains: [], // Empty = allow all domains (*)
  defaultVideoQuality: 'auto', // dynamic — pushes the highest layer the network sustains
};
// Old persisted blobs predate defaultVideoQuality; merge with defaults so
// fields added by a later schema version pick up sensible values without
// requiring a forced settings save.
const persistedRaw = store.loadSettings();
const persistedSettings: PersistedSettings = persistedRaw
  ? { ...SETTINGS_DEFAULTS, ...persistedRaw }
  : SETTINGS_DEFAULTS;
if (!persistedRaw) store.saveSettings(persistedSettings);

// In-memory hot copy. The middleware at line ~245 reads serverSettings on
// every request, so a per-request SQLite read would matter; we keep this
// object as the source of truth at runtime and persist on every mutation.
// recommendedMax* are derived at startup and are not persisted.
const serverSettings: ServerSettings = {
  ...persistedSettings,
  recommendedMaxParticipants: recommendedLimits.participants,
  recommendedMaxMeetings: recommendedLimits.meetings,
};

function persistServerSettings(): void {
  store.saveSettings({
    publicAccessEnabled: serverSettings.publicAccessEnabled,
    maxParticipantsPerMeeting: serverSettings.maxParticipantsPerMeeting,
    maxConcurrentMeetings: serverSettings.maxConcurrentMeetings,
    iframeAllowedDomains: serverSettings.iframeAllowedDomains,
    defaultVideoQuality: serverSettings.defaultVideoQuality,
  });
}

// Webhook event types
const WEBHOOK_EVENTS = [
  'room.created',
  'room.deleted',
  'participant.joined',
  'participant.left',
  'recording.started',
  'recording.stopped',
] as const;

type WebhookEventType = typeof WEBHOOK_EVENTS[number];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateId(): string {
  return crypto.randomBytes(12).toString('hex');
}

function generateApiKey(): string {
  return `mk_${crypto.randomBytes(24).toString('hex')}`;
}

function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashString(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function maskApiKey(key: string): string {
  return key.substring(0, 11) + '...' + key.substring(key.length - 4);
}

function maskSecret(secret: string): string {
  return secret.substring(0, 9) + '...' + secret.substring(secret.length - 4);
}

// ============================================================================
// WEBHOOK DISPATCHER
// ============================================================================

interface WebhookPayload {
  id: string;
  type: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

async function triggerWebhooks(eventType: WebhookEventType, data: Record<string, unknown>): Promise<void> {
  const payload: WebhookPayload = {
    id: generateId(),
    type: eventType,
    timestamp: new Date().toISOString(),
    data,
  };

  for (const webhook of store.listWebhooks()) {
    if (!webhook.enabled || !webhook.events.includes(eventType)) {
      continue;
    }

    try {
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(JSON.stringify(payload))
        .digest('hex');

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': eventType,
          'X-Webhook-Id': payload.id,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      webhook.lastTriggeredAt = new Date();

      if (!response.ok) {
        webhook.failureCount++;
        console.error(`Webhook ${webhook.id} failed: ${response.status}`);
      } else {
        webhook.failureCount = 0;
      }
    } catch (error) {
      webhook.failureCount++;
      console.error(`Webhook ${webhook.id} error:`, error);
    }
    store.saveWebhook(webhook);
  }
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

// CORS configuration
const corsOptions: cors.CorsOptions = {
  origin: CORS_ORIGIN === '*'
    ? true
    : CORS_ORIGIN.includes(',')
      ? CORS_ORIGIN.split(',').map(o => o.trim())
      : CORS_ORIGIN,
  credentials: CORS_ORIGIN !== '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
};

app.use(cors(corsOptions));
app.use(express.json());

// CSP frame-ancestors middleware for iframe embedding control
app.use((_req: Request, res: Response, next: NextFunction) => {
  // Build frame-ancestors directive based on settings
  let frameAncestors: string;
  if (serverSettings.iframeAllowedDomains.length === 0) {
    // Empty array = allow all domains
    frameAncestors = '*';
  } else {
    // Specific domains + self
    frameAncestors = `'self' ${serverSettings.iframeAllowedDomains.join(' ')}`;
  }

  // Set CSP header with frame-ancestors
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  // Remove X-Frame-Options as CSP frame-ancestors takes precedence
  res.removeHeader('X-Frame-Options');
  next();
});

// Authentication middleware
interface AuthRequest extends Request {
  isAdmin?: boolean;
  apiKey?: ApiKey;
  // 'local', 'ldap:<dn>' or 'apikey:<id>' — who is calling.
  principal?: string;
}

function authenticateAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'] as string;

  // Check API key first
  if (apiKeyHeader) {
    const keyHash = hashString(apiKeyHeader);
    const apiKey = store.findApiKeyByHash(keyHash);
    if (apiKey) {
      apiKey.lastUsedAt = new Date();
      store.saveApiKey(apiKey);
      req.apiKey = apiKey;
      req.isAdmin = apiKey.permissions.includes('admin');
      req.principal = `apikey:${apiKey.id}`;
      next();
      return;
    }
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  // Check Bearer token (session token or password)
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    // Check if it's a session token
    const session = store.getAdminSession(token);
    if (session && session.expiresAt > new Date()) {
      req.isAdmin = true;
      req.principal = session.principal;
      next();
      return;
    }

    // Check if it's the admin password (sent as plaintext Bearer; verified
    // against the scrypt hash with timing-safe equality).
    if (passwordLoginEnabled() && adminPasswordHash && verifyPassword(token, adminPasswordHash)) {
      req.isAdmin = true;
      req.principal = 'local';
      next();
      return;
    }
  }

  res.status(401).json({ error: 'Unauthorized' });
}

function authenticateApiKeyOrAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'] as string;

  // Check API key
  if (apiKeyHeader) {
    const keyHash = hashString(apiKeyHeader);
    const apiKey = store.findApiKeyByHash(keyHash);
    if (apiKey) {
      apiKey.lastUsedAt = new Date();
      store.saveApiKey(apiKey);
      req.apiKey = apiKey;
      next();
      return;
    }
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  // Check Bearer token
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const session = store.getAdminSession(token);
    if (session && session.expiresAt > new Date()) {
      req.isAdmin = true;
      req.principal = session.principal;
      next();
      return;
    }
    if (passwordLoginEnabled() && adminPasswordHash && verifyPassword(token, adminPasswordHash)) {
      req.isAdmin = true;
      req.principal = 'local';
      next();
      return;
    }
  }

  res.status(401).json({ error: 'Unauthorized' });
}

// ============================================================================
// PUBLIC ENDPOINTS
// ============================================================================

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: API_VERSION,
  });
});

// Public status endpoint (no auth required) - returns whether public access is enabled
app.get('/api/status', (_req: Request, res: Response) => {
  res.json({
    publicAccessEnabled: serverSettings.publicAccessEnabled,
    defaultVideoQuality: serverSettings.defaultVideoQuality,
    // When true the web app must obtain a participant session via
    // POST /api/auth/ldap/login before /api/token will answer.
    ldapRequired: ldapRequiredForFrontend(),
    version: API_VERSION,
  });
});

// ───────────────────── participant directory sign-in ───────────────────
//
// Only meaningful when the meeting frontend is gated behind LDAP. Issues a
// 12-hour participant session the SPA sends as Bearer on /api/token and
// /api/room-code. Admin sessions are accepted there too.
interface LdapUserLoginBody {
  username: string;
  password: string;
}

app.post('/api/auth/ldap/login', async (req: Request<object, object, LdapUserLoginBody>, res: Response) => {
  if (!ldapActive()) {
    res.status(404).json({ error: 'Directory sign-in is not enabled' });
    return;
  }
  const { username, password } = req.body ?? {};
  if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }
  let user: ldap.LdapUser;
  try {
    user = await ldap.authenticate(ldapSettings, username, password);
  } catch (e) {
    sendLdapError(res, e);
    return;
  }
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  store.saveUserSession({
    token, dn: user.dn, username: user.username, displayName: user.displayName,
    createdAt: new Date(), expiresAt,
  });
  store.purgeExpiredUserSessions();
  res.json({
    success: true,
    token,
    expiresAt: expiresAt.toISOString(),
    username: user.username,
    displayName: user.displayName,
  });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const who = participantSessionFromRequest(req);
  if (!who) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  res.json({ ...who, ldapRequired: ldapRequiredForFrontend() });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const token = bearerToken(req);
  if (token) store.deleteUserSession(token);
  res.json({ success: true });
});

// OpenAPI Documentation
const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'MEET Video Conferencing API',
    description: `
## Overview
MEET is a WebRTC-based video conferencing API powered by LiveKit. This API allows you to:
- Generate room tokens for participants
- Manage active rooms and participants
- Configure webhooks for real-time event notifications
- Manage API keys for programmatic access

## Authentication
Most endpoints require authentication via one of:
- **Bearer Token**: Admin session token from \`/api/admin/login\`
- **API Key**: Pass in \`X-API-Key\` header

## Webhooks
Configure webhooks to receive real-time notifications for events like:
- Room created/deleted
- Participant joined/left
- Recording started/stopped
    `,
    version: '1.0.0',
    contact: {
      name: 'MEET Support',
    },
  },
  servers: [
    {
      url: '/',
      description: 'Current server',
    },
  ],
  tags: [
    { name: 'Public', description: 'Public endpoints for meeting participants' },
    { name: 'Admin', description: 'Admin authentication and management' },
    { name: 'Sign-in', description: 'Sign-in methods, email one-time codes and SMTP configuration' },
    { name: 'Directory', description: 'LDAP / LDAPS integration: settings, LDAP admins, local account switch, participant sign-in' },
    { name: 'Rooms', description: 'Room management' },
    { name: 'API Keys', description: 'API key management' },
    { name: 'Webhooks', description: 'Webhook configuration' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Public'],
        summary: 'Health check',
        description: 'Check if the API server is running',
        responses: {
          '200': {
            description: 'Server is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    timestamp: { type: 'string', format: 'date-time' },
                    version: { type: 'string', example: '1.0.0' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/status': {
      get: {
        tags: ['Public'],
        summary: 'Public access status',
        description: 'Check if the public web interface is enabled. No authentication required.',
        responses: {
          '200': {
            description: 'Public access status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    publicAccessEnabled: { type: 'boolean', description: 'Whether public (non-API) access is allowed' },
                    defaultVideoQuality: {
                      type: 'string',
                      enum: ['auto', 'high', 'max', 'balanced', 'low'],
                      description: 'Platform-wide default video quality preset.',
                    },
                    version: { type: 'string', example: '1.0.0' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/token': {
      post: {
        tags: ['Public'],
        summary: 'Generate room token',
        description: 'Generate a LiveKit access token to join a room',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['roomName', 'participantName'],
                properties: {
                  roomName: { type: 'string', description: 'Room code/name', example: 'ABC123' },
                  participantName: { type: 'string', description: 'Display name', example: 'John Doe' },
                  deviceId: { type: 'string', description: 'Optional device identifier' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Token generated successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    token: { type: 'string', description: 'LiveKit JWT token' },
                    roomName: { type: 'string' },
                    participantName: { type: 'string' },
                    participantIdentity: { type: 'string' },
                    isHost: { type: 'boolean' },
                    quality: {
                      type: 'string',
                      enum: ['auto', 'high', 'max', 'balanced', 'low'],
                      description: 'Video quality preset chosen for this participant. Per-room override (set when the room was created) wins over the platform default. The frontend should call setVideoQualityPreset(quality) before connecting.',
                    },
                    iceServers: {
                      type: 'array',
                      description: 'Optional. When TURN is configured server-side, this contains the TURN server URL(s) + ephemeral credentials the browser should pass to RTCPeerConnection.iceServers. Omitted entirely when TURN is disabled.',
                      items: {
                        type: 'object',
                        properties: {
                          urls: { type: 'array', items: { type: 'string' } },
                          username: { type: 'string' },
                          credential: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid request parameters' },
        },
      },
    },
    '/api/room-code': {
      get: {
        tags: ['Public'],
        summary: 'Generate random room code',
        description: 'Generate a random 6-character room code',
        responses: {
          '200': {
            description: 'Room code generated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    roomCode: { type: 'string', example: 'ABC123' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/end-meeting': {
      post: {
        tags: ['Public'],
        summary: 'End meeting for all',
        description: 'End the meeting and disconnect all participants (host only)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['roomName', 'participantIdentity'],
                properties: {
                  roomName: { type: 'string' },
                  participantIdentity: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Meeting ended successfully' },
          '500': { description: 'Failed to end meeting' },
        },
      },
    },
    '/api/admin/login': {
      post: {
        tags: ['Admin'],
        summary: 'Admin login',
        description: 'Login with admin credentials. First login sets the credentials.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Login successful',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    token: { type: 'string', description: 'Session token (24h validity)' },
                    expiresAt: { type: 'string', format: 'date-time' },
                    isFirstLogin: { type: 'boolean' },
                  },
                },
              },
            },
          },
          '401': { description: 'Invalid credentials' },
          '403': { description: 'Password login is disabled (email sign-in verified). Use a passkey or /api/admin/otp/request.' },
        },
      },
    },
    '/api/admin/auth/methods': {
      get: {
        tags: ['Sign-in'],
        summary: 'Available sign-in methods',
        description: 'Which credentials the admin account currently accepts. Password login is switched off automatically once email sign-in (SMTP) has been verified.',
        responses: {
          '200': {
            description: 'Sign-in methods',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    password: { type: 'boolean' },
                    passkey: { type: 'boolean', description: 'Passkeys configured and at least one registered' },
                    otp: { type: 'boolean', description: 'Email one-time codes available' },
                    firstLogin: { type: 'boolean' },
                    otpEmail: { type: 'string', description: 'Masked recipient address, only when otp is true' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/admin/otp/request': {
      post: {
        tags: ['Sign-in'],
        summary: 'Email a one-time sign-in code',
        description: 'Sends a 6-digit code to the configured admin address. Rate-limited to one code per 30 seconds; a new code invalidates the previous one.',
        responses: {
          '200': {
            description: 'Code sent',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    ticket: { type: 'string', description: 'Pass back to /api/admin/otp/verify' },
                    expiresAt: { type: 'string', format: 'date-time' },
                    email: { type: 'string', description: 'Masked recipient address' },
                  },
                },
              },
            },
          },
          '404': { description: 'Email sign-in not set up' },
          '429': { description: 'Requested too soon' },
          '502': { description: 'SMTP send failed' },
        },
      },
    },
    '/api/admin/otp/verify': {
      post: {
        tags: ['Sign-in'],
        summary: 'Exchange a one-time code for a session',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ticket', 'code'],
                properties: {
                  ticket: { type: 'string' },
                  code: { type: 'string', description: '6 digits' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Session issued (same shape as /api/admin/login)' },
          '400': { description: 'Ticket expired or invalid' },
          '401': { description: 'Incorrect code' },
          '429': { description: 'Too many attempts' },
        },
      },
    },
    '/api/admin/smtp': {
      get: {
        tags: ['Sign-in'],
        summary: 'Get SMTP settings',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'SMTP settings (password never returned; hasPassword indicates one is stored)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    configured: { type: 'boolean' },
                    verified: { type: 'boolean' },
                    passwordLoginEnabled: { type: 'boolean' },
                    settings: {
                      type: 'object',
                      nullable: true,
                      properties: {
                        host: { type: 'string' },
                        port: { type: 'integer' },
                        secure: { type: 'boolean', description: 'Implicit TLS (465) vs STARTTLS/plain' },
                        username: { type: 'string' },
                        hasPassword: { type: 'boolean' },
                        fromAddress: { type: 'string' },
                        adminEmail: { type: 'string' },
                        verified: { type: 'boolean' },
                        verifiedAt: { type: 'string', format: 'date-time', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      put: {
        tags: ['Sign-in'],
        summary: 'Update SMTP settings',
        description: 'Partial update. Changing any delivery field resets `verified`, which re-enables password login until a new test code is confirmed. Omit or send an empty password to keep the stored one.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  host: { type: 'string' },
                  port: { type: 'integer' },
                  secure: { type: 'boolean' },
                  username: { type: 'string' },
                  password: { type: 'string' },
                  fromAddress: { type: 'string', format: 'email' },
                  adminEmail: { type: 'string', format: 'email', description: 'Where sign-in codes are delivered' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Saved' },
          '400': { description: 'Validation error' },
        },
      },
      delete: {
        tags: ['Sign-in'],
        summary: 'Remove SMTP settings',
        description: 'Forgets the SMTP configuration and re-enables password login.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Removed' },
        },
      },
    },
    '/api/admin/smtp/test': {
      post: {
        tags: ['Sign-in'],
        summary: 'Send a test code with the saved SMTP settings',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Test code sent; confirm it via /api/admin/smtp/test/verify' },
          '400': { description: 'Settings incomplete' },
          '429': { description: 'Requested too soon' },
          '502': { description: 'SMTP send failed (message includes the transport error)' },
        },
      },
    },
    '/api/admin/smtp/test/verify': {
      post: {
        tags: ['Sign-in'],
        summary: 'Confirm the test code',
        description: 'Marks the SMTP configuration verified. From this point password login is disabled; only passkeys and emailed codes sign in.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ticket', 'code'],
                properties: {
                  ticket: { type: 'string' },
                  code: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Verified' },
          '400': { description: 'Ticket expired or invalid' },
          '401': { description: 'Incorrect code' },
        },
      },
    },
    '/api/auth/ldap/login': {
      post: {
        tags: ['Directory'],
        summary: 'Participant directory sign-in',
        description: 'When the meeting frontend is gated behind LDAP (requireForFrontend), exchanges directory credentials for a 12-hour participant session. Send it as `Authorization: Bearer` on /api/token and /api/room-code.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: { username: { type: 'string' }, password: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Session issued: { token, expiresAt, username, displayName }' },
          '401': { description: 'Invalid credentials' },
          '404': { description: 'LDAP not enabled' },
          '502': { description: 'Directory unreachable / bind failed' },
        },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['Directory'],
        summary: 'Current participant session',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: '{ username, displayName, ldapRequired }' }, '401': { description: 'Not signed in' } },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['Directory'],
        summary: 'End participant session',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/admin/ldap': {
      get: {
        tags: ['Directory'],
        summary: 'Get LDAP settings',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Settings (bind password never returned; hasBindPassword indicates one is stored), active flags, ldapAdminCount, localAccountEnabled' } },
      },
      put: {
        tags: ['Directory'],
        summary: 'Update LDAP settings',
        description: 'Partial update. `enabled` requires url + baseDn + userFilter. Refused (409 WOULD_LOCK_OUT) if it would turn off LDAP admin sign-in while the local account is disabled.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  url: { type: 'string', example: 'ldaps://ldap.example.com:636' },
                  startTls: { type: 'boolean', description: 'Upgrade ldap:// with StartTLS' },
                  tlsRejectUnauthorized: { type: 'boolean' },
                  caCert: { type: 'string', description: 'PEM bundle for a private CA' },
                  bindDn: { type: 'string' },
                  bindPassword: { type: 'string' },
                  baseDn: { type: 'string' },
                  userFilter: { type: 'string', description: 'RFC 4515 filter with {{username}}' },
                  searchFilter: { type: 'string', description: 'Admin-picker filter with {{q}}' },
                  usernameAttribute: { type: 'string' },
                  displayNameAttribute: { type: 'string' },
                  emailAttribute: { type: 'string' },
                  timeoutMs: { type: 'integer' },
                  requireForFrontend: { type: 'boolean', description: 'Participants must sign in against the directory to join meetings' },
                  adminsEnabled: { type: 'boolean', description: 'Directory users in ldap_admins may sign in to the admin panel' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Saved' }, '400': { description: 'Validation error' }, '409': { description: 'Would lock out' } },
      },
      delete: {
        tags: ['Directory'],
        summary: 'Remove LDAP settings and all LDAP admins',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Removed' }, '409': { description: 'Local account disabled — would lock out' } },
      },
    },
    '/api/admin/ldap/test': {
      post: {
        tags: ['Directory'],
        summary: 'Test the saved LDAP settings',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: '{ ok, message, matchedUsers }' }, '502': { description: 'Connection, bind or search failed (message says which)' } },
      },
    },
    '/api/admin/ldap/search': {
      get: {
        tags: ['Directory'],
        summary: 'Search directory users',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring matched against uid / sAMAccountName / cn / displayName / mail' }],
        responses: { '200': { description: '{ users: [{ dn, username, displayName, email, isAdmin }] } (max 25)' } },
      },
    },
    '/api/admin/ldap/admins': {
      get: {
        tags: ['Directory'],
        summary: 'List LDAP admins',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: '{ admins: [...] }' } },
      },
      post: {
        tags: ['Directory'],
        summary: 'Grant admin access to a directory user',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['dn'], properties: { dn: { type: 'string' } } } } },
        },
        responses: { '201': { description: 'Granted' }, '404': { description: 'DN not found in directory' }, '409': { description: 'Already an admin' } },
      },
    },
    '/api/admin/ldap/admins/{id}': {
      delete: {
        tags: ['Directory'],
        summary: 'Revoke an LDAP admin',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Revoked' }, '409': { description: 'Last LDAP admin while local account is disabled' } },
      },
    },
    '/api/admin/local-account/disable': {
      post: {
        tags: ['Directory'],
        summary: 'Disable the local admin account',
        description: 'Only a signed-in LDAP admin may call this. Password, passkeys and emailed codes stop working; all local sessions end. Recovery from the server: `reset-admin.js --enable-local`.',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Disabled' }, '403': { description: 'Caller is not an LDAP admin' } },
      },
    },
    '/api/admin/local-account/enable': {
      post: {
        tags: ['Directory'],
        summary: 'Re-enable the local admin account',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Enabled' }, '403': { description: 'Caller is not an LDAP admin' } },
      },
    },
    '/api/admin/logout': {
      post: {
        tags: ['Admin'],
        summary: 'Admin logout',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Logged out successfully' },
        },
      },
    },
    '/api/admin/stats': {
      get: {
        tags: ['Admin'],
        summary: 'Get server statistics',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        responses: {
          '200': {
            description: 'Server statistics',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    activeRooms: { type: 'integer' },
                    totalParticipants: { type: 'integer' },
                    apiKeysCount: { type: 'integer' },
                    webhooksCount: { type: 'integer' },
                    uptime: { type: 'integer', description: 'Uptime in seconds' },
                    version: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/admin/settings': {
      get: {
        tags: ['Admin'],
        summary: 'Get server settings',
        description: 'Retrieve current server settings and recommended limits',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Server settings',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    settings: {
                      type: 'object',
                      properties: {
                        publicAccessEnabled: { type: 'boolean', description: 'Whether public (non-API) access is allowed' },
                        maxParticipantsPerMeeting: { type: 'integer', description: '0 = unlimited' },
                        maxConcurrentMeetings: { type: 'integer', description: '0 = unlimited' },
                        iframeAllowedDomains: { type: 'array', items: { type: 'string' }, description: 'Domains allowed to embed MEET in iframes. Empty = allow all (*)' },
                        defaultVideoQuality: {
                          type: 'string',
                          enum: ['auto', 'high', 'max', 'balanced', 'low'],
                          description: 'Platform-wide default video quality preset.',
                        },
                      },
                    },
                    recommendations: {
                      type: 'object',
                      properties: {
                        maxParticipantsPerMeeting: { type: 'integer', description: 'Recommended based on server resources' },
                        maxConcurrentMeetings: { type: 'integer', description: 'Recommended based on server resources' },
                      },
                    },
                    videoQualityOptions: {
                      type: 'array',
                      items: { type: 'string', enum: ['auto', 'high', 'max', 'balanced', 'low'] },
                      description: 'Valid values for defaultVideoQuality.',
                    },
                  },
                },
              },
            },
          },
        },
      },
      put: {
        tags: ['Admin'],
        summary: 'Update server settings',
        description: 'Update server settings. Set values to 0 for unlimited.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  publicAccessEnabled: { type: 'boolean', description: 'Enable/disable public access (API access always works)' },
                  maxParticipantsPerMeeting: { type: 'integer', description: '0 = unlimited, or set a specific limit' },
                  maxConcurrentMeetings: { type: 'integer', description: '0 = unlimited, or set a specific limit' },
                  iframeAllowedDomains: { type: 'array', items: { type: 'string' }, description: 'Domains allowed to embed MEET in iframes. Empty array = allow all (*)' },
                  defaultVideoQuality: {
                    type: 'string',
                    enum: ['auto', 'high', 'max', 'balanced', 'low'],
                    description: 'Platform-wide default video quality preset for new tokens.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Settings updated successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    settings: {
                      type: 'object',
                      properties: {
                        publicAccessEnabled: { type: 'boolean' },
                        maxParticipantsPerMeeting: { type: 'integer' },
                        maxConcurrentMeetings: { type: 'integer' },
                        iframeAllowedDomains: { type: 'array', items: { type: 'string' } },
                        defaultVideoQuality: { type: 'string', enum: ['auto', 'high', 'max', 'balanced', 'low'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/rooms': {
      get: {
        tags: ['Rooms'],
        summary: 'List active rooms',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        responses: {
          '200': {
            description: 'List of active rooms',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    rooms: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          displayName: { type: 'string', nullable: true },
                          numParticipants: { type: 'integer' },
                          createdAt: { type: 'string', format: 'date-time', nullable: true },
                          maxParticipants: { type: 'integer' },
                        },
                      },
                    },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Rooms'],
        summary: 'Create a room',
        description: 'Create a new room with a specific ID. Useful for programmatic room creation from external applications.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['roomName'],
                properties: {
                  roomName: { type: 'string', description: 'Unique room identifier (alphanumeric, hyphens, underscores)', example: 'meeting-123' },
                  displayName: { type: 'string', description: 'Friendly display name for the room', example: 'Team Standup' },
                  maxParticipants: { type: 'integer', description: 'Maximum number of participants', default: 100 },
                  emptyTimeout: { type: 'integer', description: 'Seconds before empty room is deleted', default: 300 },
                  quality: {
                    type: 'string',
                    enum: ['auto', 'high', 'max', 'balanced', 'low'],
                    description: 'Per-room video quality override. When set, every token minted for this room returns this preset instead of the platform default. Lost on API restart (transient room metadata).',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Room created successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    room: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        displayName: { type: 'string', nullable: true },
                        maxParticipants: { type: 'integer' },
                        emptyTimeout: { type: 'integer' },
                        createdAt: { type: 'string', format: 'date-time' },
                      },
                    },
                    joinUrl: { type: 'string', format: 'uri', description: 'URL to join the room. Built from PUBLIC_BASE_URL and includes embed=1 so the web app skips its create/join configuration screen; append &name=... to also skip the name prompt, or use embed=0 to show the full screen.' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid room name' },
          '409': { description: 'Room already exists' },
        },
      },
    },
    '/api/rooms/{roomName}': {
      put: {
        tags: ['Rooms'],
        summary: 'Update room',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        parameters: [
          { name: 'roomName', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  displayName: { type: 'string', description: 'Friendly name for the room' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Room updated' },
          '404': { description: 'Room not found' },
        },
      },
    },
    '/api/admin/api-keys': {
      get: {
        tags: ['API Keys'],
        summary: 'List API keys',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of API keys',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    apiKeys: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          keyPrefix: { type: 'string', description: 'Masked key (first/last chars)' },
                          permissions: { type: 'array', items: { type: 'string' } },
                          createdAt: { type: 'string', format: 'date-time' },
                          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['API Keys'],
        summary: 'Create API key',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  permissions: {
                    type: 'array',
                    items: { type: 'string', enum: ['read', 'write', 'admin'] },
                    default: ['read'],
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'API key created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    key: { type: 'string', description: 'Full API key (only shown once)' },
                    permissions: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/admin/api-keys/{keyId}': {
      delete: {
        tags: ['API Keys'],
        summary: 'Revoke API key',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'keyId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'API key revoked' },
          '404': { description: 'API key not found' },
        },
      },
    },
    '/api/admin/api-keys/{keyId}/rotate': {
      post: {
        tags: ['API Keys'],
        summary: 'Rotate API key secret',
        description: 'Generate a new secret for the given API key, preserving id/name/permissions. The previous secret stops working immediately. The new secret is returned exactly once.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'keyId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'API key rotated; new secret in `key`.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    key: { type: 'string', description: 'New secret. Only returned by this endpoint; cannot be recovered later.' },
                    permissions: { type: 'array', items: { type: 'string' } },
                    createdAt: { type: 'string', format: 'date-time', description: 'Original creation timestamp; not changed by rotation.' },
                  },
                },
              },
            },
          },
          '404': { description: 'API key not found' },
        },
      },
    },
    '/api/admin/webauthn/status': {
      get: {
        tags: ['Passkeys'],
        summary: 'Passkey availability',
        description: 'Check whether passkeys are configured (PUBLIC_BASE_URL is set) and how many are registered. No authentication required so the login form can show or hide the "Sign in with passkey" button.',
        responses: {
          '200': {
            description: 'Passkey status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    configured: { type: 'boolean', description: 'False if PUBLIC_BASE_URL is empty.' },
                    registeredCount: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/admin/webauthn/register/options': {
      post: {
        tags: ['Passkeys'],
        summary: 'Begin passkey registration',
        description: 'Returns a WebAuthn registration challenge for the calling admin. The browser passes this to navigator.credentials.create(); send the result to /register/verify.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Challenge generated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ticket: { type: 'string', description: 'Opaque server-side challenge id; pass back to /register/verify.' },
                    options: { type: 'object', description: 'PublicKeyCredentialCreationOptionsJSON.' },
                  },
                },
              },
            },
          },
          '503': { description: 'Passkeys not configured (PUBLIC_BASE_URL empty)' },
        },
      },
    },
    '/api/admin/webauthn/register/verify': {
      post: {
        tags: ['Passkeys'],
        summary: 'Complete passkey registration',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ticket', 'response'],
                properties: {
                  ticket: { type: 'string' },
                  label: { type: 'string', description: "Human-readable name for the passkey, e.g. 'Work laptop'." },
                  response: { type: 'object', description: 'Authenticator attestation (RegistrationResponseJSON).' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Passkey registered',
            content: { 'application/json': { schema: { type: 'object', properties: {
              success: { type: 'boolean' }, id: { type: 'string' }, label: { type: 'string' },
            } } } },
          },
          '400': { description: 'Challenge expired or attestation failed verification' },
        },
      },
    },
    '/api/admin/webauthn/auth/options': {
      post: {
        tags: ['Passkeys'],
        summary: 'Begin passkey sign-in',
        description: 'Public endpoint — this is the auth itself. Returns a WebAuthn authentication challenge. The browser passes it to navigator.credentials.get(); send the result to /auth/verify.',
        responses: {
          '200': {
            description: 'Challenge generated',
            content: { 'application/json': { schema: { type: 'object', properties: {
              ticket: { type: 'string' },
              options: { type: 'object', description: 'PublicKeyCredentialRequestOptionsJSON.' },
            } } } },
          },
          '404': { description: 'No passkeys registered yet' },
          '503': { description: 'Passkeys not configured (PUBLIC_BASE_URL empty)' },
        },
      },
    },
    '/api/admin/webauthn/auth/verify': {
      post: {
        tags: ['Passkeys'],
        summary: 'Complete passkey sign-in',
        description: 'Public endpoint. Verifies the assertion and issues an admin session token (same shape as /api/admin/login).',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['ticket', 'response'], properties: {
            ticket: { type: 'string' },
            response: { type: 'object', description: 'Authenticator assertion (AuthenticationResponseJSON).' },
          } } } },
        },
        responses: {
          '200': {
            description: 'Session token issued',
            content: { 'application/json': { schema: { type: 'object', properties: {
              success: { type: 'boolean' },
              token: { type: 'string' },
              expiresAt: { type: 'string', format: 'date-time' },
              isFirstLogin: { type: 'boolean' },
              username: { type: 'string' },
            } } } },
          },
          '400': { description: 'Invalid request (missing ticket or response)' },
          '401': { description: 'Assertion failed verification or unknown passkey' },
        },
      },
    },
    '/api/admin/webauthn/credentials': {
      get: {
        tags: ['Passkeys'],
        summary: 'List registered passkeys',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of registered passkeys',
            content: { 'application/json': { schema: { type: 'object', properties: {
              credentials: { type: 'array', items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  transports: { type: 'array', items: { type: 'string' } },
                  createdAt: { type: 'string', format: 'date-time' },
                  lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
                },
              } },
            } } } },
          },
        },
      },
    },
    '/api/admin/webauthn/credentials/{id}': {
      delete: {
        tags: ['Passkeys'],
        summary: 'Delete a registered passkey',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Passkey deleted' },
          '404': { description: 'Passkey not found' },
        },
      },
    },
    '/api/admin/webhooks': {
      get: {
        tags: ['Webhooks'],
        summary: 'List webhooks',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of webhooks',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    webhooks: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          url: { type: 'string', format: 'uri' },
                          events: { type: 'array', items: { type: 'string' } },
                          enabled: { type: 'boolean' },
                          failureCount: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Webhooks'],
        summary: 'Create webhook',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'url', 'events'],
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string', format: 'uri' },
                  events: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: ['room.created', 'room.deleted', 'participant.joined', 'participant.left', 'recording.started', 'recording.stopped'],
                    },
                  },
                  enabled: { type: 'boolean', default: true },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Webhook created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    secret: { type: 'string', description: 'Webhook secret for signature verification (only shown once)' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/admin/webhooks/{webhookId}': {
      get: {
        tags: ['Webhooks'],
        summary: 'Get webhook details',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'webhookId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Webhook details' },
          '404': { description: 'Webhook not found' },
        },
      },
      put: {
        tags: ['Webhooks'],
        summary: 'Update webhook',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'webhookId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string', format: 'uri' },
                  events: { type: 'array', items: { type: 'string' } },
                  enabled: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Webhook updated' },
          '404': { description: 'Webhook not found' },
        },
      },
      delete: {
        tags: ['Webhooks'],
        summary: 'Delete webhook',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'webhookId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Webhook deleted' },
          '404': { description: 'Webhook not found' },
        },
      },
    },
    '/api/admin/webhooks/{webhookId}/test': {
      post: {
        tags: ['Webhooks'],
        summary: 'Test webhook',
        description: 'Send a test event to the webhook URL',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'webhookId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Test result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    statusCode: { type: 'integer' },
                    responseTime: { type: 'integer', description: 'Response time in ms' },
                    error: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Admin session token from /api/admin/login',
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key created via admin panel',
      },
    },
  },
};

// Serve OpenAPI spec as JSON
app.get('/api/docs', (_req: Request, res: Response) => {
  res.json(openApiSpec);
});

// Token generation endpoint
interface TokenRequest {
  roomName: string;
  participantName: string;
  deviceId?: string;
}

app.post('/api/token', async (req: Request<object, object, TokenRequest>, res: Response) => {
  try {
    const { roomName, participantName, deviceId } = req.body;

    // Check if request is from API key or public access
    const apiKeyHeader = req.headers['x-api-key'] as string;
    const isApiAccess = !!apiKeyHeader;

    // Check public access setting (API access is always allowed)
    if (!isApiAccess && !serverSettings.publicAccessEnabled) {
      res.status(403).json({ error: 'Public access is currently disabled. Please use API key authentication.' });
      return;
    }

    // Directory-gated frontend: browser callers need a participant (or
    // admin) session. API-key callers are exempt.
    if (!isApiAccess && ldapRequiredForFrontend() && !participantSessionFromRequest(req)) {
      res.status(401).json({
        error: 'Sign in with your directory account to join meetings',
        code: 'LDAP_LOGIN_REQUIRED',
      });
      return;
    }

    if (!roomName || typeof roomName !== 'string') {
      res.status(400).json({ error: 'roomName is required' });
      return;
    }

    if (!participantName || typeof participantName !== 'string') {
      res.status(400).json({ error: 'participantName is required' });
      return;
    }

    const sanitizedRoomName = roomName.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 50);
    const sanitizedParticipantName = participantName.slice(0, 50);

    if (!sanitizedRoomName) {
      res.status(400).json({ error: 'Invalid room name' });
      return;
    }

    const sanitizedDeviceId = deviceId ? deviceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) : '';
    const participantIdentity = sanitizedDeviceId
      ? `${sanitizedParticipantName}_${sanitizedDeviceId}`
      : `${sanitizedParticipantName}_${Date.now()}`;

    let isHost = false;
    let isNewRoom = false;
    let currentParticipants = 0;
    let allRooms: { name: string; numParticipants?: number }[] = [];

    try {
      allRooms = await roomService.listRooms();
      const targetRoom = allRooms.find(r => r.name === sanitizedRoomName);
      isNewRoom = !targetRoom;
      isHost = isNewRoom || (targetRoom?.numParticipants ?? 0) === 0;
      currentParticipants = targetRoom?.numParticipants ?? 0;
    } catch (err) {
      console.warn('Could not check room status:', err);
      isHost = true;
      isNewRoom = true;
    }

    // Check concurrent meetings limit (only for new rooms)
    if (isNewRoom && serverSettings.maxConcurrentMeetings > 0) {
      if (allRooms.length >= serverSettings.maxConcurrentMeetings) {
        res.status(503).json({
          error: 'Maximum number of concurrent meetings reached',
          limit: serverSettings.maxConcurrentMeetings,
          current: allRooms.length,
        });
        return;
      }
    }

    // Check participants per meeting limit
    if (!isNewRoom && serverSettings.maxParticipantsPerMeeting > 0) {
      if (currentParticipants >= serverSettings.maxParticipantsPerMeeting) {
        res.status(503).json({
          error: 'Maximum number of participants for this meeting reached',
          limit: serverSettings.maxParticipantsPerMeeting,
          current: currentParticipants,
        });
        return;
      }
    }

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: participantIdentity,
      name: sanitizedParticipantName,
    });

    token.addGrant({
      room: sanitizedRoomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: isHost,
    });

    const jwt = await token.toJwt();

    // Trigger webhooks
    if (isNewRoom) {
      triggerWebhooks('room.created', { roomName: sanitizedRoomName });
    }
    triggerWebhooks('participant.joined', {
      roomName: sanitizedRoomName,
      participantName: sanitizedParticipantName,
      participantIdentity,
      isHost,
    });

    // Quality preset to apply for this participant: per-room override
    // takes precedence over the platform default. The frontend reads
    // this and calls setVideoQualityPreset() before joining.
    const roomMeta = roomMetadata.get(sanitizedRoomName);
    const quality: VideoQualityPreset =
      roomMeta?.videoQuality ?? serverSettings.defaultVideoQuality;

    const iceServers = buildIceServers();

    res.json({
      token: jwt,
      roomName: sanitizedRoomName,
      participantName: sanitizedParticipantName,
      participantIdentity,
      isHost,
      quality,
      // Only set when TURN is configured. The frontend passes this into
      // Room.connect's rtcConfig.iceServers; without it, the browser's
      // default STUN-only set is used (fine for wifi, fails on cellular).
      ...(iceServers ? { iceServers } : {}),
    });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Generate random room code
app.get('/api/room-code', (req: Request, res: Response) => {
  if (ldapRequiredForFrontend() && !req.headers['x-api-key'] && !participantSessionFromRequest(req)) {
    res.status(401).json({ error: 'Sign in with your directory account first', code: 'LDAP_LOGIN_REQUIRED' });
    return;
  }
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  res.json({ roomCode: code });
});

// End meeting for all participants
interface EndMeetingRequest {
  roomName: string;
  participantIdentity: string;
}

app.post('/api/end-meeting', async (req: Request<object, object, EndMeetingRequest>, res: Response) => {
  try {
    const { roomName, participantIdentity } = req.body;

    if (!roomName || typeof roomName !== 'string') {
      res.status(400).json({ error: 'roomName is required' });
      return;
    }

    if (!participantIdentity || typeof participantIdentity !== 'string') {
      res.status(400).json({ error: 'participantIdentity is required' });
      return;
    }

    const sanitizedRoomName = roomName.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 50);
    await roomService.deleteRoom(sanitizedRoomName);

    // Trigger webhooks
    triggerWebhooks('room.deleted', {
      roomName: sanitizedRoomName,
      endedBy: participantIdentity,
    });

    console.log(`Room ${sanitizedRoomName} ended by ${participantIdentity}`);
    res.json({ success: true, message: 'Meeting ended for all participants' });
  } catch (error) {
    console.error('End meeting error:', error);
    res.status(500).json({ error: 'Failed to end meeting' });
  }
});

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

// Admin login
interface AdminLoginRequest {
  username: string;
  password: string;
}

app.post('/api/admin/login', async (req: Request<object, object, AdminLoginRequest>, res: Response) => {
  const { username, password } = req.body;

  if (!username || typeof username !== 'string') {
    res.status(400).json({ error: 'Username is required' });
    return;
  }

  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Password is required' });
    return;
  }

  // Route the attempt: the local account claims first-login and its own
  // username; anything else goes to the directory when LDAP admins are
  // enabled. The two never fall through into each other, so a wrong local
  // password can't be retried against the directory (or vice versa).
  const isLocalAttempt = localAccountEnabled() && (isFirstLogin || username === adminUsername);
  if (!isLocalAttempt) {
    if (!localAccountEnabled() && username === adminUsername) {
      res.status(403).json({
        error: 'The local admin account is disabled. Sign in with a directory (LDAP) admin account.',
        code: 'LOCAL_ACCOUNT_DISABLED',
      });
      return;
    }
    if (!ldapAdminsActive()) {
      if (!localAccountEnabled()) {
        res.status(403).json({
          error: 'The local admin account is disabled. Sign in with a directory (LDAP) admin account.',
          code: 'LOCAL_ACCOUNT_DISABLED',
        });
        return;
      }
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    let user: ldap.LdapUser;
    try {
      user = await ldap.authenticate(ldapSettings, username, password);
    } catch (e) {
      sendLdapError(res, e);
      return;
    }
    const admin = store.findLdapAdminByDn(user.dn);
    if (!admin) {
      res.status(403).json({ error: 'This directory account is not a MEET admin', code: 'NOT_AN_ADMIN' });
      return;
    }
    admin.lastLoginAt = new Date();
    if (user.username) admin.username = user.username;
    if (user.displayName) admin.displayName = user.displayName;
    if (user.email) admin.email = user.email;
    store.saveLdapAdmin(admin);

    const principal = `ldap:${user.dn}`;
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    store.saveAdminSession({ token, createdAt: new Date(), expiresAt, principal, displayName: user.displayName || user.username });
    store.purgeExpiredAdminSessions();
    console.log(`[ldap] admin sign-in: ${user.dn}`);
    res.json({
      success: true,
      token,
      expiresAt: expiresAt.toISOString(),
      isFirstLogin: false,
      username: user.username,
      displayName: user.displayName,
      principal,
    });
    return;
  }

  // Once email sign-in is verified the password is no longer an accepted
  // credential anywhere (here, Bearer-password on admin routes, WS auth).
  if (!passwordLoginEnabled()) {
    res.status(403).json({
      error: 'Password login is disabled. Sign in with a passkey or an emailed one-time code.',
      code: 'PASSWORD_LOGIN_DISABLED',
    });
    return;
  }

  // If no admin credentials are set, first login sets them and persists.
  // The provided password is hashed with scrypt before storage; we never
  // persist plaintext.
  const wasFirstLogin = isFirstLogin;
  if (isFirstLogin) {
    adminUsername = username;
    adminPasswordHash = hashPassword(password);
    isFirstLogin = false;
    store.saveAdminCredentials({
      username,
      passwordHash: adminPasswordHash,
      firstLoginDone: true,
      userHandle: store.loadAdminCredentialsRaw().userHandle,
    });
    console.log(`Admin credentials set by first login: ${username}`);
  }

  if (username !== adminUsername || !verifyPassword(password, adminPasswordHash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  // Create session token (persisted across restarts in admin_sessions).
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  store.saveAdminSession({ token, createdAt: new Date(), expiresAt, principal: 'local', displayName: adminUsername });
  store.purgeExpiredAdminSessions();

  res.json({
    success: true,
    token,
    expiresAt: expiresAt.toISOString(),
    isFirstLogin: wasFirstLogin,
    username: adminUsername,
    principal: 'local',
  });
});

// Admin logout
app.post('/api/admin/logout', authenticateAdmin, (req: AuthRequest, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    store.deleteAdminSession(token);
  }
  res.json({ success: true });
});

// ───────────────────── sign-in methods / email OTP ─────────────────────
//
// Which ways the admin can currently sign in. Public so the login form
// can render the right controls without a credential.
app.get('/api/admin/auth/methods', (_req: Request, res: Response) => {
  const otpAvailable = otpLoginAvailable();
  res.json({
    password: passwordLoginEnabled(),
    passkey: localAccountEnabled() && webauthn.isWebAuthnConfigured() && store.listPasskeys().length > 0,
    otp: otpAvailable,
    ldap: ldapAdminsActive(),
    localAccountEnabled: localAccountEnabled(),
    firstLogin: isFirstLogin,
    ...(otpAvailable && smtpSettings ? { otpEmail: mailer.maskEmail(smtpSettings.adminEmail) } : {}),
  });
});

// Step 1 of email sign-in: mail a 6-digit code to the admin address.
// Unauthenticated by design (this IS the auth); rate-limited in otp.ts.
app.post('/api/admin/otp/request', async (_req: Request, res: Response) => {
  if (!localAccountEnabled()) {
    res.status(403).json({ error: 'The local admin account is disabled', code: 'LOCAL_ACCOUNT_DISABLED' });
    return;
  }
  if (!otpLoginAvailable() || !smtpSettings) {
    res.status(404).json({ error: 'Email sign-in is not set up on this server' });
    return;
  }
  let issued: otp.IssuedOtp;
  try {
    issued = otp.issue('login');
  } catch (e) {
    sendOtpError(res, e);
    return;
  }
  try {
    await mailer.sendOtpEmail(smtpSettings, issued.code, 'login', otp.OTP_TTL_MINUTES);
  } catch (e) {
    otp.discard(issued.ticket, 'login');
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[otp] failed to send sign-in code:', msg);
    res.status(502).json({ error: 'Could not send the sign-in email. Check the SMTP settings or use a passkey.' });
    return;
  }
  console.log(`[otp] sign-in code sent to ${mailer.maskEmail(smtpSettings.adminEmail)}`);
  res.json({
    success: true,
    ticket: issued.ticket,
    expiresAt: issued.expiresAt.toISOString(),
    email: mailer.maskEmail(smtpSettings.adminEmail),
  });
});

interface OtpVerifyBody {
  ticket: string;
  code: string;
}

// Step 2: exchange ticket + code for a session token.
app.post('/api/admin/otp/verify', (req: Request<object, object, OtpVerifyBody>, res: Response) => {
  if (!localAccountEnabled()) {
    res.status(403).json({ error: 'The local admin account is disabled', code: 'LOCAL_ACCOUNT_DISABLED' });
    return;
  }
  const { ticket, code } = req.body;
  if (!ticket || typeof ticket !== 'string' || code === undefined || code === null) {
    res.status(400).json({ error: 'ticket and code are required' });
    return;
  }
  try {
    otp.consume(ticket, String(code), 'login');
  } catch (e) {
    sendOtpError(res, e);
    return;
  }

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  store.saveAdminSession({ token, createdAt: new Date(), expiresAt, principal: 'local', displayName: adminUsername });
  store.purgeExpiredAdminSessions();

  res.json({
    success: true,
    token,
    expiresAt: expiresAt.toISOString(),
    isFirstLogin: false,
    username: adminUsername,
    principal: 'local',
  });
});

// ───────────────────────── directory (LDAP) ────────────────────────────

app.get('/api/admin/ldap', authenticateAdmin, (_req: AuthRequest, res: Response) => {
  res.json(ldapView());
});

interface UpdateLdapRequest {
  enabled?: boolean;
  url?: string;
  startTls?: boolean;
  tlsRejectUnauthorized?: boolean;
  caCert?: string;
  bindDn?: string;
  // Omit or '' keeps the stored password.
  bindPassword?: string;
  baseDn?: string;
  userFilter?: string;
  searchFilter?: string;
  usernameAttribute?: string;
  displayNameAttribute?: string;
  emailAttribute?: string;
  timeoutMs?: number | string;
  requireForFrontend?: boolean;
  adminsEnabled?: boolean;
}

app.put('/api/admin/ldap', authenticateAdmin, (req: Request<object, object, UpdateLdapRequest>, res: Response) => {
  const body = req.body ?? {};
  const next: LdapSettings = { ...ldapSettings };

  const str = (k: keyof UpdateLdapRequest, target: keyof LdapSettings, opts: { allowEmpty?: boolean; max?: number } = {}) => {
    const v = body[k];
    if (v === undefined) return true;
    if (typeof v !== 'string' || (!opts.allowEmpty && !v.trim()) || v.length > (opts.max ?? 2000)) {
      res.status(400).json({ error: `${k} must be a non-empty string` });
      return false;
    }
    (next as unknown as Record<string, unknown>)[target] = v.trim();
    return true;
  };

  if (body.url !== undefined) {
    if (typeof body.url !== 'string' || !ldap.isValidLdapUrl(body.url.trim())) {
      res.status(400).json({ error: 'url must look like ldap://host:389 or ldaps://host:636' });
      return;
    }
    next.url = body.url.trim();
  }
  if (!str('bindDn', 'bindDn', { allowEmpty: true })) return;
  if (typeof body.bindPassword === 'string' && body.bindPassword.length > 0) next.bindPassword = body.bindPassword;
  if (!str('baseDn', 'baseDn', { allowEmpty: true })) return;
  if (!str('caCert', 'caCert', { allowEmpty: true, max: 20000 })) return;
  if (body.userFilter !== undefined) {
    if (typeof body.userFilter !== 'string' || !body.userFilter.includes('{{username}}')) {
      res.status(400).json({ error: 'userFilter must contain the {{username}} placeholder' });
      return;
    }
    next.userFilter = body.userFilter.trim();
  }
  if (body.searchFilter !== undefined) {
    if (typeof body.searchFilter !== 'string' || !body.searchFilter.includes('{{q}}')) {
      res.status(400).json({ error: 'searchFilter must contain the {{q}} placeholder' });
      return;
    }
    next.searchFilter = body.searchFilter.trim();
  }
  for (const k of ['usernameAttribute', 'displayNameAttribute', 'emailAttribute'] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(v.trim())) {
      res.status(400).json({ error: `${k} must be an attribute name` });
      return;
    }
    next[k] = v.trim();
  }
  if (body.timeoutMs !== undefined) {
    const t = Number(body.timeoutMs);
    if (!Number.isInteger(t) || t < 1000 || t > 60000) {
      res.status(400).json({ error: 'timeoutMs must be between 1000 and 60000' });
      return;
    }
    next.timeoutMs = t;
  }
  for (const k of ['startTls', 'tlsRejectUnauthorized', 'requireForFrontend', 'adminsEnabled', 'enabled'] as const) {
    if (body[k] !== undefined) next[k] = body[k] === true;
  }
  if (next.startTls && next.url.toLowerCase().startsWith('ldaps://')) next.startTls = false;

  if (next.enabled && !ldap.isLdapConfigured(next)) {
    res.status(400).json({ error: 'Set url, baseDn and userFilter before enabling LDAP' });
    return;
  }
  // Never let a change strand a deployment whose local account is off:
  // the directory admins are then the only way in.
  if (localAccountDisabled && !(next.enabled && next.adminsEnabled)) {
    res.status(409).json({
      error: 'The local account is disabled, so LDAP admin sign-in must stay enabled. Re-enable the local account first.',
      code: 'WOULD_LOCK_OUT',
    });
    return;
  }

  ldapSettings = next;
  store.saveLdapSettings(next);
  if (!ldapRequiredForFrontend()) store.deleteAllUserSessions();
  console.log(`[ldap] settings saved (enabled=${next.enabled} url=${next.url} admins=${next.adminsEnabled} frontend=${next.requireForFrontend})`);
  res.json({ success: true, ...ldapView() });
});

app.delete('/api/admin/ldap', authenticateAdmin, (_req: AuthRequest, res: Response) => {
  if (localAccountDisabled) {
    res.status(409).json({
      error: 'The local account is disabled; removing LDAP would lock everyone out. Re-enable the local account first.',
      code: 'WOULD_LOCK_OUT',
    });
    return;
  }
  ldapSettings = { ...ldap.LDAP_DEFAULTS };
  store.deleteLdapSettings();
  const removed = store.deleteAllLdapAdmins();
  store.deleteAllUserSessions();
  store.deleteAdminSessionsByPrincipalPrefix('ldap:');
  console.log(`[ldap] settings removed (${removed} LDAP admin(s) dropped)`);
  res.json({ success: true, ...ldapView() });
});

// Connect + bind + one search with the SAVED settings.
app.post('/api/admin/ldap/test', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  if (!ldap.isLdapConfigured(ldapSettings)) {
    res.status(400).json({ error: 'Save url, baseDn and userFilter first' });
    return;
  }
  try {
    res.json(await ldap.testConnection(ldapSettings));
  } catch (e) {
    sendLdapError(res, e);
  }
});

// Directory user picker for granting admin access.
app.get('/api/admin/ldap/search', authenticateAdmin, async (req: Request<object, object, object, { q?: string }>, res: Response) => {
  if (!ldapActive()) {
    res.status(400).json({ error: 'LDAP is not enabled' });
    return;
  }
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  try {
    const users = await ldap.searchUsers(ldapSettings, q, 25);
    res.json({
      users: users.map((u) => ({ ...u, isAdmin: !!store.findLdapAdminByDn(u.dn) })),
    });
  } catch (e) {
    sendLdapError(res, e);
  }
});

app.get('/api/admin/ldap/admins', authenticateAdmin, (_req: AuthRequest, res: Response) => {
  res.json({ admins: store.listLdapAdmins().map(ldapAdminToJson) });
});

interface AddLdapAdminRequest {
  dn: string;
}

app.post('/api/admin/ldap/admins', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  if (!ldapActive()) {
    res.status(400).json({ error: 'LDAP is not enabled' });
    return;
  }
  const { dn } = (req.body ?? {}) as AddLdapAdminRequest;
  if (!dn || typeof dn !== 'string' || dn.length > 1000) {
    res.status(400).json({ error: 'dn is required' });
    return;
  }
  if (store.findLdapAdminByDn(dn)) {
    res.status(409).json({ error: 'That directory user is already an admin' });
    return;
  }
  let user: ldap.LdapUser | null;
  try {
    user = await ldap.lookupDn(ldapSettings, dn);
  } catch (e) {
    sendLdapError(res, e);
    return;
  }
  if (!user) {
    res.status(404).json({ error: 'No directory entry with that DN' });
    return;
  }
  const admin = {
    id: generateId(),
    dn: user.dn,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    addedBy: req.principal ?? 'local',
    createdAt: new Date(),
    lastLoginAt: null,
  };
  store.saveLdapAdmin(admin);
  console.log(`[ldap] admin granted: ${user.dn} (by ${admin.addedBy})`);
  res.status(201).json({ success: true, admin: ldapAdminToJson(admin) });
});

app.delete('/api/admin/ldap/admins/:id', authenticateAdmin, (req: Request<{ id: string }>, res: Response) => {
  const admin = store.getLdapAdmin(req.params.id);
  if (!admin) {
    res.status(404).json({ error: 'LDAP admin not found' });
    return;
  }
  if (localAccountDisabled && store.countLdapAdmins() <= 1) {
    res.status(409).json({
      error: 'This is the last LDAP admin and the local account is disabled. Re-enable the local account first.',
      code: 'WOULD_LOCK_OUT',
    });
    return;
  }
  store.deleteLdapAdmin(admin.id);
  store.deleteAdminSessionsByPrincipal(`ldap:${admin.dn}`);
  console.log(`[ldap] admin revoked: ${admin.dn}`);
  res.json({ success: true });
});

// ───────────────────── local (built-in) account switch ─────────────────
//
// Only a signed-in directory admin may disable the local account — which
// guarantees at least one working admin remains. Every local session is
// dropped immediately.
app.post('/api/admin/local-account/disable', authenticateAdmin, (req: AuthRequest, res: Response) => {
  if (!req.principal?.startsWith('ldap:')) {
    res.status(403).json({ error: 'Only a directory (LDAP) admin can disable the local account' });
    return;
  }
  if (!ldapAdminsActive() || store.countLdapAdmins() === 0) {
    res.status(409).json({ error: 'Enable LDAP admin sign-in and add at least one LDAP admin first' });
    return;
  }
  localAccountDisabled = true;
  store.setLocalAccountDisabled(true);
  const kicked = store.deleteAdminSessionsByPrincipal('local');
  console.log(`[auth] local admin account disabled by ${req.principal} (${kicked} local session(s) ended)`);
  res.json({ success: true, localAccountEnabled: false });
});

app.post('/api/admin/local-account/enable', authenticateAdmin, (req: AuthRequest, res: Response) => {
  if (!req.principal?.startsWith('ldap:')) {
    res.status(403).json({ error: 'Only a directory (LDAP) admin can re-enable the local account' });
    return;
  }
  localAccountDisabled = false;
  store.setLocalAccountDisabled(false);
  console.log(`[auth] local admin account re-enabled by ${req.principal}`);
  res.json({ success: true, localAccountEnabled: true });
});

// ───────────────────────── SMTP configuration ──────────────────────────

app.get('/api/admin/smtp', authenticateAdmin, (_req: AuthRequest, res: Response) => {
  res.json(smtpView());
});

interface UpdateSmtpRequest {
  host?: string;
  port?: number | string;
  secure?: boolean;
  username?: string;
  // Omit or send '' to keep the stored password.
  password?: string;
  fromAddress?: string;
  adminEmail?: string;
}

app.put('/api/admin/smtp', authenticateAdmin, (req: Request<object, object, UpdateSmtpRequest>, res: Response) => {
  const body = req.body ?? {};
  const current: SmtpSettings = smtpSettings ?? {
    host: '', port: 587, secure: false, username: '', password: '',
    fromAddress: '', adminEmail: '', verified: false, verifiedAt: null,
  };
  const next: SmtpSettings = { ...current };

  if (body.host !== undefined) {
    if (typeof body.host !== 'string' || !body.host.trim() || /[\s/]/.test(body.host.trim())) {
      res.status(400).json({ error: 'host must be a hostname or IP address' });
      return;
    }
    next.host = body.host.trim();
  }
  if (body.port !== undefined) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'port must be an integer between 1 and 65535' });
      return;
    }
    next.port = port;
  }
  if (body.secure !== undefined) {
    next.secure = body.secure === true;
  }
  if (body.username !== undefined) {
    if (typeof body.username !== 'string') {
      res.status(400).json({ error: 'username must be a string' });
      return;
    }
    next.username = body.username.trim();
  }
  if (typeof body.password === 'string' && body.password.length > 0) {
    next.password = body.password;
  }
  if (body.fromAddress !== undefined) {
    if (typeof body.fromAddress !== 'string' || !mailer.isValidEmail(body.fromAddress.trim())) {
      res.status(400).json({ error: 'fromAddress must be a valid email address' });
      return;
    }
    next.fromAddress = body.fromAddress.trim();
  }
  if (body.adminEmail !== undefined) {
    if (typeof body.adminEmail !== 'string' || !mailer.isValidEmail(body.adminEmail.trim())) {
      res.status(400).json({ error: 'adminEmail must be a valid email address' });
      return;
    }
    next.adminEmail = body.adminEmail.trim();
  }

  // Any change to how (or where) mail is delivered invalidates the earlier
  // proof that it works; password login comes back until re-verified.
  const transportChanged = (['host', 'port', 'secure', 'username', 'password', 'fromAddress', 'adminEmail'] as const)
    .some((k) => next[k] !== current[k]);
  if (transportChanged) {
    next.verified = false;
    next.verifiedAt = null;
  }

  smtpSettings = next;
  store.saveSmtpSettings(next);
  console.log(`[smtp] settings saved (host=${next.host}:${next.port} verified=${next.verified})`);
  res.json({ success: true, ...smtpView() });
});

// Forget the SMTP config entirely. Password login is re-enabled.
app.delete('/api/admin/smtp', authenticateAdmin, (_req: AuthRequest, res: Response) => {
  smtpSettings = null;
  store.deleteSmtpSettings();
  otp.clearAll();
  console.log('[smtp] settings removed — password login re-enabled');
  res.json({ success: true, ...smtpView() });
});

// Send a test code with the saved settings. Confirming it (below) marks
// the config verified and turns password login off.
app.post('/api/admin/smtp/test', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  if (!mailer.isSmtpComplete(smtpSettings)) {
    res.status(400).json({ error: 'Save the SMTP host, port, from address and admin email first' });
    return;
  }
  let issued: otp.IssuedOtp;
  try {
    issued = otp.issue('verify');
  } catch (e) {
    sendOtpError(res, e);
    return;
  }
  try {
    await mailer.sendOtpEmail(smtpSettings, issued.code, 'verify', otp.OTP_TTL_MINUTES);
  } catch (e) {
    otp.discard(issued.ticket, 'verify');
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[smtp] test send failed:', msg);
    res.status(502).json({ error: `Could not send test email: ${msg}` });
    return;
  }
  res.json({
    success: true,
    ticket: issued.ticket,
    expiresAt: issued.expiresAt.toISOString(),
    email: mailer.maskEmail(smtpSettings.adminEmail),
  });
});

app.post('/api/admin/smtp/test/verify', authenticateAdmin, (req: Request<object, object, OtpVerifyBody>, res: Response) => {
  const { ticket, code } = req.body;
  if (!ticket || typeof ticket !== 'string' || code === undefined || code === null) {
    res.status(400).json({ error: 'ticket and code are required' });
    return;
  }
  if (!mailer.isSmtpComplete(smtpSettings)) {
    res.status(400).json({ error: 'SMTP settings are incomplete' });
    return;
  }
  try {
    otp.consume(ticket, String(code), 'verify');
  } catch (e) {
    sendOtpError(res, e);
    return;
  }
  smtpSettings = { ...smtpSettings, verified: true, verifiedAt: new Date().toISOString() };
  store.saveSmtpSettings(smtpSettings);
  console.log('[smtp] verified — password login disabled; passkey + email code only');
  res.json({ success: true, ...smtpView() });
});

// ─────────────────────── WebAuthn / passkey ────────────────────────────
//
// Tells the SPA whether passkeys are usable on this deployment.
// Public so the login form can show or hide the "Sign in with passkey"
// button without requiring auth itself.
app.get('/api/admin/webauthn/status', (_req: Request, res: Response) => {
  res.json({
    configured: webauthn.isWebAuthnConfigured(),
    registeredCount: store.listPasskeys().length,
  });
});

// Step 1 of registering a new passkey. Requires existing authentication
// (password or session) so a randomly visiting attacker can't claim a
// passkey on top of an admin account.
app.post('/api/admin/webauthn/register/options', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const cred = store.loadAdminCredentials();
    const result = await webauthn.buildRegistrationOptions(cred.username || 'admin', cred.userHandle);
    res.json(result);
  } catch (e) {
    const status = (e as { statusCode?: number })?.statusCode ?? 500;
    res.status(status).json({ error: (e as Error).message });
  }
});

interface PasskeyRegisterVerifyBody {
  ticket: string;
  label: string;
  response: webauthn.RegistrationVerifyInput['response'];
}

app.post('/api/admin/webauthn/register/verify', authenticateAdmin, async (req: Request<object, object, PasskeyRegisterVerifyBody>, res: Response) => {
  try {
    const { ticket, label, response } = req.body;
    if (!ticket || !response) {
      res.status(400).json({ error: 'ticket and response are required' });
      return;
    }
    const result = await webauthn.verifyRegistration({ ticket, label, response });
    res.json({ success: true, ...result });
  } catch (e) {
    const status = (e as { statusCode?: number })?.statusCode ?? 500;
    res.status(status).json({ error: (e as Error).message });
  }
});

// Step 1 of signing in with a passkey. NOT authenticated — this IS the
// auth.
app.post('/api/admin/webauthn/auth/options', async (_req: Request, res: Response) => {
  if (!localAccountEnabled()) {
    res.status(403).json({ error: 'The local admin account is disabled', code: 'LOCAL_ACCOUNT_DISABLED' });
    return;
  }
  try {
    const result = await webauthn.buildAuthOptions();
    res.json(result);
  } catch (e) {
    const status = (e as { statusCode?: number })?.statusCode ?? 500;
    res.status(status).json({ error: (e as Error).message });
  }
});

interface PasskeyAuthVerifyBody {
  ticket: string;
  response: webauthn.AuthVerifyInput['response'];
}

app.post('/api/admin/webauthn/auth/verify', async (req: Request<object, object, PasskeyAuthVerifyBody>, res: Response) => {
  if (!localAccountEnabled()) {
    res.status(403).json({ error: 'The local admin account is disabled', code: 'LOCAL_ACCOUNT_DISABLED' });
    return;
  }
  try {
    const { ticket, response } = req.body;
    if (!ticket || !response) {
      res.status(400).json({ error: 'ticket and response are required' });
      return;
    }
    await webauthn.verifyAuth({ ticket, response });

    // Issue a session token (same shape as password login).
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    store.saveAdminSession({ token, createdAt: new Date(), expiresAt, principal: 'local', displayName: adminUsername });
    store.purgeExpiredAdminSessions();

    res.json({
      success: true,
      token,
      expiresAt: expiresAt.toISOString(),
      isFirstLogin: false,
      username: adminUsername,
      principal: 'local',
    });
  } catch (e) {
    const status = (e as { statusCode?: number })?.statusCode ?? 401;
    res.status(status).json({ error: (e as Error).message });
  }
});

// List + delete registered passkeys.
app.get('/api/admin/webauthn/credentials', authenticateAdmin, (_req: AuthRequest, res: Response) => {
  res.json({
    credentials: store.listPasskeys().map((p) => ({
      id: p.id,
      label: p.label,
      transports: p.transports,
      createdAt: p.createdAt.toISOString(),
      lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
    })),
  });
});

app.delete('/api/admin/webauthn/credentials/:id', authenticateAdmin, (req: Request<{ id: string }>, res: Response) => {
  if (!store.deletePasskey(req.params.id)) {
    res.status(404).json({ error: 'Passkey not found' });
    return;
  }
  res.json({ success: true });
});

// Get server stats
app.get('/api/admin/stats', authenticateApiKeyOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const rooms = await roomService.listRooms();
    const totalParticipants = rooms.reduce((sum, room) => sum + (room.numParticipants || 0), 0);

    res.json({
      activeRooms: rooms.length,
      totalParticipants,
      apiKeysCount: store.countApiKeys(),
      webhooksCount: store.countWebhooks(),
      uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      version: API_VERSION,
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.json({
      activeRooms: 0,
      totalParticipants: 0,
      apiKeysCount: store.countApiKeys(),
      webhooksCount: store.countWebhooks(),
      uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      version: API_VERSION,
    });
  }
});

// Get server settings
app.get('/api/admin/settings', authenticateAdmin, (_req: AuthRequest, res: Response) => {
  res.json({
    settings: {
      publicAccessEnabled: serverSettings.publicAccessEnabled,
      maxParticipantsPerMeeting: serverSettings.maxParticipantsPerMeeting,
      maxConcurrentMeetings: serverSettings.maxConcurrentMeetings,
      iframeAllowedDomains: serverSettings.iframeAllowedDomains,
      defaultVideoQuality: serverSettings.defaultVideoQuality,
    },
    recommendations: {
      maxParticipantsPerMeeting: serverSettings.recommendedMaxParticipants,
      maxConcurrentMeetings: serverSettings.recommendedMaxMeetings,
    },
    videoQualityOptions: VIDEO_QUALITY_PRESET_VALUES,
  });
});

// Update server settings
interface UpdateSettingsRequest {
  publicAccessEnabled?: boolean;
  maxParticipantsPerMeeting?: number;
  maxConcurrentMeetings?: number;
  iframeAllowedDomains?: string[];
  defaultVideoQuality?: string;
}

app.put('/api/admin/settings', authenticateAdmin, (req: Request<object, object, UpdateSettingsRequest>, res: Response) => {
  const { publicAccessEnabled, maxParticipantsPerMeeting, maxConcurrentMeetings, iframeAllowedDomains, defaultVideoQuality } = req.body;

  if (publicAccessEnabled !== undefined) {
    serverSettings.publicAccessEnabled = publicAccessEnabled;
  }

  if (maxParticipantsPerMeeting !== undefined) {
    if (maxParticipantsPerMeeting < 0) {
      res.status(400).json({ error: 'maxParticipantsPerMeeting must be 0 (unlimited) or a positive number' });
      return;
    }
    serverSettings.maxParticipantsPerMeeting = maxParticipantsPerMeeting;
  }

  if (maxConcurrentMeetings !== undefined) {
    if (maxConcurrentMeetings < 0) {
      res.status(400).json({ error: 'maxConcurrentMeetings must be 0 (unlimited) or a positive number' });
      return;
    }
    serverSettings.maxConcurrentMeetings = maxConcurrentMeetings;
  }

  if (iframeAllowedDomains !== undefined) {
    // Validate domains - must be valid URLs or wildcards like *.example.com
    const validDomains = iframeAllowedDomains.filter(domain => {
      // Allow wildcards like *.example.com or https://example.com
      return domain.match(/^(\*\.)?[\w.-]+\.[a-z]{2,}$/i) ||
             domain.match(/^https?:\/\/[\w.-]+/i);
    });
    serverSettings.iframeAllowedDomains = validDomains;
  }

  if (defaultVideoQuality !== undefined) {
    if (!isValidVideoQuality(defaultVideoQuality)) {
      res.status(400).json({
        error: `defaultVideoQuality must be one of: ${VIDEO_QUALITY_PRESET_VALUES.join(', ')}`,
      });
      return;
    }
    serverSettings.defaultVideoQuality = defaultVideoQuality;
  }

  persistServerSettings();

  res.json({
    success: true,
    settings: {
      publicAccessEnabled: serverSettings.publicAccessEnabled,
      maxParticipantsPerMeeting: serverSettings.maxParticipantsPerMeeting,
      maxConcurrentMeetings: serverSettings.maxConcurrentMeetings,
      iframeAllowedDomains: serverSettings.iframeAllowedDomains,
      defaultVideoQuality: serverSettings.defaultVideoQuality,
    },
  });
});

// List active rooms
app.get('/api/rooms', authenticateApiKeyOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const rooms = await roomService.listRooms();
    res.json({
      rooms: rooms.map(room => {
        const metadata = roomMetadata.get(room.name);
        return {
          name: room.name,
          displayName: metadata?.displayName || null,
          numParticipants: room.numParticipants,
          createdAt: room.creationTime ? new Date(Number(room.creationTime) * 1000).toISOString() : null,
          maxParticipants: room.maxParticipants,
        };
      }),
      total: rooms.length,
    });
  } catch (error) {
    console.error('List rooms error:', error);
    res.status(500).json({ error: 'Failed to list rooms' });
  }
});

// Create room with specific ID
interface CreateRoomRequest {
  roomName: string;
  displayName?: string;
  maxParticipants?: number;
  emptyTimeout?: number; // seconds before empty room is deleted
  // Optional video quality override for this room. When set, every token
  // minted for this room returns this preset instead of the platform
  // default. Useful for stamping low-bandwidth meetings (`'low'`) or
  // quality-critical recordings (`'max'`).
  quality?: string;
}

app.post('/api/rooms', authenticateApiKeyOrAdmin, async (req: Request<object, object, CreateRoomRequest>, res: Response) => {
  const { roomName, displayName, maxParticipants, emptyTimeout, quality } = req.body;
  if (quality !== undefined && !isValidVideoQuality(quality)) {
    res.status(400).json({
      error: `quality must be one of: ${VIDEO_QUALITY_PRESET_VALUES.join(', ')}`,
    });
    return;
  }

  if (!roomName || typeof roomName !== 'string') {
    res.status(400).json({ error: 'roomName is required' });
    return;
  }

  // Sanitize room name - allow alphanumeric, hyphens, underscores
  const sanitizedRoomName = roomName.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 50);
  if (!sanitizedRoomName) {
    res.status(400).json({ error: 'Invalid room name. Use alphanumeric characters, hyphens, or underscores.' });
    return;
  }

  try {
    // Check if room already exists
    const existingRooms = await roomService.listRooms([sanitizedRoomName]);
    if (existingRooms.length > 0) {
      res.status(409).json({ error: 'Room already exists', roomName: sanitizedRoomName });
      return;
    }

    // Create the room via LiveKit
    const room = await roomService.createRoom({
      name: sanitizedRoomName,
      maxParticipants: maxParticipants || 100,
      emptyTimeout: emptyTimeout || 300, // 5 minutes default
    });

    // Store metadata if display name OR quality override provided.
    if (displayName || quality) {
      const existing = roomMetadata.get(sanitizedRoomName);
      roomMetadata.set(sanitizedRoomName, {
        displayName: displayName ?? existing?.displayName ?? sanitizedRoomName,
        createdAt: existing?.createdAt ?? new Date(),
        videoQuality: (quality as VideoQualityPreset | undefined) ?? existing?.videoQuality,
      });
    }

    // Trigger webhook
    triggerWebhooks('room.created', { roomName: sanitizedRoomName, displayName });

    // Generate join URL. Prefer the configured public URL: behind a reverse
    // proxy req.get('host') may be the API's own (sub)domain, not the SPA's.
    // embed=1 tells the SPA to skip the create/join configuration screen and
    // go straight into the room, prompting only for a name if none is given.
    const publicBase = (PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const joinUrl = `${publicBase}/?room=${sanitizedRoomName}&embed=1`;

    res.status(201).json({
      success: true,
      room: {
        name: room.name,
        displayName: displayName || null,
        maxParticipants: room.maxParticipants,
        emptyTimeout: room.emptyTimeout,
        createdAt: new Date().toISOString(),
      },
      joinUrl,
    });
  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Update room display name
interface UpdateRoomRequest {
  displayName?: string;
}

app.put('/api/rooms/:roomName', authenticateApiKeyOrAdmin, async (req: Request<{ roomName: string }, object, UpdateRoomRequest>, res: Response) => {
  const { roomName } = req.params;
  const { displayName } = req.body;

  try {
    // Verify room exists
    const rooms = await roomService.listRooms([roomName]);
    if (rooms.length === 0) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    // Update or create metadata
    const existing = roomMetadata.get(roomName);
    if (displayName !== undefined) {
      roomMetadata.set(roomName, {
        displayName: displayName || '',
        createdAt: existing?.createdAt || new Date(),
      });
    }

    const metadata = roomMetadata.get(roomName);
    res.json({
      name: roomName,
      displayName: metadata?.displayName || null,
      numParticipants: rooms[0].numParticipants,
      createdAt: rooms[0].creationTime ? new Date(Number(rooms[0].creationTime) * 1000).toISOString() : null,
      maxParticipants: rooms[0].maxParticipants,
    });
  } catch (error) {
    console.error('Update room error:', error);
    res.status(500).json({ error: 'Failed to update room' });
  }
});

// ============================================================================
// API KEY ENDPOINTS
// ============================================================================

// List API keys
app.get('/api/admin/api-keys', authenticateAdmin, (_req: AuthRequest, res: Response) => {
  const keys = store.listApiKeys().map(key => ({
    id: key.id,
    name: key.name,
    keyPrefix: maskApiKey(key.key),
    permissions: key.permissions,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() || null,
  }));

  res.json({ apiKeys: keys });
});

// Create API key
interface CreateApiKeyRequest {
  name: string;
  permissions?: string[];
}

app.post('/api/admin/api-keys', authenticateAdmin, (req: Request<object, object, CreateApiKeyRequest>, res: Response) => {
  const { name, permissions = ['read'] } = req.body;

  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const validPermissions = ['read', 'write', 'admin'];
  const sanitizedPermissions = permissions.filter(p => validPermissions.includes(p));

  const id = generateId();
  const key = generateApiKey();

  const apiKey: ApiKey = {
    id,
    name: name.slice(0, 100),
    key,
    keyHash: hashString(key),
    permissions: sanitizedPermissions,
    createdAt: new Date(),
    lastUsedAt: null,
  };

  store.saveApiKey(apiKey);

  res.status(201).json({
    id,
    name: apiKey.name,
    key, // Only returned on creation
    permissions: apiKey.permissions,
    createdAt: apiKey.createdAt.toISOString(),
  });
});

// Revoke API key
app.delete('/api/admin/api-keys/:keyId', authenticateAdmin, (req: Request<{ keyId: string }>, res: Response) => {
  const { keyId } = req.params;

  if (!store.deleteApiKey(keyId)) {
    res.status(404).json({ error: 'API key not found' });
    return;
  }
  res.json({ success: true, message: 'API key revoked' });
});

// Rotate API key — replace the secret while keeping the id, name, and
// permissions. The previous secret stops working immediately. Useful when
// a key may have leaked but the consumer can be reconfigured without
// recreating the integration.
app.post('/api/admin/api-keys/:keyId/rotate', authenticateAdmin, (req: Request<{ keyId: string }>, res: Response) => {
  const { keyId } = req.params;
  const existing = store.getApiKey(keyId);
  if (!existing) {
    res.status(404).json({ error: 'API key not found' });
    return;
  }

  const newKey = generateApiKey();
  const rotated: ApiKey = {
    ...existing,
    key: newKey,
    keyHash: hashString(newKey),
    lastUsedAt: null, // reset; the new key has never been used
  };
  store.saveApiKey(rotated);

  res.json({
    id: rotated.id,
    name: rotated.name,
    key: newKey, // Only returned on rotation; cannot be recovered later.
    permissions: rotated.permissions,
    createdAt: rotated.createdAt.toISOString(),
  });
});

// ============================================================================
// WEBHOOK ENDPOINTS
// ============================================================================

// List webhooks
app.get('/api/admin/webhooks', authenticateAdmin, (_req: AuthRequest, res: Response) => {
  const hooks = store.listWebhooks().map(webhook => ({
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    events: webhook.events,
    enabled: webhook.enabled,
    secret: maskSecret(webhook.secret),
    createdAt: webhook.createdAt.toISOString(),
    lastTriggeredAt: webhook.lastTriggeredAt?.toISOString() || null,
    failureCount: webhook.failureCount,
  }));

  res.json({ webhooks: hooks });
});

// Create webhook
interface CreateWebhookRequest {
  name: string;
  url: string;
  events: string[];
  enabled?: boolean;
}

app.post('/api/admin/webhooks', authenticateAdmin, (req: Request<object, object, CreateWebhookRequest>, res: Response) => {
  const { name, url, events, enabled = true } = req.body;

  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'URL is required' });
    return;
  }

  try {
    new URL(url);
  } catch {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }

  if (!Array.isArray(events) || events.length === 0) {
    res.status(400).json({ error: 'At least one event is required' });
    return;
  }

  const validEvents = events.filter(e => WEBHOOK_EVENTS.includes(e as WebhookEventType));
  if (validEvents.length === 0) {
    res.status(400).json({ error: 'No valid events provided' });
    return;
  }

  const id = generateId();
  const secret = generateWebhookSecret();

  const webhook: Webhook = {
    id,
    name: name.slice(0, 100),
    url,
    events: validEvents,
    enabled,
    secret,
    createdAt: new Date(),
    lastTriggeredAt: null,
    failureCount: 0,
  };

  store.saveWebhook(webhook);

  res.status(201).json({
    id,
    name: webhook.name,
    url: webhook.url,
    events: webhook.events,
    enabled: webhook.enabled,
    secret, // Only returned on creation
    createdAt: webhook.createdAt.toISOString(),
    lastTriggeredAt: null,
    failureCount: 0,
  });
});

// Get webhook
app.get('/api/admin/webhooks/:webhookId', authenticateAdmin, (req: Request<{ webhookId: string }>, res: Response) => {
  const { webhookId } = req.params;
  const webhook = store.getWebhook(webhookId);

  if (!webhook) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }

  res.json({
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    events: webhook.events,
    enabled: webhook.enabled,
    secret: maskSecret(webhook.secret),
    createdAt: webhook.createdAt.toISOString(),
    lastTriggeredAt: webhook.lastTriggeredAt?.toISOString() || null,
    failureCount: webhook.failureCount,
  });
});

// Update webhook
interface UpdateWebhookRequest {
  name?: string;
  url?: string;
  events?: string[];
  enabled?: boolean;
}

app.put('/api/admin/webhooks/:webhookId', authenticateAdmin, (req: Request<{ webhookId: string }, object, UpdateWebhookRequest>, res: Response) => {
  const { webhookId } = req.params;
  const webhook = store.getWebhook(webhookId);

  if (!webhook) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }

  const { name, url, events, enabled } = req.body;

  if (name !== undefined) {
    webhook.name = name.slice(0, 100);
  }

  if (url !== undefined) {
    try {
      new URL(url);
      webhook.url = url;
    } catch {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }
  }

  if (events !== undefined) {
    const validEvents = events.filter(e => WEBHOOK_EVENTS.includes(e as WebhookEventType));
    if (validEvents.length === 0) {
      res.status(400).json({ error: 'No valid events provided' });
      return;
    }
    webhook.events = validEvents;
  }

  if (enabled !== undefined) {
    webhook.enabled = enabled;
  }

  store.saveWebhook(webhook);

  res.json({
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    events: webhook.events,
    enabled: webhook.enabled,
    secret: maskSecret(webhook.secret),
    createdAt: webhook.createdAt.toISOString(),
    lastTriggeredAt: webhook.lastTriggeredAt?.toISOString() || null,
    failureCount: webhook.failureCount,
  });
});

// Delete webhook
app.delete('/api/admin/webhooks/:webhookId', authenticateAdmin, (req: Request<{ webhookId: string }>, res: Response) => {
  const { webhookId } = req.params;

  if (!store.deleteWebhook(webhookId)) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }

  res.json({ success: true, message: 'Webhook deleted' });
});

// Test webhook
app.post('/api/admin/webhooks/:webhookId/test', authenticateAdmin, async (req: Request<{ webhookId: string }>, res: Response) => {
  const { webhookId } = req.params;
  const webhook = store.getWebhook(webhookId);

  if (!webhook) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }

  const testPayload = {
    id: generateId(),
    type: 'test',
    timestamp: new Date().toISOString(),
    data: {
      message: 'This is a test webhook event',
    },
  };

  const signature = crypto
    .createHmac('sha256', webhook.secret)
    .update(JSON.stringify(testPayload))
    .digest('hex');

  const startTime = Date.now();

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': 'test',
        'X-Webhook-Id': testPayload.id,
      },
      body: JSON.stringify(testPayload),
      signal: AbortSignal.timeout(10000),
    });

    const responseTime = Date.now() - startTime;

    res.json({
      success: response.ok,
      statusCode: response.status,
      responseTime,
      error: response.ok ? null : `HTTP ${response.status}`,
    });
  } catch (error) {
    const responseTime = Date.now() - startTime;
    res.json({
      success: false,
      statusCode: 0,
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// WEBSOCKET SERVER FOR REAL-TIME ADMIN UPDATES
// ============================================================================

const wss = new WebSocketServer({ server, path: '/ws/admin' });

// Store authenticated WebSocket connections with custom properties
interface AuthenticatedWs {
  ws: WebSocket;
  isAuthenticated: boolean;
  token: string | null;
}

const authenticatedClients = new Set<AuthenticatedWs>();

// Broadcast data to all authenticated clients
function broadcastToAdmins(type: string, data: unknown): void {
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  authenticatedClients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN && client.isAuthenticated) {
      client.ws.send(message);
    }
  });
}

// Get current admin data for WebSocket clients
async function getAdminData(): Promise<{
  stats: {
    activeRooms: number;
    totalParticipants: number;
    apiKeysCount: number;
    webhooksCount: number;
    uptime: number;
    version: string;
  };
  rooms: Array<{
    name: string;
    displayName: string | null;
    numParticipants: number;
    createdAt: string | null;
    maxParticipants: number;
  }>;
  apiKeys: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    permissions: string[];
    createdAt: string;
    lastUsedAt: string | null;
  }>;
  webhooks: Array<{
    id: string;
    name: string;
    url: string;
    events: string[];
    enabled: boolean;
    secret: string;
    createdAt: string;
    lastTriggeredAt: string | null;
    failureCount: number;
  }>;
}> {
  let rooms: Array<{
    name: string;
    displayName: string | null;
    numParticipants: number;
    createdAt: string | null;
    maxParticipants: number;
  }> = [];
  let totalParticipants = 0;

  try {
    const liveKitRooms = await roomService.listRooms();
    rooms = liveKitRooms.map((room) => {
      const metadata = roomMetadata.get(room.name);
      return {
        name: room.name,
        displayName: metadata?.displayName || null,
        numParticipants: room.numParticipants || 0,
        createdAt: room.creationTime ? new Date(Number(room.creationTime) * 1000).toISOString() : null,
        maxParticipants: room.maxParticipants || 0,
      };
    });
    totalParticipants = liveKitRooms.reduce((sum, room) => sum + (room.numParticipants || 0), 0);
  } catch (error) {
    console.error('Error fetching rooms for WebSocket:', error);
  }

  return {
    stats: {
      activeRooms: rooms.length,
      totalParticipants,
      apiKeysCount: store.countApiKeys(),
      webhooksCount: store.countWebhooks(),
      uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      version: API_VERSION,
    },
    rooms,
    apiKeys: store.listApiKeys().map((key) => ({
      id: key.id,
      name: key.name,
      keyPrefix: maskApiKey(key.key),
      permissions: key.permissions,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: key.lastUsedAt?.toISOString() || null,
    })),
    webhooks: store.listWebhooks().map((webhook) => ({
      id: webhook.id,
      name: webhook.name,
      url: webhook.url,
      events: webhook.events,
      enabled: webhook.enabled,
      secret: maskSecret(webhook.secret),
      createdAt: webhook.createdAt.toISOString(),
      lastTriggeredAt: webhook.lastTriggeredAt?.toISOString() || null,
      failureCount: webhook.failureCount,
    })),
  };
}

// WebSocket connection handler
wss.on('connection', (ws: WebSocket) => {
  // Create client wrapper
  const client: AuthenticatedWs = {
    ws,
    isAuthenticated: false,
    token: null,
  };

  ws.on('message', async (messageData: Buffer) => {
    try {
      const message = JSON.parse(messageData.toString());

      // Handle authentication
      if (message.type === 'auth') {
        const token = message.token;

        // Check if it's a valid session token
        const session = store.getAdminSession(token);
        if (session && session.expiresAt > new Date()) {
          client.isAuthenticated = true;
          client.token = token;
          authenticatedClients.add(client);

          // Send initial data acknowledgment
          const data = await getAdminData();
          ws.send(JSON.stringify({ type: 'init', data, timestamp: new Date().toISOString() }));
        } else if (passwordLoginEnabled() && adminPasswordHash && verifyPassword(token, adminPasswordHash)) {
          client.isAuthenticated = true;
          client.token = token;
          authenticatedClients.add(client);

          // Send initial data acknowledgment
          const data = await getAdminData();
          ws.send(JSON.stringify({ type: 'init', data, timestamp: new Date().toISOString() }));
        } else {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
          ws.close();
        }
      }

      // Handle refresh request
      if (message.type === 'refresh' && client.isAuthenticated) {
        const data = await getAdminData();
        ws.send(JSON.stringify({ type: 'update', data, timestamp: new Date().toISOString() }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid message' }));
    }
  });

  ws.on('close', () => {
    authenticatedClients.delete(client);
  });

  ws.on('error', () => {
    authenticatedClients.delete(client);
  });

  // Send authentication required message
  ws.send(JSON.stringify({ type: 'auth_required' }));
});

// Periodic broadcast of admin data (every 5 seconds)
setInterval(async () => {
  if (authenticatedClients.size > 0) {
    const data = await getAdminData();
    broadcastToAdmins('update', data);
  }
}, 5000);

// ============================================================================
// START SERVER
// ============================================================================

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    MEET API Server                              ║
╠════════════════════════════════════════════════════════════════╣
║  Version:    ${API_VERSION.padEnd(48)}║
║  Port:       ${String(PORT).padEnd(48)}║
║  CORS:       ${CORS_ORIGIN.slice(0, 48).padEnd(48)}║
║  LiveKit:    Ready                                              ║
║  Admin:      ${(ADMIN_USERNAME ? `User: ${ADMIN_USERNAME}` : 'First login sets credentials').padEnd(48)}║
║  WebSocket:  ws://localhost:${PORT}/ws/admin${' '.repeat(27)}║
║  API Docs:   http://localhost:${PORT}/api/docs${' '.repeat(26)}║
╚════════════════════════════════════════════════════════════════╝
  `);
});
