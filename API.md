# MEET API Documentation

Complete API reference for the MEET video conferencing platform.

## Table of Contents

- [Overview](#overview)
- [OpenAPI Specification](#openapi-specification)
- [Join Links](#join-links)
  - [URL Parameters](#url-parameters)
  - [Generating Join Links](#generating-join-links)
  - [Programmatic Join Links](#programmatic-join-links)
- [REST API](#rest-api)
  - [Health Check](#health-check)
  - [Token Generation](#token-generation)
  - [Room Code Generation](#room-code-generation)
  - [End Meeting](#end-meeting)
- [Admin API](#admin-api)
  - [Authentication](#authentication)
  - [Admin Login](#admin-login)
  - [Server Statistics](#server-statistics)
  - [List Active Rooms](#list-active-rooms)
- [API Keys](#api-keys)
  - [List API Keys](#list-api-keys)
  - [Create API Key](#create-api-key)
  - [Revoke API Key](#revoke-api-key)
- [Webhooks](#webhooks)
  - [Webhook Events](#webhook-events)
  - [List Webhooks](#list-webhooks)
  - [Create Webhook](#create-webhook)
  - [Update Webhook](#update-webhook)
  - [Delete Webhook](#delete-webhook)
  - [Test Webhook](#test-webhook)
  - [Webhook Payload Format](#webhook-payload-format)
- [Client SDK](#client-sdk)
  - [Video Quality API](#video-quality-api)
  - [Room Management](#room-management)
  - [Session Management](#session-management)
  - [Utility Functions](#utility-functions)
- [WebRTC Configuration](#webrtc-configuration)
- [Error Handling](#error-handling)
- [Environment Variables](#environment-variables)

---

## Overview

MEET provides two API layers:

1. **REST API** - Backend endpoints for authentication and room management
2. **Client SDK** - Frontend TypeScript library for video conferencing

### Base URLs

| Environment | REST API | WebSocket (LiveKit) |
|-------------|----------|---------------------|
| Demo Mode | `http://localhost:8080` | `ws://localhost:7880` |
| With Proxy | `https://your-domain.com/api` | `wss://your-domain.com/livekit` |

---

## OpenAPI Specification

The MEET API is fully documented using OpenAPI 3.0. You can access the specification at:

```
GET /api/openapi.yaml
```

### Viewing the Specification

1. **Direct URL**: `http://localhost:8080/api/openapi.yaml`
2. **Admin Panel**: Click the gear icon on the main page, then navigate to the "Docs" tab
3. **Swagger UI**: Import the spec URL into [Swagger Editor](https://editor.swagger.io)
4. **Postman**: Import as OpenAPI collection

### Using with API Clients

```bash
# Download the spec
curl http://localhost:8080/api/openapi.yaml -o openapi.yaml

# Use with Swagger Codegen
swagger-codegen generate -i openapi.yaml -l python -o ./client
```

---

## Join Links

MEET supports URL-based join links that allow you to create shareable meeting invitations. Users can click a link to automatically join a meeting with pre-configured settings.

### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `room` | string | Yes | Room code (6 characters, e.g., `ABC123`) |
| `name` | string | No | Display name for the participant (max 50 chars) |
| `autojoin` | boolean | No | Auto-join when page loads (default: `true` if name provided) |
| `quality` | string | No | Video quality preset: `max`, `high`, `auto`, `balanced`, `low` |

### URL Examples

```
# Basic join link - user enters their name
https://meet.example.com/?room=ABC123

# Pre-filled name, auto-joins immediately
https://meet.example.com/?room=ABC123&name=John%20Doe

# Pre-filled name, but show join form first
https://meet.example.com/?room=ABC123&name=John&autojoin=false

# Join with specific video quality
https://meet.example.com/?room=ABC123&name=John&quality=max

# Full example with all parameters
https://meet.example.com/?room=ABC123&name=John%20Doe&autojoin=true&quality=high
```

### Generating Join Links

You can generate join links in multiple ways:

#### 1. In the UI

When creating a room, click the **"Copy invite link"** button to copy a shareable link.

#### 2. Manually Construct URL

Simply append query parameters to your MEET base URL:

```
https://your-meet-domain.com/?room=ROOMCODE&name=USERNAME
```

#### 3. Using the Client SDK

```typescript
import { generateJoinLink, getJoinLink } from './lib/livekit';

// Simple link with just room code
const link = getJoinLink('ABC123');
// => "https://meet.example.com/?room=ABC123"

// Full options
const link = generateJoinLink({
  room: 'ABC123',
  name: 'John Doe',
  autojoin: true,
  quality: 'high'
});
// => "https://meet.example.com/?room=ABC123&name=John%20Doe&autojoin=true&quality=high"
```

### Programmatic Join Links

For programmatic/automated meeting invitations (e.g., calendar integrations, email invites):

#### Server-Side Link Generation (Any Language)

```python
# Python example
from urllib.parse import urlencode, quote

def generate_meet_link(base_url, room_code, name=None, autojoin=True, quality=None):
    params = {'room': room_code.upper().replace('-', '')}
    if name:
        params['name'] = name
        params['autojoin'] = 'true' if autojoin else 'false'
    if quality:
        params['quality'] = quality
    return f"{base_url}?{urlencode(params)}"

# Usage
link = generate_meet_link(
    'https://meet.example.com',
    'ABC-123',
    name='John Doe',
    quality='high'
)
# => "https://meet.example.com?room=ABC123&name=John+Doe&autojoin=true&quality=high"
```

```javascript
// Node.js example
function generateMeetLink(baseUrl, roomCode, options = {}) {
  const params = new URLSearchParams();
  params.set('room', roomCode.toUpperCase().replace(/-/g, ''));

  if (options.name) {
    params.set('name', options.name);
    params.set('autojoin', options.autojoin !== false ? 'true' : 'false');
  }

  if (options.quality) {
    params.set('quality', options.quality);
  }

  return `${baseUrl}?${params.toString()}`;
}

// Usage
const link = generateMeetLink('https://meet.example.com', 'ABC-123', {
  name: 'John Doe',
  quality: 'high'
});
```

#### Use Cases

1. **Calendar Invitations**: Include join link in meeting description
2. **Email Invites**: Send personalized links with recipient's name pre-filled
3. **Embedded Links**: Add "Join Meeting" buttons to your application
4. **Kiosk Mode**: Create auto-join links for conference room displays
5. **API Integrations**: Generate links for third-party scheduling tools

#### Security Considerations

- Join links are **not authenticated** - anyone with the link can join
- For sensitive meetings, combine with room passwords (future feature)
- Links don't expire - consider generating new room codes for each meeting
- The `name` parameter is user-provided and should be treated as untrusted input

---

## REST API

### Health Check

Check if the API server is running.

```http
GET /health
```

#### Response

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

#### Status Codes

| Code | Description |
|------|-------------|
| 200 | Server is healthy |
| 503 | Server is unavailable |

---

### Token Generation

Generate a LiveKit JWT token for joining a video room.

```http
POST /api/token
Content-Type: application/json
```

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `roomName` | string | Yes | Room code/name (max 50 chars) |
| `participantName` | string | Yes | Display name (max 50 chars) |
| `deviceId` | string | No | Unique device identifier for same-name handling |

#### Example Request

```json
{
  "roomName": "ABCDEF",
  "participantName": "John Doe",
  "deviceId": "m8x3k_a7b9c2d"
}
```

#### Response

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "roomName": "ABCDEF",
  "participantName": "John Doe",
  "participantIdentity": "John Doe_m8x3k_a7b9c2d",
  "isHost": true
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `token` | string | JWT token for LiveKit connection |
| `roomName` | string | Sanitized room name |
| `participantName` | string | Display name shown to other participants |
| `participantIdentity` | string | Unique identifier combining name and device ID |
| `isHost` | boolean | `true` if first participant in room (has admin rights) |

#### Status Codes

| Code | Description |
|------|-------------|
| 200 | Token generated successfully |
| 400 | Invalid request (missing roomName or participantName) |
| 500 | Server error |

#### Error Response

```json
{
  "error": "roomName is required"
}
```

---

### Room Code Generation

Generate a random 6-character room code.

```http
GET /api/room-code
```

#### Response

```json
{
  "roomCode": "ABC123"
}
```

Room codes consist of uppercase letters (excluding I, O, L) and numbers (excluding 0, 1) for readability.

---

### End Meeting

End the meeting for all participants (host only).

```http
POST /api/end-meeting
Content-Type: application/json
```

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `roomName` | string | Yes | Room to end |
| `participantIdentity` | string | Yes | Identity of the requesting participant |

#### Example Request

```json
{
  "roomName": "ABCDEF",
  "participantIdentity": "John Doe_m8x3k_a7b9c2d"
}
```

#### Response

```json
{
  "success": true,
  "message": "Meeting ended for all participants"
}
```

#### Status Codes

| Code | Description |
|------|-------------|
| 200 | Meeting ended successfully |
| 400 | Invalid request |
| 500 | Failed to end meeting |

---

## Admin API

The Admin API provides server management capabilities including statistics, room management, API keys, and webhooks.

### Authentication

Admin endpoints require a JWT token obtained from the login endpoint. Include the token in the `Authorization` header:

```http
Authorization: Bearer <admin_token>
```

Tokens expire after 24 hours.

### Admin Login

Authenticate to access admin endpoints.

```http
POST /api/admin/login
Content-Type: application/json
```

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `password` | string | Yes | Admin password |

#### First Login Behavior

If no admin password is configured via `MEET_ADMIN_PASSWORD` environment variable, the first login will set the password. This creates a "super admin" account.

#### Example Request

```json
{
  "password": "your-secure-password"
}
```

#### Response

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresAt": "2024-01-16T10:30:00.000Z",
  "isFirstLogin": false
}
```

#### Status Codes

| Code | Description |
|------|-------------|
| 200 | Login successful |
| 401 | Invalid password |
| 500 | Server error |

---

### Server Statistics

Get server statistics including active rooms and participants.

```http
GET /api/admin/stats
Authorization: Bearer <token>
```

#### Response

```json
{
  "activeRooms": 5,
  "totalParticipants": 23,
  "apiKeysCount": 3,
  "webhooksCount": 2,
  "uptime": 86400,
  "version": "1.0.0"
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `activeRooms` | number | Number of currently active rooms |
| `totalParticipants` | number | Total participants across all rooms |
| `apiKeysCount` | number | Number of active API keys |
| `webhooksCount` | number | Number of configured webhooks |
| `uptime` | number | Server uptime in seconds |
| `version` | string | API server version |

---

### List Active Rooms

Get information about all active rooms.

```http
GET /api/admin/rooms
Authorization: Bearer <token>
```

#### Response

```json
{
  "rooms": [
    {
      "name": "ABC123",
      "numParticipants": 5,
      "createdAt": "2024-01-15T10:00:00.000Z",
      "maxParticipants": 0
    },
    {
      "name": "XYZ789",
      "numParticipants": 2,
      "createdAt": "2024-01-15T09:30:00.000Z",
      "maxParticipants": 10
    }
  ]
}
```

---

## API Keys

API keys provide programmatic access to the MEET API for third-party integrations.

### List API Keys

Get all active API keys.

```http
GET /api/admin/api-keys
Authorization: Bearer <token>
```

#### Response

```json
{
  "apiKeys": [
    {
      "id": "key_abc123",
      "name": "Production Integration",
      "keyPrefix": "meet_k1...",
      "permissions": ["rooms:read", "rooms:create", "participants:read"],
      "createdAt": "2024-01-15T10:00:00.000Z",
      "lastUsedAt": "2024-01-15T12:30:00.000Z"
    }
  ]
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique key identifier |
| `name` | string | Descriptive name for the key |
| `keyPrefix` | string | First 10 characters of the key (for identification) |
| `permissions` | string[] | List of granted permissions |
| `createdAt` | string | ISO 8601 creation timestamp |
| `lastUsedAt` | string | ISO 8601 timestamp of last use (null if never used) |

---

### Create API Key

Generate a new API key.

```http
POST /api/admin/api-keys
Authorization: Bearer <token>
Content-Type: application/json
```

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Descriptive name for the key |
| `permissions` | string[] | No | Permissions to grant (default: all) |

#### Available Permissions

| Permission | Description |
|------------|-------------|
| `rooms:read` | View room information |
| `rooms:create` | Create new rooms |
| `rooms:delete` | Delete/end rooms |
| `participants:read` | View participant information |
| `participants:remove` | Remove participants from rooms |
| `recordings:read` | View recording information |
| `recordings:manage` | Start/stop recordings |

#### Example Request

```json
{
  "name": "Calendar Integration",
  "permissions": ["rooms:read", "rooms:create"]
}
```

#### Response

```json
{
  "id": "key_xyz789",
  "name": "Calendar Integration",
  "key": "meet_k1_a8b9c2d3e4f5g6h7i8j9k0l1m2n3o4p5",
  "keyPrefix": "meet_k1_a8",
  "permissions": ["rooms:read", "rooms:create"],
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

> **Important**: The full `key` value is only returned once at creation time. Store it securely.

---

### Revoke API Key

Revoke an existing API key.

```http
DELETE /api/admin/api-keys/:id
Authorization: Bearer <token>
```

#### Response

```json
{
  "success": true,
  "message": "API key revoked"
}
```

#### Status Codes

| Code | Description |
|------|-------------|
| 200 | Key revoked successfully |
| 404 | Key not found |

---

## Webhooks

Webhooks allow you to receive real-time notifications when events occur in your MEET instance.

### Webhook Events

| Event | Description | Payload |
|-------|-------------|---------|
| `room.created` | A new room was created | `{ roomName, createdAt }` |
| `room.deleted` | A room was deleted/ended | `{ roomName, deletedAt }` |
| `participant.joined` | A participant joined a room | `{ roomName, participant, joinedAt }` |
| `participant.left` | A participant left a room | `{ roomName, participant, leftAt }` |
| `recording.started` | Recording started in a room | `{ roomName, recordingId, startedAt }` |
| `recording.stopped` | Recording stopped in a room | `{ roomName, recordingId, stoppedAt }` |

---

### List Webhooks

Get all configured webhooks.

```http
GET /api/admin/webhooks
Authorization: Bearer <token>
```

#### Response

```json
{
  "webhooks": [
    {
      "id": "wh_abc123",
      "name": "Slack Notifications",
      "url": "https://hooks.slack.com/services/...",
      "events": ["room.created", "room.deleted"],
      "enabled": true,
      "secret": "whsec_...",
      "createdAt": "2024-01-15T10:00:00.000Z",
      "lastTriggeredAt": "2024-01-15T12:30:00.000Z",
      "failureCount": 0
    }
  ]
}
```

---

### Create Webhook

Configure a new webhook endpoint.

```http
POST /api/admin/webhooks
Authorization: Bearer <token>
Content-Type: application/json
```

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Descriptive name |
| `url` | string | Yes | HTTPS endpoint URL |
| `events` | string[] | Yes | Events to subscribe to |
| `enabled` | boolean | No | Whether webhook is active (default: true) |

#### Example Request

```json
{
  "name": "Analytics Service",
  "url": "https://analytics.example.com/webhooks/meet",
  "events": ["participant.joined", "participant.left"],
  "enabled": true
}
```

#### Response

```json
{
  "id": "wh_xyz789",
  "name": "Analytics Service",
  "url": "https://analytics.example.com/webhooks/meet",
  "events": ["participant.joined", "participant.left"],
  "enabled": true,
  "secret": "whsec_a1b2c3d4e5f6g7h8i9j0",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "lastTriggeredAt": null,
  "failureCount": 0
}
```

---

### Update Webhook

Update an existing webhook configuration.

```http
PUT /api/admin/webhooks/:id
Authorization: Bearer <token>
Content-Type: application/json
```

#### Request Body

All fields are optional - only include fields you want to update.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | New name |
| `url` | string | New endpoint URL |
| `events` | string[] | New event subscriptions |
| `enabled` | boolean | Enable/disable webhook |

#### Example Request

```json
{
  "enabled": false
}
```

#### Response

Returns the updated webhook object.

---

### Delete Webhook

Remove a webhook configuration.

```http
DELETE /api/admin/webhooks/:id
Authorization: Bearer <token>
```

#### Response

```json
{
  "success": true,
  "message": "Webhook deleted"
}
```

---

### Test Webhook

Send a test event to verify webhook configuration.

```http
POST /api/admin/webhooks/:id/test
Authorization: Bearer <token>
```

#### Response

```json
{
  "success": true,
  "message": "Test webhook sent"
}
```

---

### Webhook Payload Format

All webhook payloads follow this structure:

```json
{
  "id": "evt_abc123xyz",
  "event": "participant.joined",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "data": {
    "roomName": "ABC123",
    "participant": {
      "identity": "John Doe_m8x3k",
      "name": "John Doe"
    },
    "joinedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### Webhook Security

Each webhook includes a signature for verification:

```http
X-Webhook-Signature: sha256=a1b2c3d4e5f6...
X-Webhook-Timestamp: 1705316400
```

#### Verifying Signatures (Node.js)

```javascript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signature, timestamp, secret) {
  const signedPayload = `${timestamp}.${JSON.stringify(payload)}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(`sha256=${expectedSignature}`)
  );
}
```

#### Verifying Signatures (Python)

```python
import hmac
import hashlib
import json

def verify_webhook_signature(payload, signature, timestamp, secret):
    signed_payload = f"{timestamp}.{json.dumps(payload)}"
    expected = hmac.new(
        secret.encode(),
        signed_payload.encode(),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, f"sha256={expected}")
```

---

## Client SDK

The client SDK is located at `frontend/src/lib/livekit.ts`.

### Video Quality API

MEET supports configurable video quality presets for different use cases.

#### Quality Presets

| Preset | Resolution | Max Bitrate | Best For |
|--------|------------|-------------|----------|
| `max` | 2160p (4K) | ~8 Mbps | High-bandwidth, quality-critical |
| `high` | 1080p (Full HD) | ~3 Mbps | Standard video calls (default) |
| `auto` | Up to 1080p | Adaptive | Most use cases |
| `balanced` | 720p (HD) | ~1.5 Mbps | Average network conditions |
| `low` | 360p | ~500 Kbps | Poor network, mobile data |

#### Type Definitions

```typescript
type VideoQualityPreset = 'auto' | 'high' | 'max' | 'balanced' | 'low';

interface VideoQualityConfig {
  captureResolution: VideoPreset;
  simulcastLayers: VideoPreset[];
  videoCodec: 'vp8' | 'vp9' | 'h264';
  screenSharePreset: ScreenSharePreset;
  audioDtx: boolean;
  audioRed: boolean;
}
```

#### Functions

##### `setVideoQualityPreset(preset: VideoQualityPreset): void`

Set the video quality preset for subsequent room connections.

```typescript
import { setVideoQualityPreset } from './lib/livekit';

// Set to maximum quality
setVideoQualityPreset('max');

// Set to adaptive mode
setVideoQualityPreset('auto');
```

##### `getVideoQualityPreset(): VideoQualityPreset`

Get the current video quality preset.

```typescript
import { getVideoQualityPreset } from './lib/livekit';

const currentPreset = getVideoQualityPreset();
console.log(currentPreset); // 'high'
```

##### `getQualityConfig(preset?: VideoQualityPreset): VideoQualityConfig`

Get the full configuration for a quality preset.

```typescript
import { getQualityConfig } from './lib/livekit';

const config = getQualityConfig('high');
console.log(config);
// {
//   captureResolution: VideoPresets.h1080,
//   simulcastLayers: [VideoPresets.h360, VideoPresets.h540, VideoPresets.h720],
//   videoCodec: 'vp9',
//   screenSharePreset: ScreenSharePresets.h1080_30fps,
//   audioDtx: true,
//   audioRed: true,
// }
```

##### `getAvailableQualityPresets(): PresetInfo[]`

Get all available presets with descriptions.

```typescript
import { getAvailableQualityPresets } from './lib/livekit';

const presets = getAvailableQualityPresets();
// [
//   { preset: 'max', name: '4K Ultra HD', description: '...', resolution: '2160p' },
//   { preset: 'high', name: 'Full HD', description: '...', resolution: '1080p' },
//   ...
// ]
```

---

### Room Management

#### `createRoom(qualityPreset?: VideoQualityPreset): Room`

Create a new LiveKit Room instance with optimized settings.

```typescript
import { createRoom } from './lib/livekit';

// Create with default quality (high/1080p)
const room = createRoom();

// Create with specific quality
const hdRoom = createRoom('max');

// Create with adaptive quality
const adaptiveRoom = createRoom('auto');
```

**Room Configuration:**
- Adaptive streaming enabled (auto-adjusts quality)
- Dynacast enabled (bandwidth optimization)
- VP9 codec for better compression
- Audio noise suppression and echo cancellation
- Simulcast for multi-quality streaming

#### `getToken(roomName: string, participantName: string): Promise<TokenResponse>`

Fetch a JWT token for joining a room.

```typescript
import { getToken } from './lib/livekit';

try {
  const response = await getToken('ABC123', 'John Doe');
  console.log(response.token);
  console.log(response.isHost); // true if first in room
} catch (error) {
  console.error('Failed to get token:', error.message);
}
```

#### `getLiveKitUrl(): string`

Get the LiveKit WebSocket URL.

```typescript
import { getLiveKitUrl } from './lib/livekit';

const url = getLiveKitUrl();
// Demo: 'ws://localhost:7880'
// Proxy: 'wss://your-domain.com/livekit'
```

#### `endMeetingForAll(roomName: string, participantIdentity: string): Promise<void>`

End the meeting for all participants (host only).

```typescript
import { endMeetingForAll } from './lib/livekit';

try {
  await endMeetingForAll('ABC123', 'John Doe_m8x3k');
  console.log('Meeting ended');
} catch (error) {
  console.error('Failed to end meeting:', error.message);
}
```

---

### Session Management

#### `saveSession(roomCode: string, displayName: string, isHost?: boolean): void`

Save session data for auto-rejoin on page refresh.

```typescript
import { saveSession } from './lib/livekit';

saveSession('ABC123', 'John Doe', true);
```

#### `getSavedSession(): SessionData | null`

Get saved session if valid (expires after 1 hour).

```typescript
import { getSavedSession } from './lib/livekit';

const session = getSavedSession();
if (session) {
  console.log(`Rejoin room ${session.roomCode} as ${session.displayName}`);
}
```

#### `clearSession(): void`

Clear the saved session.

```typescript
import { clearSession } from './lib/livekit';

clearSession();
```

#### `getDeviceId(): string`

Get or generate a unique device identifier (persisted in localStorage).

```typescript
import { getDeviceId } from './lib/livekit';

const deviceId = getDeviceId();
// 'lx5k3m_a8b2c9d'
```

---

### Join Link API

Functions for creating and parsing shareable meeting links.

#### Type Definitions

```typescript
interface JoinLinkParams {
  room: string | null;      // Parsed room code
  name: string | null;      // Display name
  autojoin: boolean;        // Whether to auto-join
  quality: VideoQualityPreset | null;  // Quality preset
}

interface JoinLinkOptions {
  room: string;             // Room code (required)
  name?: string;            // Display name (optional)
  autojoin?: boolean;       // Auto-join flag (default: true if name provided)
  quality?: VideoQualityPreset;  // Quality preset (optional)
}
```

#### `parseJoinLink(): JoinLinkParams`

Parse join link parameters from the current URL.

```typescript
import { parseJoinLink } from './lib/livekit';

// URL: https://meet.example.com/?room=ABC123&name=John&autojoin=true
const params = parseJoinLink();
console.log(params);
// {
//   room: 'ABC123',
//   name: 'John',
//   autojoin: true,
//   quality: null
// }

// Auto-join if all required params present
if (params.room && params.name && params.autojoin) {
  await connect(params.room, params.name);
}
```

#### `generateJoinLink(options: JoinLinkOptions): string`

Generate a full join link URL with the specified options.

```typescript
import { generateJoinLink } from './lib/livekit';

// Basic link
const link = generateJoinLink({ room: 'ABC123' });
// => "https://meet.example.com/?room=ABC123"

// With pre-filled name (auto-joins by default)
const link = generateJoinLink({
  room: 'ABC123',
  name: 'John Doe'
});
// => "https://meet.example.com/?room=ABC123&name=John%20Doe&autojoin=true"

// With all options
const link = generateJoinLink({
  room: 'ABC123',
  name: 'John Doe',
  autojoin: false,  // Show form instead of auto-joining
  quality: 'max'
});
// => "https://meet.example.com/?room=ABC123&name=John%20Doe&autojoin=false&quality=max"
```

#### `getJoinLink(roomCode: string): string`

Simple helper to generate a basic join link with just the room code.

```typescript
import { getJoinLink } from './lib/livekit';

const link = getJoinLink('ABC123');
// => "https://meet.example.com/?room=ABC123"
```

#### `hasJoinLinkParams(): boolean`

Check if the current URL contains join link parameters.

```typescript
import { hasJoinLinkParams } from './lib/livekit';

if (hasJoinLinkParams()) {
  const params = parseJoinLink();
  // Handle join link...
}
```

#### `clearJoinLinkParams(): void`

Remove join link parameters from the URL without page reload.

```typescript
import { clearJoinLinkParams } from './lib/livekit';

// After processing join link, clean up the URL
clearJoinLinkParams();
// URL changes from /?room=ABC123&name=John to /
```

---

### Utility Functions

#### `formatRoomCode(code: string): string`

Format room code for display (adds dash).

```typescript
import { formatRoomCode } from './lib/livekit';

formatRoomCode('ABCDEF'); // 'ABC-DEF'
formatRoomCode('abc123'); // 'ABC-123'
```

#### `parseRoomCode(input: string): string`

Parse and sanitize room code input.

```typescript
import { parseRoomCode } from './lib/livekit';

parseRoomCode('abc-def'); // 'ABCDEF'
parseRoomCode('ABC 123'); // 'ABC123'
parseRoomCode('abc-def-ghi'); // 'ABCDEF' (max 6 chars)
```

---

## WebRTC Configuration

### Video Encoding

MEET uses VP9 codec by default with VP8 fallback for compatibility.

| Quality | Resolution | Frame Rate | Target Bitrate |
|---------|------------|------------|----------------|
| 4K (max) | 3840×2160 | 30 fps | 4000-8000 kbps |
| 1080p (high) | 1920×1080 | 30 fps | 1500-3000 kbps |
| 720p (balanced) | 1280×720 | 30 fps | 800-1500 kbps |
| 540p (simulcast) | 960×540 | 30 fps | 500-1000 kbps |
| 360p (low) | 640×360 | 30 fps | 300-500 kbps |
| 180p (simulcast) | 320×180 | 15 fps | 100-200 kbps |

### Simulcast Layers

Simulcast allows sending multiple quality layers so recipients can choose based on their bandwidth.

**Max Quality Preset:**
```
Capture: 2160p → Simulcast: [360p, 720p, 1080p]
```

**High Quality Preset:**
```
Capture: 1080p → Simulcast: [360p, 540p, 720p]
```

**Auto Quality Preset:**
```
Capture: 1080p → Simulcast: [180p, 360p, 720p]
```

### Screen Sharing

| Preset | Resolution | Frame Rate | Use Case |
|--------|------------|------------|----------|
| max/high | 1080p | 30 fps | Presentations, demos |
| auto | 1080p | 15 fps | General screen share |
| balanced | 720p | 15 fps | Bandwidth-limited |
| low | 720p | 5 fps | Very low bandwidth |

### Audio Configuration

| Feature | Default | Description |
|---------|---------|-------------|
| Echo Cancellation | Enabled | Prevents audio feedback |
| Noise Suppression | Enabled | Reduces background noise |
| Auto Gain Control | Enabled | Normalizes volume levels |
| DTX | Enabled | Reduces bandwidth during silence |
| RED | Enabled | Redundant encoding for packet loss |

---

## Error Handling

### REST API Errors

All error responses follow this format:

```json
{
  "error": "Description of the error"
}
```

### Client SDK Errors

Token and API functions throw errors that can be caught:

```typescript
try {
  const response = await getToken('room', 'name');
} catch (error) {
  if (error instanceof Error) {
    switch (error.message) {
      case 'roomName is required':
        // Handle missing room name
        break;
      case 'participantName is required':
        // Handle missing name
        break;
      default:
        // Handle other errors
        console.error('Unexpected error:', error.message);
    }
  }
}
```

### LiveKit Connection Errors

```typescript
import { RoomEvent } from 'livekit-client';

room.on(RoomEvent.Disconnected, (reason) => {
  switch (reason) {
    case 'room_deleted':
      // Meeting was ended by host
      break;
    case 'participant_removed':
      // Kicked from meeting
      break;
    case 'connection_error':
      // Network issue
      break;
  }
});
```

---

## Environment Variables

### API Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | API server port |
| `LIVEKIT_API_KEY` | devkey | LiveKit API key |
| `LIVEKIT_API_SECRET` | secret | LiveKit API secret |
| `LIVEKIT_URL` | http://localhost:7880 | LiveKit server URL |
| `CORS_ORIGIN` | * | Allowed CORS origins |
| `MEET_ADMIN_PASSWORD` | (none) | Admin password (if not set, first login sets it) |
| `MEET_SUPER_ADMIN` | (none) | Reserved for future super admin email |

### Frontend

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | (auto-detected) | REST API URL |
| `VITE_LIVEKIT_URL` | (auto-detected) | LiveKit WebSocket URL |

**Auto-Detection Logic:**
- If running on port 80/443 (behind proxy): Uses relative URLs
- Otherwise: Assumes demo mode with API on :8080 and LiveKit on :7880

---

## Usage Examples

### Complete Connection Flow

```typescript
import {
  createRoom,
  getToken,
  getLiveKitUrl,
  saveSession,
  setVideoQualityPreset,
} from './lib/livekit';

async function joinMeeting(roomCode: string, displayName: string) {
  // 1. Set desired quality
  setVideoQualityPreset('high');

  // 2. Get authentication token
  const { token, isHost } = await getToken(roomCode, displayName);

  // 3. Create room instance
  const room = createRoom();

  // 4. Connect to LiveKit
  await room.connect(getLiveKitUrl(), token);

  // 5. Save session for rejoin capability
  saveSession(roomCode, displayName, isHost);

  // 6. Enable media
  await room.localParticipant.setCameraEnabled(true);
  await room.localParticipant.setMicrophoneEnabled(true);

  return room;
}
```

### Quality Selector Component

```typescript
import {
  getAvailableQualityPresets,
  setVideoQualityPreset,
  VideoQualityPreset
} from './lib/livekit';

function QualitySelector({ onChange }: { onChange: () => void }) {
  const presets = getAvailableQualityPresets();

  const handleChange = (preset: VideoQualityPreset) => {
    setVideoQualityPreset(preset);
    onChange();
  };

  return (
    <select onChange={(e) => handleChange(e.target.value as VideoQualityPreset)}>
      {presets.map(({ preset, name, resolution }) => (
        <option key={preset} value={preset}>
          {name} ({resolution})
        </option>
      ))}
    </select>
  );
}
```

---

## API Versioning

The current API version is **v1** (implicit). Future versions may be prefixed:
- v1: `/api/token` (current)
- v2: `/api/v2/token` (future)

---

## Rate Limiting

Currently, there is no rate limiting implemented. For production deployments, consider:

- 10 requests/minute per IP for token generation
- 100 requests/minute per IP for room code generation
- 5 requests/minute per room for end-meeting

---

## Security Considerations

1. **Token Security**: Tokens expire and should not be shared
2. **Room Codes**: Not passwords - anyone with the code can join
3. **Host Privileges**: First joiner becomes host automatically
4. **CORS**: Configure `CORS_ORIGIN` for production deployments
5. **HTTPS**: Use reverse proxy (Caddy) for production with TLS
