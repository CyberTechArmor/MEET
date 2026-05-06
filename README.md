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

### Updating an existing install

```bash
cd MEET
./update.sh                    # auto-detects mode, pulls, rebuilds, restarts
FORCE_REBUILD=1 ./update.sh    # force a clean rebuild (no layer cache)
./update.sh --mode 5           # skip detection if you know the mode
```

`update.sh` does **not** regenerate secrets, certificates, or hostnames —
your `.env`, Let's Encrypt certs, and LiveKit API keys are preserved.
For the external-proxy / LXC mode, it also reconstructs `LIVEKIT_KEYS`
in `.env` if a pre-fix install left it out.

### Requirements

- Docker
- Docker Compose

That's it! The installer will automatically install missing dependencies.

### Installation Modes

The installer offers five modes:

1. **Demo Mode** - Quick local development (http://localhost:3000)
2. **Deploy with Caddy** - Bundled Caddy reverse proxy with automatic Let's Encrypt
3. **Deploy with host Nginx + Certbot** - Uses host-installed Nginx for SSL
4. **Deploy with ProxyPilot / NPM** - Each component on its own subdomain
5. **Behind external reverse proxy (LXC / bare-metal)** - Host already runs
   Caddy/nginx as the TLS edge; this stack ships no TLS and binds 0.0.0.0
   so the host proxy can reach it. Walk-through:
   [`docs/install/external-reverse-proxy.md`](docs/install/external-reverse-proxy.md)
6. **Production Mode** - Full deployment (coming soon)

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

### Operator state persistence (external-proxy mode)

API keys, webhooks, server settings, and the admin username/password are
persisted in SQLite at `/data/meet.db` inside the `meet-api` container.
The compose stack mounts the named volume `meet-api-data` there, so all
of those survive `docker compose down && up`. `docker compose down -v`
wipes the volume — use it only when you intend a full reset.

To back up or inspect the file from the host:

```bash
docker compose cp meet-api:/data/meet.db ./meet-backup.db
```

### Lost admin password or passkey

Run from the external-proxy directory on the host:

```bash
bash deploy/external-proxy/reset-admin.sh --help
bash deploy/external-proxy/reset-admin.sh --set-password 'newpass'
bash deploy/external-proxy/reset-admin.sh --clear-passkeys
bash deploy/external-proxy/reset-admin.sh                # default: full reset (interactive password)
```

The script execs into the running `meet-api` container and edits the
SQLite database directly — no API restart required.

Note: this is the first MEET version with persistent state. Prior to it,
admin keys/webhooks/settings were lost on every container recreate.
Running `update.sh` from a previous install creates an empty database on
first start; any keys configured before will need to be re-created.

### External-proxy / LXC mode

Run `bash deploy/external-proxy/info.sh` first — it surfaces most of these
automatically. Top failure modes, in the order they tend to bite:

1. **LiveKit logs `could not validate external IP … context canceled` and
   the stack works anyway.** Normal when `LIVEKIT_NODE_IP` is set in
   `deploy/external-proxy/.env` (which `install.sh` does by default). LiveKit
   tries STUN, can't NAT-loopback the host's own public IP, then falls
   back to `NODE_IP`. The warning is only a problem if `LIVEKIT_NODE_IP`
   is **empty** — then LiveKit fails to start and you'll see `/livekit`
   502s and `/api/rooms` 500s. Set it and `docker compose up -d livekit`.
2. **Login works, admin panel shows Disconnected, `/api/rooms` returns
   `Unauthorized: invalid API key`.** `meet-api` and the `livekit`
   container disagree on the LiveKit auth pair. Re-run `./install.sh`
   option 5 (idempotent — preserves the existing key but rewrites
   `LIVEKIT_KEYS` so both services match), then `info.sh` should show
   the LiveKit auth probe ✓.
3. **Rooms get created in the admin panel, but joining hangs at
   "Connecting…" and the browser logs `could not establish pc connection`.**
   ICE didn't pair because UDP isn't reaching the LXC. ProxyPilot/Caddy
   can't proxy UDP — you need Incus proxy devices for `udp/50000-60000`
   and `tcp/7881`. `info.sh` prints the exact commands with your bridge
   IP filled in. If those are in place and only same-LAN testing fails,
   it's NAT hairpinning (test from cellular to confirm).
4. **`POST /api/admin/login` returns 404 `Cannot POST /admin/login`.**
   Reverse proxy is stripping the `/api` prefix. Only `/livekit/*` should
   strip; `/api/*` and `/ws/*` must preserve. ProxyPilot has a per-route
   strip toggle.
5. **Iframe embedding rejected with `X-Frame-Options: SAMEORIGIN`.** The
   reverse proxy is injecting it. The MEET frontend and API both already
   strip it; if you see it, your proxy is adding it as a default header.
   Remove it for this site (Caddy `-X-Frame-Options`) and set
   `Content-Security-Policy: frame-ancestors *`.

Full walk-through: [`docs/install/external-reverse-proxy.md`](docs/install/external-reverse-proxy.md).

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
