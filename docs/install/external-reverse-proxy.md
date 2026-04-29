# Install behind an external reverse proxy (LXC / bare-metal)

This is the install variant for hosts where TLS, ACME, and ingress are
already handled by an existing reverse proxy — typically a host Caddy or
host nginx that fronts many services and forwards plaintext HTTP/WS to
LXC/Incus containers across the bridge.

It ships **no** bundled Traefik / Caddy / nginx, does **no** ACME, and
binds every externally-routed port on `0.0.0.0` so the host proxy can
reach the container's bridge IP. Compare with the four other install
options (Demo, Demo + bundled Caddy, host nginx + Certbot, ProxyPilot /
NPM) which all assume MEET owns the TLS edge — this one does not.

## 1. Topology

```
                ┌─────────────────────────────────────────┐
                │  HOST                                   │
                │                                         │
   browser ────►│  Caddy / nginx (TLS, ACME, HSTS)        │
                │       │                                 │
                │       │ plaintext HTTP/WS over bridge   │
                │       ▼                                 │
                │  ┌────────────────────────────────────┐ │
                │  │  LXC container (bridge IP 10.x.y.z)│ │
                │  │                                    │ │
                │  │  meet-frontend  :3000  (0.0.0.0)   │ │
                │  │  meet-api       :8080  (0.0.0.0)   │ │
                │  │  livekit signal :7880  (0.0.0.0)   │ │
                │  │  livekit RTC TCP:7881  (0.0.0.0)   │ │
                │  │  livekit RTC UDP 50000-60000       │ │
                │  └────────────────────────────────────┘ │
                │                                         │
   browser ◄═══►│  UDP 50000-60000 (WebRTC media,         │
   (direct UDP) │   bypasses the reverse proxy)           │
                └─────────────────────────────────────────┘
```

The reverse proxy carries TCP only: the HTML, the `/api` calls, and the
LiveKit signaling WebSocket. Actual A/V media is UDP and reaches LiveKit
directly — the proxy is not in that path.

## 2. Prereqs

- Docker + Docker Compose inside the container.
- A host reverse proxy that already terminates TLS for the public
  hostname (host Caddy, host nginx, or NPM/ProxyPilot).
- DNS: an A/AAAA record for the public hostname pointing at the host's
  public IP.
- Host firewall openings (adjust if you change the UDP range):
  - `tcp/443` from the internet to the host (TLS).
  - `udp/50000-60000` from the internet to the host (WebRTC media).
  - `tcp/7881` from the internet to the host (WebRTC TCP fallback).
- Container-to-host: nothing extra — the host proxy reaches the
  container over the bridge.
- An LXC profile with `security.nesting=true` if you're running Docker
  inside Incus/LXC; otherwise Docker won't start.
- ≥ 2 GiB RAM available to the LXC. The Vite frontend build is the
  hungriest step — under-provisioned containers will silently OOM
  during `npm ci` / `vite build` and the install script will report
  the failure. Add swap or raise the limit:
  `incus config set <container> limits.memory 2GiB`.

## 3. Step-by-step

```bash
git clone https://github.com/CyberTechArmor/MEET.git
cd MEET/deploy/external-proxy

cp .env.example .env
# Edit .env — at minimum:
#   PUBLIC_BASE_URL=https://meet.example.com
#   LIVEKIT_NODE_IP=<your host's public IPv4>
#   LIVEKIT_API_KEY=<random>
#   LIVEKIT_API_SECRET=<random>

docker compose up -d --build
```

Then point the host reverse proxy at the container. Drop one of the
reference snippets in:

- `deploy/external-proxy/caddy/single-domain.Caddyfile`
- `deploy/external-proxy/caddy/three-domain.Caddyfile`
- `deploy/external-proxy/nginx/single-domain.conf`
- `deploy/external-proxy/nginx/three-domain.conf`

Each snippet has a comment block at the top showing the exact upstream
wiring — replace `127.0.0.1:<port>` with `<bridge-ip>:<port>` if the
host proxy lives outside the container.

### Single-domain vs three-domain

|                | Single-domain                      | Three-domain                     |
| -------------- | ---------------------------------- | -------------------------------- |
| URLs           | `meet.example.com/`, `/api`, `/livekit` | `meet.example.com`, `api.meet.example.com`, `livekit.meet.example.com` |
| DNS records    | 1                                  | 3                                |
| TLS certs      | 1                                  | 3 (or 1 wildcard)                |
| `.env`         | set `PUBLIC_BASE_URL` only         | set all three `PUBLIC_*_URL`     |
| Proxy snippet  | `*-single-domain.*`                | `*-three-domain.*`               |

Both LiveKit signaling and the API tolerate being mounted under a
sub-path **only because the proxy strips the prefix before forwarding**
(`handle_path /livekit/*` in Caddy, `rewrite ^/livekit/(.*)` in nginx).
The reference snippets do this correctly. If you write your own proxy
config, you must strip the prefix the same way — LiveKit itself does not
read a configurable base path.

## 4. Incus / LXC: exposing the WebRTC UDP range

WebRTC media is UDP and the reverse proxy doesn't carry it. The UDP
range must reach the LXC container directly. Add a `proxy` device on the
container so the host forwards UDP to it (replace `meet` with your
container name):

```bash
incus config device add meet rtcudp proxy \
    listen=udp:0.0.0.0:50000-60000 \
    connect=udp:127.0.0.1:50000-60000

# RTC TCP fallback (port 7881) — same idea over TCP.
incus config device add meet rtctcp proxy \
    listen=tcp:0.0.0.0:7881 \
    connect=tcp:127.0.0.1:7881
```

If the container's bridge is already routable from the host firewall
(common with `bridge`-mode networking), you can skip the `proxy` device
and just open the same UDP range on the host firewall — the bridge IP
handles the rest.

Also set `LIVEKIT_NODE_IP` in `.env` to the **host's public IPv4**.
Otherwise LiveKit advertises ICE candidates with the container's bridge
IP and remote browsers will see signaling connect but no media flow.

## 5. Verifying each layer

```bash
# 5a. Inside the container — every externally-routed port on 0.0.0.0,
#     none on 127.0.0.1.
docker compose exec meet-api ss -tlnp || ss -tlnp
# expected:  LISTEN  0.0.0.0:3000  0.0.0.0:8080  0.0.0.0:7880  0.0.0.0:7881

# 5b. From the host — health checks against the bridge.
curl -fsS http://<bridge-ip>:3000/health     # frontend  -> "OK"
curl -fsS http://<bridge-ip>:8080/health     # API       -> {"status":"ok",…}
curl -fsS http://<bridge-ip>:7880/           # LiveKit   -> "OK"

# 5c. Browser — public URL serves the frontend.
curl -fsSI https://meet.example.com/         # 200 from host TLS edge
curl -fsS  https://meet.example.com/api/health

# 5d. Two-participant call — open https://meet.example.com in two
#     browsers on different networks, create a room, join. You should
#     see remote video. Confirm UDP is reaching the host:
sudo tcpdump -ni any 'udp portrange 50000-60000' -c 20
# Expect packets in BOTH directions during a call.
```

## 6. Known limitations

- **TURN-over-TCP/443 isn't included.** If a participant is behind a
  network that blocks UDP and 7881, they won't connect. Stand up a
  separate TURN server (coturn) on TCP/443 if you need to support that.
- **No bandwidth shaping.** LiveKit will use as much UDP bandwidth as
  participants negotiate. Plan capacity at the host NIC.
- **No recording.** Recording requires the LiveKit Egress service,
  which this install option does not provision. Add it separately if
  needed.
- **Single host.** Multi-region or HA LiveKit (Redis-backed) is out of
  scope — see LiveKit's docs for cluster mode.
- **HTTP/3 (QUIC) bypasses the proxy in some setups.** If your host
  Caddy advertises HTTP/3 on UDP/443, make sure that doesn't collide
  with the LiveKit UDP range.

## 7. Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `502 Bad Gateway` from the reverse proxy, port-scan from the proxy shows only `5355` / mDNS listening on the bridge IP | Containers never came up — `docker compose up -d` exits 0 even if a container crashes immediately, so the script reported success | `docker compose -f deploy/external-proxy/docker-compose.yml ps` to see crashed services; `… logs --tail 100` for the failure. Most common in LXC: OOM during the Vite build (give the container ≥2 GiB RAM or add swap) or missing `security.nesting=true` on the LXC profile |
| `502 Bad Gateway` from the reverse proxy, `docker compose ps` shows everything `running` | Component bound to `127.0.0.1` inside the container, proxy can't reach it across the bridge | Confirm `BIND_HOST=0.0.0.0` in `.env`, restart with `docker compose up -d`, re-check with `ss -tlnp` |
| `npm ci` killed during build, exit 137 | LXC out of memory during the Vite/React build | Raise the LXC memory limit (`incus config set <container> limits.memory 2GiB`) or attach swap; rerun installer |
| Proxy connects but page is blank | `PUBLIC_BASE_URL` empty or wrong scheme; CORS origin mismatch | Set `PUBLIC_BASE_URL=https://meet.example.com` in `.env`, rebuild frontend (`docker compose build meet-frontend && docker compose up -d`) |
| Frontend loads, API calls return 404 | Wrong `PUBLIC_API_URL` for the chosen mode | Single-domain: leave `PUBLIC_API_URL` blank. Three-domain: set `PUBLIC_API_URL=https://api.meet.example.com`. Rebuild frontend after either change |
| WebSocket to `/livekit` returns 404 | Proxy isn't stripping the `/livekit` prefix before forwarding to port 7880 | Use the reference Caddyfile / nginx config; if hand-rolled, ensure `handle_path /livekit/*` (Caddy) or `rewrite ^/livekit/(.*) /$1 break;` (nginx) |
| WebSocket disconnects after ~60s | Default proxy read/write timeout | The reference configs set 24h; if you're customising, raise `proxy_read_timeout` / `transport http { read_timeout … }` on the LiveKit route |
| Signaling connects, two participants see "connecting" but no video / audio | UDP not reaching the host, OR LiveKit advertising the wrong IP | (a) Open `udp/50000-60000` on the host firewall and add the Incus `proxy` device above. (b) Set `LIVEKIT_NODE_IP=<host-public-ipv4>` in `.env` and `docker compose up -d livekit`. Verify with `tcpdump -ni any 'udp portrange 50000-60000'` |
| Avatar / large upload fails with 413 | Body limit on the proxy | Reference configs set 50 MiB. Raise `request_body { max_size … }` (Caddy) or `client_max_body_size` (nginx) if you need more |
| Browser console: "blocked by CORS" | `CORS_ORIGIN` doesn't match `PUBLIC_BASE_URL` | They're wired together by default; if you've overridden one, override the other to match |

## 8. Acceptance checklist

- [ ] `ss -tlnp` inside the container shows every externally-routed
      port on `0.0.0.0`, none on `127.0.0.1`.
- [ ] `curl http://<bridge-ip>:<port>/health` from the host returns
      200 for frontend, API, and LiveKit (LiveKit returns `OK` at `/`).
- [ ] Browser hits `https://<public-host>/` and sees the frontend.
- [ ] Two browsers on different networks can join a room and exchange
      audio + video.
- [ ] Switching to three-domain mode requires only changing the three
      `PUBLIC_*_URL` env vars and swapping the proxy snippet — no
      compose edits.
