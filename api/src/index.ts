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
let adminUsername: string = ADMIN_USERNAME;
let adminPassword: string = ADMIN_PASSWORD;
let isFirstLogin = !ADMIN_USERNAME || !ADMIN_PASSWORD;
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
        },
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
                    joinUrl: { type: 'string', format: 'uri', description: 'URL to join the room' },
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
  username: string;
  password: string;
}

app.post('/api/admin/login', (req: Request<object, object, AdminLoginRequest>, res: Response) => {
  const { username, password } = req.body;

  if (!username || typeof username !== 'string') {
    res.status(400).json({ error: 'Username is required' });
    return;
  }

  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Password is required' });
    return;
  }

  // If no admin credentials are set, first login sets them
  if (isFirstLogin) {
    adminUsername = username;
    adminPassword = password;
    isFirstLogin = false;
    console.log(`Admin credentials set by first login: ${username}`);
  }

  if (username !== adminUsername || password !== adminPassword) {
    res.status(401).json({ error: 'Invalid username or password' });
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
    isFirstLogin: !ADMIN_USERNAME && adminSessions.size === 1,
    username: adminUsername,
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

// Create room with specific ID
interface CreateRoomRequest {
  roomName: string;
  displayName?: string;
  maxParticipants?: number;
  emptyTimeout?: number; // seconds before empty room is deleted
}

app.post('/api/rooms', authenticateApiKeyOrAdmin, async (req: Request<object, object, CreateRoomRequest>, res: Response) => {
  const { roomName, displayName, maxParticipants, emptyTimeout } = req.body;

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

    // Store metadata if display name provided
    if (displayName) {
      roomMetadata.set(sanitizedRoomName, {
        displayName,
        createdAt: new Date(),
      });
    }

    // Trigger webhook
    triggerWebhooks('room.created', { roomName: sanitizedRoomName, displayName });

    // Generate join URL
    const joinUrl = `${req.protocol}://${req.get('host')}/?room=${sanitizedRoomName}`;

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
      apiKeysCount: apiKeys.size,
      webhooksCount: webhooks.size,
      uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      version: API_VERSION,
    },
    rooms,
    apiKeys: Array.from(apiKeys.values()).map((key) => ({
      id: key.id,
      name: key.name,
      keyPrefix: maskApiKey(key.key),
      permissions: key.permissions,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: key.lastUsedAt?.toISOString() || null,
    })),
    webhooks: Array.from(webhooks.values()).map((webhook) => ({
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
        const session = adminSessions.get(token);
        if (session && session.expiresAt > new Date()) {
          client.isAuthenticated = true;
          client.token = token;
          authenticatedClients.add(client);

          // Send initial data acknowledgment
          const data = await getAdminData();
          ws.send(JSON.stringify({ type: 'init', data, timestamp: new Date().toISOString() }));
        } else if (adminPassword && token === adminPassword) {
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
