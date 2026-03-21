# MEET

A self-hosted video conferencing platform for 1-to-1 calls, group chats, and screen sharing.

```
    ███╗   ███╗███████╗███████╗████████╗
    ████╗ ████║██╔════╝██╔════╝╚══██╔══╝
    ██╔████╔██║█████╗  █████╗     ██║
    ██║╚██╔╝██║██╔══╝  ██╔══╝     ██║
    ██║ ╚═╝ ██║███████╗███████╗   ██║
    ╚═╝     ╚═╝╚══════╝╚══════╝   ╚═╝
```

## Quick Start

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/CyberTechArmor/MEET/main/install.sh | bash
```

Or clone and run manually:

```bash
git clone https://github.com/CyberTechArmor/MEET.git
cd MEET
./install.sh
```

### Requirements

- Docker
- Docker Compose

That's it! The installer will automatically install missing dependencies.

### Installation Modes

The installer offers three modes:

1. **Demo Mode** - Quick local development (http://localhost:3000)
2. **Demo + Reverse Proxy** - Deployment with Caddy for automatic HTTPS
3. **Production Mode** - Full deployment (coming soon)

## Features

### Demo Mode (Current)

- **Video Calling**: High-quality 1-to-1 video calls
- **Screen Sharing**: Share your entire screen, window, or browser tab
- **No Sign-up Required**: Just enter your name and create/join a room
- **Room Codes**: Easy-to-share 6-character room codes
- **Mute/Unmute**: Toggle microphone with visual indicators
- **Camera On/Off**: Toggle camera with avatar fallback
- **Auto-hide Controls**: Clean, distraction-free video experience
- **Connection Status**: Real-time connection state indicators
- **Participant Notifications**: Toast notifications when people join/leave

### Coming Soon (Production Mode)

- SSL/TLS with automatic certificates
- Custom domain configuration
- PostgreSQL for persistence
- Redis for session management
- TURN server for NAT traversal
- User authentication (OAuth/email)
- Admin dashboard
- Multi-participant support (>2)
- Text chat
- Recording

## Architecture

### Demo Mode
```
┌─────────────────────────────────────────────────────────────┐
│                         Docker                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Frontend  │  │     API     │  │   LiveKit Server    │  │
│  │   (React)   │  │  (Express)  │  │     (WebRTC)        │  │
│  │   :3000     │  │   :8080     │  │  :7880/:7881/:7882  │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### With Reverse Proxy (Caddy)
```
┌─────────────────────────────────────────────────────────────┐
│                         Docker                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Caddy (Reverse Proxy)                   │    │
│  │              :80 / :443 (HTTPS)                      │    │
│  └────────────────────┬────────────────────────────────┘    │
│           ┌───────────┴───────────┐                          │
│  ┌────────▼────┐  ┌───────▼──────┐  ┌─────────────────────┐ │
│  │   Frontend  │  │     API      │  │   LiveKit Server    │ │
│  │   (React)   │  │  (Express)   │  │     (WebRTC)        │ │
│  └─────────────┘  └──────────────┘  │  :7880/:7881/:7882  │ │
│                                      └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Tech Stack

- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **State Management**: Zustand
- **WebRTC Backend**: LiveKit
- **API Server**: Express + TypeScript
- **Containerization**: Docker + Docker Compose

## Usage

### Create a Room

1. Enter your display name
2. Click "Create a new room"
3. Share the room code with others

### Join a Room

1. Enter your display name
2. Click "Join existing room"
3. Enter the 6-character room code
4. Click "Join Call"

### In-Call Controls

| Control | Action |
|---------|--------|
| Microphone | Toggle mute/unmute |
| Camera | Toggle camera on/off |
| Screen | Toggle screen sharing |
| Settings | (Coming soon) |
| Leave | End the call |

### Keyboard Shortcuts (Future)

- `M` - Toggle microphone
- `V` - Toggle camera
- `S` - Toggle screen share
- `Esc` - Leave call

## Development

### Demo Mode (Local Development)

```bash
# Start the stack
docker compose up -d --build

# View logs
docker compose logs -f

# Stop the stack
docker compose down
```

### With Reverse Proxy (Caddy)

For deployment with automatic HTTPS:

```bash
# Configure your domain
cp .env.example .env
# Edit .env and set MEET_DOMAIN=your.domain.com

# Start with reverse proxy
docker compose -f docker-compose.proxy.yml up -d --build

# View logs
docker compose -f docker-compose.proxy.yml logs -f

# Stop
docker compose -f docker-compose.proxy.yml down
```

Caddy will automatically obtain Let's Encrypt SSL certificates for your domain.

### Frontend Only

```bash
cd frontend
npm install
npm run dev
```

### API Only

```bash
cd api
npm install
npm run dev
```

### Environment Variables

**Frontend** (`.env`):
```env
VITE_LIVEKIT_URL=ws://localhost:7880
VITE_API_URL=http://localhost:8080
```

**API** (`.env`):
```env
PORT=8080
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_URL=http://livekit:7880
CORS_ORIGIN=http://localhost:3000
```

## File Structure

```
meet/
├── install.sh              # One-line installer (auto-installs dependencies)
├── cleanup.sh              # Cleanup script for fresh installs
├── docker-compose.yml      # Demo mode orchestration
├── docker-compose.proxy.yml # With Caddy reverse proxy
├── docker-compose.prod.yml # Production (placeholder)
├── Caddyfile               # Caddy configuration
├── .env.example            # Environment template
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── index.css
│       ├── components/
│       │   ├── JoinForm.tsx
│       │   ├── VideoRoom.tsx
│       │   ├── VideoTile.tsx
│       │   ├── ScreenShareView.tsx
│       │   ├── ControlBar.tsx
│       │   ├── SelfViewPip.tsx
│       │   ├── AdminPanel.tsx
│       │   ├── ConfirmModal.tsx
│       │   └── ParticipantOverlay.tsx
│       ├── hooks/
│       │   └── useLiveKit.ts
│       ├── stores/
│       │   ├── roomStore.ts
│       │   └── adminStore.ts
│       └── lib/
│           └── livekit.ts
├── api/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── index.ts
└── README.md
```

## Cleanup

To remove all MEET containers, images, and configuration for a fresh install:

```bash
# Interactive cleanup (with prompts)
./cleanup.sh

# Quick cleanup (containers and images only)
./cleanup.sh --quick

# Force cleanup (no prompts)
./cleanup.sh --force
```

The cleanup script removes:
- All MEET Docker containers
- All MEET Docker images
- Docker volumes (Caddy certificates, etc.)
- Docker networks
- Configuration files (.env)
- Build cache (optional)

## Troubleshooting

### Camera/Microphone Not Working

1. Ensure you've granted browser permissions
2. Check that no other application is using the camera
3. Try refreshing the page

### Can't Connect to Room

1. Verify all Docker containers are running: `docker compose ps`
2. Check container logs: `docker compose logs`
3. Ensure ports 3000, 7880, 7881, 8080 are not in use

### Screen Share Not Working

1. Some browsers require HTTPS for screen sharing (localhost is exempt)
2. On macOS, grant screen recording permission in System Preferences
3. Try selecting a specific window instead of entire screen

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
