# MEET Iframe Integration Guide

This document describes how to integrate MEET video conferencing into your application using iframes.

## Overview

MEET can be embedded into your application via an iframe, allowing you to add video conferencing capabilities without building a custom video UI. This is the simplest integration method and requires minimal setup.

## Quick Start

### Basic Iframe Embedding

```html
<iframe
  src="https://your-meet-server.com/?room=ROOM_CODE&name=PARTICIPANT_NAME"
  allow="camera; microphone; display-capture; autoplay"
  style="width: 100%; height: 600px; border: none;"
></iframe>
```

### URL Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `room` | Yes | Room code/ID to join | `ABC123` |
| `name` | No | Pre-filled participant name | `John%20Doe` |

## Integration Steps

### Step 1: Create an API Key

1. Access the MEET admin panel at `https://your-meet-server.com` (click gear icon)
2. Log in with your admin credentials
3. Go to "API Keys" tab
4. Create a new API key with appropriate permissions
5. Save the API key securely

### Step 2: Create a Room (Optional)

You can create rooms programmatically using the API:

```javascript
// Create a room with a specific ID
const response = await fetch('https://your-meet-server.com/api/rooms', {
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

### Step 3: Embed the Iframe

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
  constructor(apiKey, serverUrl = 'https://your-meet-server.com') {
    this.apiKey = apiKey;
    this.serverUrl = serverUrl;
  }

  // Create a new meeting room
  async createMeeting(options = {}) {
    const response = await fetch(`${this.serverUrl}/api/rooms`, {
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
  getJoinUrl(roomName, participantName) {
    const params = new URLSearchParams();
    params.set('room', roomName);
    if (participantName) {
      params.set('name', participantName);
    }
    return `${this.serverUrl}/?${params.toString()}`;
  }

  // Embed meeting in a container
  embedMeeting(containerId, roomName, participantName) {
    const container = document.getElementById(containerId);
    const iframe = document.createElement('iframe');

    iframe.src = this.getJoinUrl(roomName, participantName);
    iframe.allow = 'camera; microphone; display-capture; autoplay';
    iframe.allowFullscreen = true;
    iframe.style.cssText = 'width: 100%; height: 100%; border: none;';

    container.innerHTML = '';
    container.appendChild(iframe);

    return iframe;
  }
}

// Usage
const meet = new MeetIntegration('your-api-key');

// Create a meeting
const meeting = await meet.createMeeting({
  roomId: 'project-standup',
  displayName: 'Daily Standup'
});

// Embed in your page
meet.embedMeeting('meeting-container', meeting.room.name, 'John Doe');
```

### React Component Example

```jsx
import React, { useEffect, useRef, useState } from 'react';

function MeetEmbed({ roomId, participantName, serverUrl = 'https://your-meet-server.com' }) {
  const iframeRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);

  const meetUrl = `${serverUrl}/?room=${encodeURIComponent(roomId)}${
    participantName ? `&name=${encodeURIComponent(participantName)}` : ''
  }`;

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
      <MeetEmbed
        roomId="my-meeting-123"
        participantName="John Doe"
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
    serverUrl: { type: String, default: 'https://your-meet-server.com' }
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
