# MEET - Architecture Documentation

## Overview

MEET is a self-hosted video conferencing platform built with modern web technologies. It provides real-time video/audio communication with features like screen sharing, room-based meetings, and host controls.

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Browser                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              React Frontend (Vite + TypeScript)          │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │   Zustand   │  │  LiveKit    │  │   Components    │  │   │
│  │  │   (State)   │  │   Client    │  │   (UI Layer)    │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                    │                           │
                    │ REST API                  │ WebSocket (WebRTC)
                    ▼                           ▼
┌─────────────────────────┐     ┌─────────────────────────────────┐
│      API Server         │     │        LiveKit Server           │
│   (Express + Node.js)   │     │     (WebRTC SFU - Go)           │
│                         │     │                                 │
│  • Token Generation     │────▶│  • Media Routing                │
│  • Room Management      │     │  • Room State                   │
│  • Host Detection       │     │  • Participant Management       │
└─────────────────────────┘     └─────────────────────────────────┘
```

### Frontend Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Framework | React 18 + TypeScript | UI rendering and type safety |
| Build Tool | Vite | Fast development and optimized builds |
| State Management | Zustand | Lightweight global state |
| WebRTC Client | livekit-client | Real-time media handling |
| Styling | Tailwind CSS | Utility-first styling |
| Notifications | react-hot-toast | User feedback |

### Backend Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| API Server | Express.js + TypeScript | REST endpoints |
| WebRTC Server | LiveKit (Go) | Media server (SFU architecture) |
| Token Auth | livekit-server-sdk | JWT token generation |
| Orchestration | Docker Compose | Service coordination |

### Key Frontend Files

```
frontend/src/
├── components/
│   ├── JoinForm.tsx       # Room creation/joining UI
│   ├── VideoRoom.tsx      # Main video conferencing view
│   ├── VideoTile.tsx      # Individual participant video
│   ├── ControlBar.tsx     # Media controls (mic, camera, etc.)
│   ├── SelfViewPip.tsx    # Picture-in-picture self view
│   └── ConfirmModal.tsx   # Reusable confirmation dialogs
├── hooks/
│   └── useLiveKit.ts      # LiveKit connection management
├── stores/
│   └── roomStore.ts       # Zustand state store
├── lib/
│   └── livekit.ts         # API calls and utilities
└── App.tsx                # Root component with routing
```

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/token` | POST | Generate LiveKit JWT token |
| `/api/room-code` | GET | Generate random room code |
| `/api/end-meeting` | POST | End meeting for all (host only) |
| `/health` | GET | Health check |

---

## Major Issues Resolved

### 1. Room Disconnect on Component Transition

**Problem**: When a user joined a room, they would immediately disconnect. The second device connecting would cause both devices to disconnect.

**Root Cause**: The `useLiveKit` hook had a `useEffect` cleanup function that disconnected the room when the component unmounted. When transitioning from `JoinForm` to `VideoRoom`, React unmounts `JoinForm`, triggering the cleanup and disconnecting the shared room instance.

**Solution**: Removed the automatic cleanup disconnect. The room now uses a singleton pattern (`sharedRoomInstance`) and is only disconnected explicitly via the `disconnect()` function. This allows the room connection to persist across component transitions.

**Files Changed**: `frontend/src/hooks/useLiveKit.ts`

---

### 2. Audio Not Working for Remote Participants

**Problem**: Users could see remote participants' video but could not hear their audio.

**Root Cause**: The `VideoTile` component was attaching video tracks to video elements but was not attaching audio tracks. LiveKit requires explicit attachment of audio tracks to audio elements for playback.

**Solution**: Added an `<audio>` element to `VideoTile` for remote participants (not local, to avoid echo). The audio track is now properly attached via `audioTrack.attach(audioRef.current)` in a useEffect.

**Files Changed**: `frontend/src/components/VideoTile.tsx`

---

### 3. Duplicate Participant Identity Conflicts

**Problem**: Two users with the same display name could not join the same room. LiveKit requires unique participant identities.

**Root Cause**: The participant identity was based solely on the display name, causing conflicts when multiple users chose the same name.

**Solution**: Implemented device-based unique identification:
- Generate a persistent device ID stored in `localStorage`
- Combine display name with device ID for unique identity: `${displayName}_${deviceId}`
- Keep display name separate (stored in token's `name` field) for UI display

**Files Changed**:
- `api/src/index.ts` - Accept deviceId, create unique identity
- `frontend/src/lib/livekit.ts` - Generate and persist device ID

---

## Current Limitations (Demo Architecture)

### 1. Single LiveKit Server Instance

**Limitation**: The demo uses a single LiveKit server instance. This creates a single point of failure and limits scalability.

**Production Recommendation**: Deploy multiple LiveKit servers behind a load balancer, or use LiveKit Cloud for managed infrastructure.

---

### 2. No Persistent Storage

**Limitation**: There is no database. Room state exists only in memory within LiveKit. Meeting history, user accounts, and chat messages are not persisted.

**Production Recommendation**: Add a database (PostgreSQL, MongoDB) for:
- User accounts and authentication
- Meeting history and analytics
- Chat message persistence
- Room configurations

---

### 3. No Authentication/Authorization

**Limitation**: Anyone with a room code can join. There's no user authentication, password protection, or waiting room feature.

**Production Recommendation**: Implement:
- User authentication (OAuth, email/password)
- Room passwords or waiting rooms
- Role-based access control
- Meeting invitations with expiring links

---

### 4. Host Detection Based on Empty Room

**Limitation**: Host status is determined by checking if the room is empty when joining. If the host refreshes while others are in the room, they lose host privileges.

**Production Recommendation**:
- Store host identity in room metadata
- Persist host information in a database
- Allow host transfer functionality

---

### 5. No TURN Server Configuration

**Limitation**: The demo relies on direct peer connections. Users behind symmetric NATs or restrictive firewalls may have connectivity issues.

**Production Recommendation**: Configure TURN servers for relay when direct connections fail. LiveKit supports TURN configuration.

---

### 6. Session Persistence is Browser-Based

**Limitation**: Session persistence uses `sessionStorage` which is tab-specific. Opening the same meeting in a new tab creates a new session rather than restoring.

**Production Recommendation**: Use server-side session management with proper authentication tokens.

---

### 7. No Recording or Transcription

**Limitation**: Meetings cannot be recorded. There's no transcription or caption support.

**Production Recommendation**: LiveKit supports server-side recording via Egress. Integrate with transcription services for accessibility.

---

### 8. Limited Error Recovery

**Limitation**: Network interruptions may not recover gracefully. The reconnection logic is basic.

**Production Recommendation**: Implement more robust reconnection with exponential backoff, connection quality monitoring, and fallback strategies.

---

### 9. No Rate Limiting or Abuse Prevention

**Limitation**: The API has no rate limiting. Malicious users could spam room creation or token generation.

**Production Recommendation**: Add rate limiting (e.g., express-rate-limit), CAPTCHA for room creation, and abuse detection.

---

### 10. Environment-Specific Configuration

**Limitation**: LiveKit URL is derived from the browser's current hostname, which works for the demo but isn't flexible for complex deployments.

**Production Recommendation**: Use proper environment configuration with separate staging/production environments and configuration management.

---

## Deployment Architecture (Demo)

```yaml
# docker-compose.yml services
services:
  frontend:    # Nginx serving built React app (port 80/443)
  api:         # Express.js API server (port 8080)
  livekit:     # LiveKit SFU server (port 7880)
  caddy:       # Reverse proxy with auto-SSL (optional)
```

For production, consider:
- Kubernetes deployment for scaling
- CDN for frontend assets
- Managed LiveKit Cloud
- Database cluster
- Redis for session/cache
- Monitoring and logging stack
