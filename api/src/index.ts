import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const app = express();

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 8080;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'http://localhost:7880';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// Admin configuration
// MEET_ADMIN_PASSWORD: If not set, the first login attempt sets the password
// MEET_SUPER_ADMIN: Email/identifier of the super admin (optional)
const ADMIN_PASSWORD = process.env.MEET_ADMIN_PASSWORD || '';
const SUPER_ADMIN = process.env.MEET_SUPER_ADMIN || '';

const API_VERSION = '1.0.0';
const SERVER_START_TIME = Date.now();

// Initialize RoomServiceClient for room management
const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// ============================================================================
// IN-MEMORY STORAGE (Use database in production)
// ============================================================================

interface ApiKey {
  id: string;
  name: string;
  key: string;
  keyHash: string;
  permissions: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret: string;
  createdAt: Date;
  lastTriggeredAt: Date | null;
  failureCount: number;
}

interface AdminSession {
  token: string;
  createdAt: Date;
  expiresAt: Date;
}

// Room metadata for display names
interface RoomMetadata {
  displayName: string;
  createdAt: Date;
}

// Storage
let adminPassword: string = ADMIN_PASSWORD;
let isFirstLogin = !ADMIN_PASSWORD;
const apiKeys: Map<string, ApiKey> = new Map();
const webhooks: Map<string, Webhook> = new Map();
const adminSessions: Map<string, AdminSession> = new Map();
const roomMetadata: Map<string, RoomMetadata> = new Map();

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

  for (const webhook of webhooks.values()) {
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

// Authentication middleware
interface AuthRequest extends Request {
  isAdmin?: boolean;
  apiKey?: ApiKey;
}

function authenticateAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'] as string;

  // Check API key first
  if (apiKeyHeader) {
    const keyHash = hashString(apiKeyHeader);
    for (const apiKey of apiKeys.values()) {
      if (apiKey.keyHash === keyHash) {
        apiKey.lastUsedAt = new Date();
        req.apiKey = apiKey;
        req.isAdmin = apiKey.permissions.includes('admin');
        next();
        return;
      }
    }
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  // Check Bearer token (session token or password)
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    // Check if it's a session token
    const session = adminSessions.get(token);
    if (session && session.expiresAt > new Date()) {
      req.isAdmin = true;
      next();
      return;
    }

    // Check if it's the admin password
    if (adminPassword && token === adminPassword) {
      req.isAdmin = true;
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
    for (const apiKey of apiKeys.values()) {
      if (apiKey.keyHash === keyHash) {
        apiKey.lastUsedAt = new Date();
        req.apiKey = apiKey;
        next();
        return;
      }
    }
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  // Check Bearer token
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const session = adminSessions.get(token);
    if (session && session.expiresAt > new Date()) {
      req.isAdmin = true;
      next();
      return;
    }
    if (adminPassword && token === adminPassword) {
      req.isAdmin = true;
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

// Serve OpenAPI spec
app.get('/api/openapi.yaml', (_req: Request, res: Response) => {
  const specPath = path.join(__dirname, '..', 'openapi.yaml');
  if (fs.existsSync(specPath)) {
    res.setHeader('Content-Type', 'application/x-yaml');
    res.sendFile(specPath);
  } else {
    res.status(404).json({ error: 'OpenAPI spec not found' });
  }
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
    try {
      const rooms = await roomService.listRooms([sanitizedRoomName]);
      isNewRoom = rooms.length === 0;
      isHost = isNewRoom || (rooms[0]?.numParticipants ?? 0) === 0;
    } catch (err) {
      console.warn('Could not check room status:', err);
      isHost = true;
      isNewRoom = true;
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

    res.json({
      token: jwt,
      roomName: sanitizedRoomName,
      participantName: sanitizedParticipantName,
      participantIdentity,
      isHost,
    });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Generate random room code
app.get('/api/room-code', (_req: Request, res: Response) => {
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
  password: string;
}

app.post('/api/admin/login', (req: Request<object, object, AdminLoginRequest>, res: Response) => {
  const { password } = req.body;

  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Password is required' });
    return;
  }

  // If no admin password is set, first login sets it
  if (isFirstLogin && !adminPassword) {
    adminPassword = password;
    isFirstLogin = false;
    console.log('Admin password set by first login');
  }

  if (password !== adminPassword) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  // Create session token
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  adminSessions.set(token, {
    token,
    createdAt: new Date(),
    expiresAt,
  });

  // Clean up expired sessions
  for (const [key, session] of adminSessions.entries()) {
    if (session.expiresAt < new Date()) {
      adminSessions.delete(key);
    }
  }

  res.json({
    success: true,
    token,
    expiresAt: expiresAt.toISOString(),
    isFirstLogin: !ADMIN_PASSWORD && adminSessions.size === 1,
    superAdmin: SUPER_ADMIN || undefined,
  });
});

// Admin logout
app.post('/api/admin/logout', authenticateAdmin, (req: AuthRequest, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    adminSessions.delete(token);
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
      apiKeysCount: apiKeys.size,
      webhooksCount: webhooks.size,
      uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      version: API_VERSION,
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.json({
      activeRooms: 0,
      totalParticipants: 0,
      apiKeysCount: apiKeys.size,
      webhooksCount: webhooks.size,
      uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      version: API_VERSION,
    });
  }
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
  const keys = Array.from(apiKeys.values()).map(key => ({
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

  apiKeys.set(id, apiKey);

  res.status(201).json({
    id,
    name: apiKey.name,
    key, // Only returned on creation
    permissions: apiKey.permissions,
    createdAt: apiKey.createdAt.toISOString(),
  });
});

// Revoke API key
app.delete('/api/admin/api-keys/:keyId', authenticateAdmin, (req: Request, res: Response) => {
  const { keyId } = req.params;

  if (!apiKeys.has(keyId)) {
    res.status(404).json({ error: 'API key not found' });
    return;
  }

  apiKeys.delete(keyId);
  res.json({ success: true, message: 'API key revoked' });
});

// ============================================================================
// WEBHOOK ENDPOINTS
// ============================================================================

// List webhooks
app.get('/api/admin/webhooks', authenticateAdmin, (_req: AuthRequest, res: Response) => {
  const hooks = Array.from(webhooks.values()).map(webhook => ({
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

  webhooks.set(id, webhook);

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
app.get('/api/admin/webhooks/:webhookId', authenticateAdmin, (req: Request, res: Response) => {
  const { webhookId } = req.params;
  const webhook = webhooks.get(webhookId);

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
  const webhook = webhooks.get(webhookId);

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
app.delete('/api/admin/webhooks/:webhookId', authenticateAdmin, (req: Request, res: Response) => {
  const { webhookId } = req.params;

  if (!webhooks.has(webhookId)) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }

  webhooks.delete(webhookId);
  res.json({ success: true, message: 'Webhook deleted' });
});

// Test webhook
app.post('/api/admin/webhooks/:webhookId/test', authenticateAdmin, async (req: Request, res: Response) => {
  const { webhookId } = req.params;
  const webhook = webhooks.get(webhookId);

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
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    MEET API Server                              ║
╠════════════════════════════════════════════════════════════════╣
║  Version:    ${API_VERSION.padEnd(48)}║
║  Port:       ${String(PORT).padEnd(48)}║
║  CORS:       ${CORS_ORIGIN.slice(0, 48).padEnd(48)}║
║  LiveKit:    Ready                                              ║
║  Admin:      ${(ADMIN_PASSWORD ? 'Password set' : 'First login sets password').padEnd(48)}║
║  OpenAPI:    http://localhost:${PORT}/api/openapi.yaml${' '.repeat(20)}║
╚════════════════════════════════════════════════════════════════╝
  `);
});
