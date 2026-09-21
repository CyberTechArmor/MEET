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
| `hideEndCall` | boolean | No | Hide leave/end call buttons (for iframe embeds where the host page manages call lifecycle) |
| `embed` | boolean | No | Embed mode: skip the create/join configuration screen. Only a name prompt is shown (none at all when `name` is given). **Implied automatically inside an iframe**; pass `embed=0` to force the full screen. `joinUrl` from `POST /api/rooms` already includes `embed=1`. |

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

# Iframe embed without end call buttons
https://meet.example.com/?room=ABC123&name=John&hideEndCall=true

# API-created meeting: straight into the room, no configuration screen
https://meet.example.com/?room=ABC123&embed=1
```

### Embed mode

When a meeting is created through the API (or the page is loaded inside an
iframe) the participant should never see MEET's own "Create a new room / Join
existing room" configuration screen — the room has already been decided by
your application. Embed mode does exactly that:

- `?room=ABC123&name=John&embed=1` → joins immediately as John, no UI before the call.
- `?room=ABC123&embed=1` → also joins immediately. The name is, in order: the
  session saved before a reload of the same room, the last name this browser
  joined with, or a generated `Guest 1234`. Pass `name` whenever your app
  knows it.
- `?room=ABC123&embed=1&autojoin=false` → shows a single "Your name" prompt
  instead of joining on its own.
- Inside an iframe, embed mode is on by default even without the parameter.
- **Survives drops.** If the connection is lost for a reason the participant
  didn't choose (network, server restart, the host page reloading the
  iframe), the app reconnects on its own with backoff (immediate, then
  1.5 s doubling to 15 s, up to 12 attempts). Leaving on purpose, the
  meeting ending, being removed, or the same identity joining from another
  window shows a short status and a **Rejoin** button instead.
- Every open window gets its own participant identity (`p_<device id>-<tab id>`),
  never derived from the name, so the same person can join from a laptop and a
  phone, two windows on one machine work, and two people with the same name
  never evict each other. **Invite links should therefore carry only `room`**
  (and `embed=1` / `hideEndCall` as needed) — never the inviter's `name`.
- The admin gear button is hidden in embed mode.
- **Small windows.** Below 640×480 the room switches to a compact layout:
  only the other person (or the shared screen) is shown, the self view and
  room badge are hidden, and the controls shrink to small icons. Nothing to
  configure; it follows the iframe's size.

### Embed messaging API (postMessage)

Inside an iframe, MEET talks to the embedding page over `window.postMessage`
so the host can follow and drive the call **without touching the iframe's
DOM**. All payloads are plain JSON with no tokens or credentials.

The same bridge works when you open MEET in its own window or tab with
`window.open()` instead of framing it: events then go to `window.opener`.
See [Popup mode](#popup-mode-open-meet-in-its-own-window).

**Events (MEET → host)** — every message has `source: "meet"`:

| `type` | Payload | When |
|--------|---------|------|
| `meet:ready` | `embed, room, version` | App loaded |
| `meet:joining` | `room, name` | Connecting |
| `meet:joined` | `room, identity, name, isHost, joinedAt` (ms epoch) | In the room — start your timer from `joinedAt` |
| `meet:reconnecting` | `room` | Network hiccup; LiveKit is recovering |
| `meet:left` | `room, reason, willRejoin` | `reason`: `left`, `ended`, `removed`, `duplicate`, `connection-lost`; `willRejoin` true when MEET is about to reconnect on its own |
| `meet:participants` | `room, count, participants[{identity,name}]` | Someone joined/left (count includes you) |
| `meet:screenshare` | `room, active, by, local` | Screen share started/stopped |
| `meet:media` | `room, audio, video` | Your mic/camera state changed |
| `meet:layout` | `compact` | Compact layout toggled |
| `meet:pip` | `open` | MEET's own picture-in-picture opened/closed |
| `meet:state` | `state{…}` | Reply to `meet:get-state` |
| `meet:error` | `command, message` | A command failed |

**Commands (host → MEET)** — `iframe.contentWindow.postMessage({ type, … }, '*')`,
or `win.postMessage({ type, … }, meetOrigin)` for a window you opened:

| `type` | Fields | Effect |
|--------|--------|--------|
| `meet:leave` | | Leave the call (use this from your Close button) |
| `meet:end` | | End the meeting for everyone (host only) |
| `meet:mute` | `audio?`, `video?` (true = muted) | Mute/unmute |
| `meet:screenshare` | `enabled` | Stop sharing (`false`). Starting needs a click inside MEET — browsers require it |
| `meet:compact` | `mode: 'auto' \| 'on' \| 'off'` | Force the compact layout regardless of size (e.g. while your window is in its PiP form) |
| `meet:hideEndCall` | `hide` | Show/hide MEET's leave buttons |
| `meet:pip` | `open?` | Open/close/toggle MEET's own picture-in-picture (needs user activation inside MEET — see below) |
| `meet:fullscreen` | `enter?` | Fullscreen the MEET document (needs delegated activation — see below) |
| `meet:get-state` | | Ask for a `meet:state` snapshot |

```js
const meet = document.getElementById('meet');           // the <iframe>
window.addEventListener('message', (e) => {
  if (e.data?.source !== 'meet') return;
  if (e.data.type === 'meet:joined') startTimer(e.data.joinedAt);
  if (e.data.type === 'meet:left' && !e.data.willRejoin) closeCallWindow();
});
closeButton.onclick = () => meet.contentWindow.postMessage({ type: 'meet:leave' }, '*');
```

### Fullscreen and picture-in-picture without reloading

- **Fullscreen:** call `iframe.requestFullscreen()` from your own button. The
  iframe element itself goes fullscreen; nothing is re-mounted and the call
  continues. (Do **not** render the iframe into a different "fullscreen"
  container — that reloads it.)
- **Picture-in-picture, option A (recommended):** keep the iframe exactly
  where it is and shrink/move its *wrapper* with CSS, sending
  `meet:compact` `{ mode: 'on' }` so MEET drops to the compact layout even if
  the box is still large. Your PiP is then just a small floating box.
- **Picture-in-picture, option B (browser floating video):** MEET's own PiP
  button opens the browser's picture-in-picture on the other person's video
  (or the shared screen) *from inside the iframe*, so nothing reloads and
  the call continues. It needs `allow="picture-in-picture"` on the iframe
  and a click inside MEET — browsers refuse `meet:pip` sent from your page
  without a gesture inside the frame, and the richer Document
  Picture-in-Picture API is only allowed from a top-level page, so MEET
  uses it only when it is not embedded. Never move the iframe into a
  Document PiP window of your own — that reloads it.
- **Desktop (Electron) hosts:** the cleanest PiP is not a DOM change at all —
  resize the BrowserWindow and `win.setAlwaysOnTop(true)`; send
  `meet:compact` `{ mode: 'on' }` so MEET shows only the other person.

### Popup mode (open MEET in its own window)

A host does not have to frame MEET. `window.open()` gives you a call in its
own window, and the messaging API above works there unchanged — MEET posts
its events to `window.opener` instead of `window.parent`, and you send
commands to the window handle.

Two reasons to reach for it:

1. **The full picture-in-picture.** Document Picture-in-Picture — a real
   always-on-top window, not a floating video — is only allowed from a
   top-level page. In a popup MEET *is* top-level, so its PiP button opens
   that window. Inside an iframe the same button falls back to the browser's
   video picture-in-picture.
2. **A way through a hostile embedding context.** Framing can be refused by
   headers, by a sandbox, or by a mobile browser's anti-tracking. A window
   is first-party: MEET asks for its own camera and microphone, so nothing
   has to be delegated.

```js
const MEET_ORIGIN = 'https://meet.example.com';

function openMeetWindow(url) {
  // Desktop gets a real window; phones and tablets have no popup windows,
  // so window.open() is a tab there — which is the right answer anyway.
  const desktop = window.matchMedia('(min-width: 900px) and (pointer: fine)').matches;
  const win = window.open(url, 'meet-call', desktop ? 'popup,width=980,height=660' : '');
  win?.focus();                       // a second click re-focuses the same window
  return win;
}

callButton.onclick = () => {          // must be inside a user gesture
  const win = openMeetWindow(`${MEET_ORIGIN}/?room=ABC123&embed=1`);

  window.addEventListener('message', (e) => {
    if (e.origin !== MEET_ORIGIN || e.source !== win) return;
    if (e.data?.source !== 'meet') return;
    if (e.data.type === 'meet:joined') startTimer(e.data.joinedAt);
    if (e.data.type === 'meet:left' && !e.data.willRejoin) endCall();
  });

  hangUpButton.onclick = () => win.postMessage({ type: 'meet:leave' }, MEET_ORIGIN);

  // A window closed by its own title bar cannot send meet:left — watch for it.
  const poll = setInterval(() => {
    if (win.closed) { clearInterval(poll); endCall(); }
  }, 1000);
};
```

Rules that bite if you miss them:

- **Never pass `noopener`** (or `rel="noopener"` on a link). It severs
  `window.opener`, and with it every event MEET would send you. Cross-origin
  `opener` only permits `postMessage` — it cannot read your page.
- **Open it from a click.** A popup without a user gesture is blocked.
- **Name the window** (`'meet-call'` above) and `focus()` it, so a second
  click brings the existing call forward instead of starting another.
- **Pass `embed=1`** so MEET joins straight away instead of showing the
  create/join screen, and a `name` if you know who this is.
- **Leave `hideEndCall` off**, or give the person your own way out: in a
  window there is no host UI around the frame to hang up from. Your own
  button sends `meet:leave`.
- **Check `e.source` and `e.origin`** on every message, as above.

| | iframe | popup window (desktop) | tab (mobile) |
|---|---|---|---|
| Messaging API | ✅ via `window.parent` | ✅ via `window.opener` | ✅ via `window.opener` |
| Document PiP (own window) | ❌ top-level only | ✅ Chromium 116+ | ❌ not on mobile browsers |
| Video PiP (floating video) | ✅ needs `allow="picture-in-picture"` | ✅ | ⚠️ browser-dependent |
| Camera / mic | delegated by `allow=` | first-party to MEET | first-party to MEET |
| Your UI around the call | ✅ | ❌ separate window | ❌ separate tab |

### Your own title bar, timer and invite link

MEET never renders a window title; whatever chrome wraps the iframe is
yours. Build it from the events above rather than from the URL:

- **Timer:** start from `meet:joined.joinedAt`; stop on `meet:left`.
- **Title:** `meet:joined.name` is the local user, `meet:participants` lists
  the others — "Call with Bob" comes from there, not from the room code.
- **Invite / copy-link:** share `https://meet.example.com/?room=CODE` (add
  `embed=1` if the recipient opens it in your app). Do **not** append the
  inviter's `name` — every recipient would then join as that person.
  Identities are per device, so even a shared name cannot disconnect anyone,
  but the labels would all read the same.

### Keeping the call alive while your UI changes (PiP, minimize, tabs)

The call lives inside the iframe's page. Anything that reloads that page
ends the media session: the screen share stops (browsers require a click to
start one, so it cannot be restored automatically) and MEET rejoins the room
as a fresh participant a moment later. Two things reload an iframe even
though they look harmless:

- **Moving the iframe in the DOM** (`appendChild` into another container,
  re-parenting it under a "picture-in-picture" wrapper, React re-mounting it
  because its parent component or `key` changed).
- **Unmounting it while "minimized"** and mounting it again on restore.

Keep the same iframe element mounted for the whole call and change only its
CSS (`position`, `width`, `height`, `transform`, `visibility`, or move the
*wrapper* with CSS rather than the iframe with DOM operations). A hidden or
tiny iframe keeps publishing camera, microphone and screen share; MEET's
compact layout takes over as soon as it is small.

```html
<iframe
  src="https://meet.example.com/?room=ABC123&name=John&embed=1&hideEndCall=true"
  allow="camera; microphone; display-capture; autoplay; picture-in-picture"
  allowfullscreen
  style="border:0;width:100%;height:100%"></iframe>
```

`POST /api/rooms` returns a `joinUrl` that already carries `embed=1` and is
built from `PUBLIC_BASE_URL`, so it points at the web app even when the API
lives on its own subdomain.

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
| `deviceId` | string | No | Stable per-device-and-window id. The participant identity is derived from it, never from the name, so the same person can join from several devices and two people can share a name. Omit it and the server mints a random one. |

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
  "participantIdentity": "p_m8x3ka7b9c2d-st0zdx",
  "isHost": true
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `token` | string | JWT token for LiveKit connection |
| `roomName` | string | Sanitized room name |
| `participantName` | string | Display name shown to other participants |
| `participantIdentity` | string | Unique per device + window (`p_<deviceId>`); the display name is carried separately |
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
  "participantIdentity": "p_m8x3ka7b9c2d-st0zdx"
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
      "identity": "p_m8x3ka7b9c2d-st0zdx",
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


---

## Admin Sign-in Methods

The admin account supports three credentials. Which ones are accepted is
reported by `GET /api/admin/auth/methods` (public) so the login form can
render itself:

| Method | Endpoint(s) | Notes |
|--------|-------------|-------|
| Passkey (WebAuthn) | `POST /api/admin/webauthn/auth/options` → `POST /api/admin/webauthn/auth/verify` | Register as many devices as you like under **Settings → Passkeys**. Requires `PUBLIC_BASE_URL`. |
| Emailed one-time code | `POST /api/admin/otp/request` → `POST /api/admin/otp/verify` | Available once SMTP is configured **and verified** (see below). 6 digits, 10-minute validity, 5 attempts, one code per 30 s. |
| Password | `POST /api/admin/login` | Accepted only while email sign-in is **not** verified. Returns `403 PASSWORD_LOGIN_DISABLED` afterwards. |

### SMTP configuration (email sign-in)

```
GET    /api/admin/smtp              current settings (password never returned)
PUT    /api/admin/smtp              { host, port, secure, username, password, fromAddress, adminEmail }
DELETE /api/admin/smtp              forget settings → password login re-enabled
POST   /api/admin/smtp/test         email a test code to adminEmail
POST   /api/admin/smtp/test/verify  { ticket, code } → marks SMTP verified
```

Password login is switched off **only** at the moment a test code has been
confirmed, so a mistyped host or wrong credentials can never lock you out.
Changing any delivery field (host, port, TLS, username, password, from
address, admin address) resets the verification, and the password works again
until a new test code is confirmed.

**Recovery.** If the mail server stops delivering and no passkey is
registered, run this inside the API container to forget the SMTP settings and
restore password login:

```bash
docker compose exec meet-api node dist/reset-admin.js --clear-smtp
docker compose restart meet-api
```

---

## Admin Profile

Everything about the signed-in admin lives under **Account & Security** in the
admin panel: profile, passkeys, email sign-in (SMTP) and the directory (LDAP).

```
GET  /api/admin/profile                 who is signed in (local / LDAP admin / API key), sign-in method summary, active sessions
PUT  /api/admin/profile                 { username?, currentPassword, newPassword? } — local account only; current password always required
POST /api/admin/sessions/revoke-others  sign out every other session of the current admin
```

`PUT` is refused with `409` when the credentials come from
`MEET_ADMIN_USERNAME` / `MEET_ADMIN_PASSWORD`, and with `403` for LDAP admins
(their identity is managed in the directory).

---

## Directory Integration (LDAP / LDAPS)

Off by default. Configure it under **Settings → Directory (LDAP / LDAPS)** or
through the API. Works with Active Directory, OpenLDAP, FreeIPA and any other
LDAP v3 server over `ldap://` (optionally with StartTLS) or `ldaps://`, with an
optional private-CA certificate.

Once a connection is saved and **Enable LDAP** is on, two independent switches
decide what it is used for:

| Switch | Effect |
|--------|--------|
| **Require directory sign-in to use the meeting frontend** | Participants see an LDAP sign-in screen before the join screen. The web app then sends a 12-hour participant session as `Authorization: Bearer` on `POST /api/token` and `GET /api/room-code`; without it both answer `401 LDAP_LOGIN_REQUIRED`. API-key callers are exempt. |
| **Allow LDAP admins to sign in to this panel** | Directory users you pick (search the directory, click **Make admin**) can sign in to the admin panel with their directory username or email and password through the normal `POST /api/admin/login`. |

A signed-in **LDAP admin** can **disable the local account**: the built-in
admin's password, passkeys and emailed codes all stop working and its sessions
end. Only an LDAP admin can re-enable it. Changes that would leave nobody able
to sign in (turning LDAP admins off, removing LDAP, or removing the last LDAP
admin while the local account is disabled) are refused with
`409 WOULD_LOCK_OUT`.

### Endpoints

```
GET    /api/admin/auth/methods          now also reports ldap + localAccountEnabled
GET    /api/admin/ldap                   settings (bind password never returned)
PUT    /api/admin/ldap                   partial update — see fields below
DELETE /api/admin/ldap                   forget settings and all LDAP admins
POST   /api/admin/ldap/test              connect + bind + one search with the saved settings
GET    /api/admin/ldap/search?q=         directory users (max 25) with isAdmin flag
GET    /api/admin/ldap/admins            LDAP admins
POST   /api/admin/ldap/admins            { dn } — grant admin access (DN is verified in the directory)
DELETE /api/admin/ldap/admins/{id}       revoke
POST   /api/admin/local-account/disable  LDAP admins only
POST   /api/admin/local-account/enable   LDAP admins only

POST   /api/auth/ldap/login              participant sign-in → { token, expiresAt, username, displayName }
GET    /api/auth/me                      validate a participant session
POST   /api/auth/logout                  end it
GET    /api/status                       now includes ldapRequired
```

### Settings fields

| Field | Default | Notes |
|-------|---------|-------|
| `url` | | `ldap://host:389` or `ldaps://host:636` |
| `startTls` | `false` | Upgrade an `ldap://` connection with StartTLS before binding |
| `tlsRejectUnauthorized` | `true` | Verify the server certificate |
| `caCert` | | PEM bundle for a private CA (LDAPS / StartTLS) |
| `bindDn` / `bindPassword` | | Service account used to search for users. Blank = anonymous search |
| `baseDn` | | Where users are searched |
| `userFilter` | `(&(\|(objectClass=person)(objectClass=user))(\|(uid={{username}})(sAMAccountName={{username}})(mail={{username}})))` | `{{username}}` is replaced with the (escaped) value the user typed |
| `searchFilter` | `(&(\|(objectClass=person)(objectClass=user))(\|(uid=*{{q}}*)(sAMAccountName=*{{q}}*)(cn=*{{q}}*)(displayName=*{{q}}*)(mail=*{{q}}*)))` | Admin picker; `{{q}}` is the search text |
| `usernameAttribute` | `uid` | Use `sAMAccountName` for Active Directory |
| `displayNameAttribute` | `displayName` | Falls back to `cn` |
| `emailAttribute` | `mail` | |
| `timeoutMs` | `8000` | Connect and operation timeout |
| `requireForFrontend` | `false` | Gate the meeting frontend |
| `adminsEnabled` | `false` | Allow LDAP admins into the admin panel |

Authentication is search-then-bind: the service account finds the user's DN
with `userFilter`, then a second connection binds as that DN with the supplied
password. Empty passwords are rejected before reaching the directory. Filter
values are escaped per RFC 4515.

**Recovery.** From inside the API container:

```bash
# Re-enable the local admin account after an LDAP admin disabled it
docker compose exec meet-api node dist/reset-admin.js --enable-local
# Forget the LDAP settings and every LDAP admin
docker compose exec meet-api node dist/reset-admin.js --clear-ldap
docker compose restart meet-api
```
