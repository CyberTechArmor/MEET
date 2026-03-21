# MEET Iframe Integration Guide

This document describes how to integrate MEET video conferencing into your application using iframes.

## Overview

MEET can be embedded into your application via an iframe, allowing you to add video conferencing capabilities without building a custom video UI. This is the simplest integration method and requires minimal setup.

## Server URL Configuration by Deployment Type

MEET supports multiple deployment modes, and the URL structure differs between them. Understanding which deployment you're using is critical for configuring iframe embeds and API calls correctly.

### Caddy or Host-Installed NGINX (Single URL)

Both Caddy (`docker-compose.proxy.yml`) and host-installed NGINX (`docker-compose.nginx.yml`) use **path-based routing** on a single domain:

| Service   | URL                                   |
|-----------|---------------------------------------|
| Frontend  | `https://meet.example.com/`           |
| API       | `https://meet.example.com/api/`       |
| LiveKit   | `wss://meet.example.com/livekit/`     |

**You only need one URL.** The iframe URL and API URL share the same base:

```
MEET server URL:  https://meet.example.com
Iframe embed:     https://meet.example.com/?room=ROOM_CODE
API calls:        https://meet.example.com/api/rooms
```

### ProxyPilot / External Reverse Proxy (Subdomain Routing)

External proxy managers (ProxyPilot, Nginx Proxy Manager, Traefik, etc.) that don't support path-based routing use **separate subdomains** for each service:

| Service   | URL                                     |
|-----------|-----------------------------------------|
| Frontend  | `https://meet.example.com`              |
| API       | `https://api.meet.example.com`          |
| LiveKit   | `wss://livekit.meet.example.com`        |

**The API is on a different subdomain.** When configuring integrations:

```
MEET server URL:  https://meet.example.com
Iframe embed:     https://meet.example.com/?room=ROOM_CODE
API calls:        https://api.meet.example.com/api/rooms   ← different host!
```

> **Common mistake:** Using `https://meet.example.com` for API calls on a ProxyPilot deployment will hit the frontend (not the API server), resulting in `405 Not Allowed` errors from nginx.

### How to Determine Your API URL

If you only know the MEET server URL (e.g., `https://meet.example.com`), you can determine the API URL:

1. **Try the same URL first** (Caddy/NGINX path-based routing):
   ```
   GET https://meet.example.com/api/health
   ```

2. **If that fails, try the subdomain pattern** (ProxyPilot/external proxy):
   ```
   GET https://api.meet.example.com/api/health
   ```

For programmatic integrations, you can auto-detect:

```javascript
async function detectApiUrl(meetServerUrl) {
  const url = new URL(meetServerUrl);

  // Try path-based routing first (Caddy / host NGINX)
  try {
    const resp = await fetch(`${url.origin}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) return url.origin;
  } catch {}

  // Fall back to subdomain routing (ProxyPilot / external proxy)
  const apiUrl = `${url.protocol}//api.${url.host}`;
  try {
    const resp = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) return apiUrl;
  } catch {}

  throw new Error('Could not detect MEET API URL');
}

// Usage:
// const apiUrl = await detectApiUrl('https://meet.example.com');
// fetch(`${apiUrl}/api/rooms`, { ... });
```

### Quick Reference

| Deployment                      | Compose File                       | URLs Needed | API URL Pattern         |
|---------------------------------|------------------------------------|-------------|-------------------------|
| Caddy (recommended)             | `docker-compose.proxy.yml`         | 1           | Same as frontend        |
| Host-installed NGINX            | `docker-compose.nginx.yml`         | 1           | Same as frontend        |
| ProxyPilot / External proxy     | `docker-compose.proxypilot.yml`    | 1*          | `api.{frontend domain}` |
| Demo (no proxy)                 | `docker-compose.yml`               | 1           | `http://host:8080`      |

\* You only need to enter the frontend URL. The API URL is always `api.` prefixed to the frontend domain.

## Quick Start

### Full-Featured Embed (with end call controls)

Includes leave call and end meeting buttons. Best for standalone embeds.

```html
<iframe
  src="https://your-meet-server.com/?room=ROOM_CODE&name=PARTICIPANT_NAME"
  allow="camera; microphone; display-capture; autoplay"
  style="width: 100%; height: 600px; border: none;"
></iframe>
```

### Embed Without End Call (for custom interfaces)

Hides leave call and end meeting buttons. Use this when your application manages the call lifecycle (e.g., your page has its own "End Call" button that removes or navigates away from the iframe).

```html
<iframe
  src="https://your-meet-server.com/?room=ROOM_CODE&name=PARTICIPANT_NAME&hideEndCall=true"
  allow="camera; microphone; display-capture; autoplay"
  style="width: 100%; height: 600px; border: none;"
></iframe>
```

### URL Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `room` | Yes | Room code/ID to join | `ABC123` |
| `name` | No | Pre-filled participant name | `John%20Doe` |
| `autojoin` | No | Auto-join when both room and name provided (true/false) | `true` |
| `quality` | No | Video quality preset | `auto`, `high`, `max`, `balanced`, `low` |
| `hideEndCall` | No | Hide leave/end call buttons for iframe embeds | `true` |

## Integration Steps

### Step 1: Create an API Key

1. Access the MEET admin panel at `https://your-meet-server.com` (click gear icon)
2. Log in with your admin credentials
3. Go to "API Keys" tab
4. Create a new API key with appropriate permissions
5. Save the API key securely

### Step 2: Determine Your API URL

See [Server URL Configuration by Deployment Type](#server-url-configuration-by-deployment-type) above.

- **Caddy / Host NGINX:** API URL is the same as your MEET server URL (e.g., `https://meet.example.com`)
- **ProxyPilot / External proxy:** API URL is `https://api.meet.example.com` (the `api.` subdomain of your MEET server)

### Step 3: Create a Room (Optional)

You can create rooms programmatically using the API:

```javascript
// For Caddy / Host NGINX:
const apiUrl = 'https://your-meet-server.com';
// For ProxyPilot / external proxy:
// const apiUrl = 'https://api.your-meet-server.com';

const response = await fetch(`${apiUrl}/api/rooms`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'your-api-key'
  },
  body: JSON.stringify({
    roomName: 'my-meeting-123',      // Unique room identifier
    displayName: 'Team Standup',     // Optional friendly name
    maxParticipants: 10,             // Optional limit
    emptyTimeout: 300                // Seconds before empty room is deleted
  })
});

const { room, joinUrl } = await response.json();
// joinUrl = "https://your-meet-server.com/?room=my-meeting-123"
```

### Step 4: Embed the Iframe

```html
<div id="meeting-container">
  <iframe
    id="meet-iframe"
    src="https://your-meet-server.com/?room=my-meeting-123&name=John"
    allow="camera; microphone; display-capture; autoplay"
    allowfullscreen
    style="width: 100%; height: 100%; border: none; border-radius: 8px;"
  ></iframe>
</div>
```

## Advanced Integration

### Dynamic Room Creation Flow

Here's a complete example of creating a room and embedding it:

```javascript
class MeetIntegration {
  /**
   * @param {string} apiKey - Your MEET API key
   * @param {string} serverUrl - The MEET frontend URL (e.g., 'https://meet.example.com')
   * @param {string} [apiUrl] - Optional API URL override. If omitted, auto-detected:
   *   - Caddy / Host NGINX: same as serverUrl (path-based routing)
   *   - ProxyPilot / External proxy: 'https://api.meet.example.com' (subdomain routing)
   */
  constructor(apiKey, serverUrl = 'https://your-meet-server.com', apiUrl = null) {
    this.apiKey = apiKey;
    this.serverUrl = serverUrl;
    this.apiUrl = apiUrl; // resolved lazily in _getApiUrl()
  }

  // Auto-detect API URL by trying path-based first, then subdomain
  async _getApiUrl() {
    if (this.apiUrl) return this.apiUrl;

    // Try path-based routing (Caddy / host NGINX)
    try {
      const resp = await fetch(`${this.serverUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) { this.apiUrl = this.serverUrl; return this.apiUrl; }
    } catch {}

    // Fall back to subdomain routing (ProxyPilot / external proxy)
    const url = new URL(this.serverUrl);
    this.apiUrl = `${url.protocol}//api.${url.host}`;
    return this.apiUrl;
  }

  // Create a new meeting room
  async createMeeting(options = {}) {
    const apiUrl = await this._getApiUrl();
    const response = await fetch(`${apiUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey
      },
      body: JSON.stringify({
        roomName: options.roomId || `meeting-${Date.now()}`,
        displayName: options.displayName || 'Video Meeting',
        maxParticipants: options.maxParticipants || 100,
        emptyTimeout: options.emptyTimeout || 300
      })
    });

    if (!response.ok) {
      throw new Error('Failed to create meeting');
    }

    return response.json();
  }

  // Generate join URL for a participant
  getJoinUrl(roomName, participantName, options = {}) {
    const params = new URLSearchParams();
    params.set('room', roomName);
    if (participantName) {
      params.set('name', participantName);
    }
    if (options.hideEndCall) {
      params.set('hideEndCall', 'true');
    }
    return `${this.serverUrl}/?${params.toString()}`;
  }

  // Embed meeting in a container
  // Set hideEndCall: true to hide leave/end buttons (manage call lifecycle from your UI)
  embedMeeting(containerId, roomName, participantName, options = {}) {
    const container = document.getElementById(containerId);
    const iframe = document.createElement('iframe');

    iframe.src = this.getJoinUrl(roomName, participantName, options);
    iframe.allow = 'camera; microphone; display-capture; autoplay';
    iframe.allowFullscreen = true;
    iframe.style.cssText = 'width: 100%; height: 100%; border: none;';

    container.innerHTML = '';
    container.appendChild(iframe);

    return iframe;
  }
}

// Usage - auto-detects API URL (works with any deployment type)
const meet = new MeetIntegration('your-api-key', 'https://meet.example.com');

// Or explicitly set the API URL for ProxyPilot / external proxy deployments:
// const meet = new MeetIntegration('your-api-key', 'https://meet.example.com', 'https://api.meet.example.com');

// Create a meeting
const meeting = await meet.createMeeting({
  roomId: 'project-standup',
  displayName: 'Daily Standup'
});

// Embed in your page (full-featured)
meet.embedMeeting('meeting-container', meeting.room.name, 'John Doe');

// Embed without end call buttons (your app manages call lifecycle)
meet.embedMeeting('meeting-container', meeting.room.name, 'John Doe', { hideEndCall: true });
```

### React Component Example

```jsx
import React, { useEffect, useRef, useState } from 'react';

/**
 * @param serverUrl - MEET frontend URL (used for iframe src)
 * @param apiUrl - Optional API URL override for ProxyPilot deployments.
 *                 If omitted, defaults to serverUrl (Caddy / host NGINX).
 *                 For ProxyPilot, pass 'https://api.meet.example.com'.
 */
function MeetEmbed({ roomId, participantName, hideEndCall = false, serverUrl = 'https://your-meet-server.com', apiUrl }) {
  const iframeRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);

  const meetUrl = `${serverUrl}/?room=${encodeURIComponent(roomId)}${
    participantName ? `&name=${encodeURIComponent(participantName)}` : ''
  }${hideEndCall ? '&hideEndCall=true' : ''}`;

  return (
    <div style={{ position: 'relative', width: '100%', height: '600px' }}>
      {isLoading && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#1a1a1a'
        }}>
          Loading meeting...
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={meetUrl}
        allow="camera; microphone; display-capture; autoplay"
        allowFullScreen
        onLoad={() => setIsLoading(false)}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          borderRadius: '8px',
        }}
      />
    </div>
  );
}

// Usage
function App() {
  return (
    <div>
      <h1>Video Meeting</h1>
      {/* Full-featured embed */}
      <MeetEmbed
        roomId="my-meeting-123"
        participantName="John Doe"
      />

      {/* Embed without end call buttons */}
      <MeetEmbed
        roomId="my-meeting-123"
        participantName="John Doe"
        hideEndCall
      />
    </div>
  );
}
```

### Vue Component Example

```vue
<template>
  <div class="meet-container">
    <div v-if="isLoading" class="loading-overlay">
      Loading meeting...
    </div>
    <iframe
      :src="meetUrl"
      allow="camera; microphone; display-capture; autoplay"
      allowfullscreen
      @load="isLoading = false"
      class="meet-iframe"
    />
  </div>
</template>

<script>
export default {
  name: 'MeetEmbed',
  props: {
    roomId: { type: String, required: true },
    participantName: { type: String, default: '' },
    hideEndCall: { type: Boolean, default: false },
    serverUrl: { type: String, default: 'https://your-meet-server.com' },
    // For ProxyPilot / external proxy, pass 'https://api.meet.example.com'
    // For Caddy / host NGINX, leave empty (uses serverUrl)
    apiUrl: { type: String, default: '' }
  },
  data() {
    return {
      isLoading: true
    };
  },
  computed: {
    meetUrl() {
      const params = new URLSearchParams({ room: this.roomId });
      if (this.participantName) {
        params.set('name', this.participantName);
      }
      if (this.hideEndCall) {
        params.set('hideEndCall', 'true');
      }
      return `${this.serverUrl}/?${params.toString()}`;
    }
  }
};
</script>

<style scoped>
.meet-container {
  position: relative;
  width: 100%;
  height: 600px;
}
.meet-iframe {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 8px;
}
.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1a1a1a;
  color: white;
}
</style>
```

## Security Considerations

### Required iframe Permissions

The iframe requires these permissions via the `allow` attribute:

- `camera` - Access to user's camera
- `microphone` - Access to user's microphone
- `display-capture` - Screen sharing capability
- `autoplay` - Auto-play audio/video streams

### Content Security Policy (CSP)

If your application uses CSP, ensure you allow:

```
frame-src https://your-meet-server.com;
```

### CORS Configuration

The MEET server must be configured to allow requests from your domain. This is typically handled automatically, but verify the `CORS_ORIGIN` environment variable is set correctly on the MEET server.

## API Reference

### Create Room

```
POST /api/rooms
```

**Headers:**
- `Content-Type: application/json`
- `X-API-Key: your-api-key`

**Body:**
```json
{
  "roomName": "unique-room-id",
  "displayName": "Meeting Title",
  "maxParticipants": 100,
  "emptyTimeout": 300
}
```

**Response:**
```json
{
  "success": true,
  "room": {
    "name": "unique-room-id",
    "displayName": "Meeting Title",
    "maxParticipants": 100,
    "emptyTimeout": 300,
    "createdAt": "2024-01-15T10:30:00.000Z"
  },
  "joinUrl": "https://your-meet-server.com/?room=unique-room-id"
}
```

### List Rooms

```
GET /api/rooms
```

**Headers:**
- `X-API-Key: your-api-key`

**Response:**
```json
{
  "rooms": [
    {
      "name": "room-1",
      "displayName": "Team Meeting",
      "numParticipants": 5,
      "createdAt": "2024-01-15T10:30:00.000Z",
      "maxParticipants": 100
    }
  ],
  "total": 1
}
```

### Generate Token

For advanced integrations, you can generate tokens directly:

```
POST /api/token
```

**Headers:**
- `Content-Type: application/json`
- `X-API-Key: your-api-key` (optional if public access enabled)

**Body:**
```json
{
  "roomName": "room-id",
  "participantName": "John Doe"
}
```

**Response:**
```json
{
  "token": "eyJ...",
  "roomName": "room-id",
  "participantName": "John Doe",
  "participantIdentity": "John_Doe_1705315800000",
  "isHost": true
}
```

## Troubleshooting

### 405 Not Allowed from nginx

This almost always means you're sending API requests to the **frontend URL** on a ProxyPilot / external proxy deployment. The frontend nginx only serves static files and returns 405 for POST/PUT requests.

**Fix:** Use the API subdomain for API calls:
```
# Wrong (hits frontend nginx):
POST https://meet.example.com/api/rooms  → 405 Not Allowed

# Correct (hits API server):
POST https://api.meet.example.com/api/rooms  → 200 OK
```

If you're using Caddy or host-installed NGINX, the same URL works for both frontend and API. See [Server URL Configuration by Deployment Type](#server-url-configuration-by-deployment-type).

### Camera/Microphone Not Working

1. Ensure the iframe has the correct `allow` attributes
2. Check that your page is served over HTTPS
3. Verify browser permissions for camera/microphone

### Iframe Not Loading

1. Check browser console for CSP errors
2. Verify the MEET server URL is correct
3. Ensure CORS is configured properly

### Room Not Found

1. Rooms are created on first join (unless pre-created via API)
2. Rooms may be deleted after the `emptyTimeout` period
3. Check room name for special characters (only alphanumeric, hyphens, underscores allowed)

## Best Practices

1. **Pre-create rooms** for scheduled meetings to ensure they exist
2. **Use unique room IDs** tied to your application's entities (e.g., `chat-${conversationId}`)
3. **Set appropriate limits** using admin settings to prevent resource exhaustion
4. **Handle errors gracefully** - show user-friendly messages if meeting fails to load
5. **Test on mobile** - ensure your iframe container is responsive

## Support

For issues with the MEET platform, check:
- API documentation at `/api/docs` on your MEET server
- Admin panel for server status and settings
- Server logs for detailed error information
