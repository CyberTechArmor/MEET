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
                │  │  meet-frontend  :3000  (docker)    │ │
                │  │  meet-api       :8080  (docker)    │ │
                │  │  livekit        :7880  (host net)  │ │
                │  │  livekit RTC TCP:7881  (host net)  │ │
                │  │  livekit RTC UDP 50000-60000       │ │
                │  │                        (host net)  │ │
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

After the stack is up, run the info script for the port-to-service map,
the routing the host reverse proxy needs (single-domain and
three-domain), the firewall list, a reachability check, and two
diagnostic probes (HTTP `/api` strip-prefix and LiveKit auth). Safe to
re-run anytime:

```bash
bash info.sh
```

When you need to look at running containers, work from this directory
and use compose **service names** (`meet-api`, `meet-frontend`,
`livekit`) — not raw container names:

```bash
docker compose ps
docker compose logs -f meet-api
docker compose exec meet-api sh
```

The compose project name defaults to the directory name
(`external-proxy`), so generated container names look like
`external-proxy-meet-api-1`. From outside this directory, prepend
`-p external-proxy` to every compose command.

The same summary is also printed at the end of `install.sh`. Hostnames
like ProxyPilot/NPM never see your `.env` and have no way to know which
port belongs to which service — copy the upstreams from `info.sh` into
the proxy manager rather than guessing from a "detected listeners"
list (port 5355 is mDNS on the LXC, not LiveKit).

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

**Strip-prefix rule** (single-domain only): `/livekit/*` is the **only**
path that must have its prefix stripped before forwarding (LiveKit
itself does not read a configurable base path). `/api/*` and `/ws/*`
must arrive at the API **with** the prefix intact — Express routes are
registered as `/api/...`. The reference Caddyfile uses `handle_path`
for `/livekit/*` and plain `handle` for the others; the reference
nginx config uses `rewrite ^/livekit/(.*) /$1 break;` only inside the
`/livekit/` location. If you hand-roll the proxy or use a manager,
match this pattern exactly. The "Login works but admin panel shows
Disconnected" and "`Cannot POST /admin/login`" rows in §8 are both
symptoms of getting this wrong.

## 4. Why the LiveKit container uses host networking

The `livekit` service in `deploy/external-proxy/docker-compose.yml` runs
with `network_mode: host` and **no** `ports:` mapping. That's
deliberate.

Docker's port publishing spawns one `docker-proxy` userland process per
published port and inserts a NAT rule for each. The WebRTC media range
is 10,001 UDP ports. Inside an LXC that pegs CPU for minutes, can
exhaust file descriptors, and frequently wedges `iptables-restore` —
the symptom is `docker compose up` reporting "6/7" and never finishing
the LiveKit container, or the container coming up but ICE failing
because `docker-proxy` rewrote the UDP source ports. Host networking
sidesteps both: LiveKit binds 7880, 7881, and 50000-60000 directly on
the LXC's network namespace, and `meet-api` reaches it via
`host.docker.internal` (mapped to `host-gateway` in the compose file).

This means: do **not** also add an Incus `proxy` device that forwards
the same ports into the container. The LXC's bridge IP already exposes
them. You only need to make sure the host firewall lets traffic reach
the bridge.

## 5. Incus / LXC: exposing the WebRTC UDP range to the internet

WebRTC media is UDP and the reverse proxy doesn't carry it. The UDP
range must reach the LXC's bridge IP from the public internet. There
are two common topologies:

**A. Bridge IP routable from the host firewall (recommended).** Open
`udp/50000-60000` and `tcp/7881` on the host firewall, pointed at the
LXC's bridge IP. Nothing else to do — host networking on the livekit
container has already bound those ports on that IP.

**B. Bridge IP not directly routable.** Add an Incus `proxy` device on
the LXC so the host forwards traffic into it (replace `meet` with your
container name):

```bash
incus config device add meet rtcudp proxy \
    listen=udp:0.0.0.0:50000-60000 \
    connect=udp:<bridge-ip>:50000-60000

incus config device add meet rtctcp proxy \
    listen=tcp:0.0.0.0:7881 \
    connect=tcp:<bridge-ip>:7881
```

Use `<bridge-ip>` — not `127.0.0.1` — as the connect target. LiveKit is
on the LXC's network namespace, not Docker's bridge loopback.

Also set `LIVEKIT_NODE_IP` in `.env` to the **host's public IPv4**.
Otherwise LiveKit advertises ICE candidates with the LXC's bridge IP
and remote browsers will see signaling connect but no media flow.

## 6. Verifying each layer

```bash
# 6a. On the LXC — frontend + api published by docker, livekit on host net.
ss -tlnp
# expected: LISTEN 0.0.0.0:3000  0.0.0.0:8080  0.0.0.0:7880  0.0.0.0:7881
ss -ulnp | grep -E ':5[0-9]{4}\b' | head
# expected: rows in 50000-60000 (the count grows on demand as calls start)

# 6b. From the host — health checks against the bridge.
curl -fsS http://<bridge-ip>:3000/health     # frontend  -> "OK"
curl -fsS http://<bridge-ip>:8080/health     # API       -> {"status":"ok",…}
curl -fsS http://<bridge-ip>:7880/           # LiveKit   -> "OK"

# 6c. Browser — public URL serves the frontend.
curl -fsSI https://meet.example.com/         # 200 from host TLS edge
curl -fsS  https://meet.example.com/api/health

# 6d. Two-participant call — open https://meet.example.com in two
#     browsers on different networks, create a room, join. You should
#     see remote video. Confirm UDP is reaching the host:
sudo tcpdump -ni any 'udp portrange 50000-60000' -c 20
# Expect packets in BOTH directions during a call.
```

## 7. TURN — cellular and restrictive-network fallback

Cellular carriers run **symmetric (Carrier-Grade) NAT**. Wifi routers
typically don't. The difference matters because WebRTC depends on
STUN-based hole punching, which works through cone NAT but breaks
through symmetric NAT — phone-on-cellular calls hang at "Connecting…"
even when wifi works. Without a TURN relay, those users won't connect.

MEET ships a dedicated **coturn** container, profile-gated in the
compose stack so it only starts when explicitly enabled. The browser
learns about it via the `iceServers` field of every `/api/token`
response; livekit-server itself doesn't reference coturn at all.

### 7a. Turn it on

`install.sh` option 5 prompts whether to enable TURN; answering yes:

- sets `TURN_ENABLED=true` in `deploy/external-proxy/.env`,
- prompts whether to reuse the main reverse-proxy cert (single-domain,
  recommended) or use a dedicated `turn.<host>`,
- generates a random `TURN_PASSWORD`,
- renders `turnserver.conf` from `turnserver.conf.template` against
  the current bridge IP / domain / creds,
- creates `deploy/external-proxy/tls/` and seeds it with a `README.md`
  explaining cert provisioning,
- starts the stack with `--profile turn` so `coturn` comes up.

To enable manually on an existing install:

```bash
cd deploy/external-proxy
sed -i 's/^TURN_ENABLED=.*/TURN_ENABLED=true/' .env
sed -i 's|^TURN_DOMAIN=.*|TURN_DOMAIN=meet.example.com|' .env   # single-domain
sed -i "s/^TURN_PASSWORD=.*/TURN_PASSWORD=$(openssl rand -hex 24)/" .env
mkdir -p tls
# Drop a real cert into tls/turn.crt + turn.key (next section), then:
cd ../..
./update.sh                       # re-renders turnserver.conf and starts coturn
```

### 7b. Provision the TLS cert (single-domain — easiest)

Reuse the cert your reverse proxy already serves for the main host.
Set `TURN_DOMAIN` to that hostname (e.g. `meet.example.com`) — no new
DNS record needed.

Find the cert. ProxyPilot stores it inside its Caddy data volume; host
Caddy stores it in `~/.local/share/caddy/...`; host certbot stores
fullchain at `/etc/letsencrypt/live/<host>/`. The helper script
`deploy/external-proxy/sync-cert.sh` knows about all three patterns
and pushes the cert into the LXC, then restarts coturn.

Run on the **Incus host** (not inside the LXC):

```bash
sudo bash /path/to/MEET/deploy/external-proxy/sync-cert.sh
# Override discovery if needed:
#   MEET_CONTAINER=<lxc-name>  TURN_DOMAIN=<host>  CADDY_CERT_DIR=<path>
```

Schedule it daily so cert rotations propagate without operator
intervention:

```cron
# /etc/cron.daily/meet-turn-cert-sync
#!/bin/sh
exec /path/to/MEET/deploy/external-proxy/sync-cert.sh
```

The TURN URL ends up looking like `turns:meet.example.com:5349`, which
is unusual but valid — it's just where coturn happens to be listening.

### 7c. Provision the TLS cert (dedicated turn.&lt;host&gt;)

If you'd rather have a separate hostname:

1. Add DNS: `turn.meet.example.com` → host's public IP.
2. Set `TURN_DOMAIN=turn.meet.example.com` in `.env`.
3. Run certbot on the **host** (briefly frees port 80):

```bash
certbot certonly --standalone -d turn.meet.example.com --http-01-port 80
```

4. The same `sync-cert.sh` discovers the new cert under
   `/etc/letsencrypt/live/turn.meet.example.com/` and pushes it to the
   LXC. Same daily cron applies.

### 7d. Open the firewall

Three things must be reachable from the internet, in addition to the
existing tcp/443 + tcp/7881 + udp/50000-60000:

| Protocol/port | Purpose |
|---|---|
| `tcp/5349` | TURN over TLS — the cellular-survivable port |
| `udp/3478` | TURN/UDP and STUN bind |
| `udp/30000-32000` | TURN relay range (configurable via `TURN_RELAY_RANGE_*`) |

Open these on **both** the host firewall (`ufw`/`firewalld`) and the
cloud-provider security group / VPC firewall — independent layers,
missing either kills the relay.

If the LXC's bridge isn't directly WAN-routable, add Incus proxy
devices for each (run on the Incus host, with the actual bridge IP).
`bash deploy/external-proxy/info.sh` prints these with your real
bridge IP filled in:

```bash
incus config device add <container> turntls proxy \
    listen=tcp:0.0.0.0:5349 connect=tcp:<bridge-ip>:5349
incus config device add <container> turnudp proxy \
    listen=udp:0.0.0.0:3478 connect=udp:<bridge-ip>:3478
incus config device add <container> turnrelay proxy \
    listen=udp:0.0.0.0:30000-32000 connect=udp:<bridge-ip>:30000-32000
```

### 7e. Verify on a real cellular phone

The only test that matters is end-to-end. Open MEET on a phone with
**wifi off, cellular only**. The call should connect within a couple
of seconds — same as on wifi. If it still hangs:

1. Run `bash deploy/external-proxy/info.sh` inside the LXC. The TURN
   status section should show ✓ for cert files, cert SAN match,
   `turnserver.conf`, coturn container running, and `tcp/5349`
   listening.
2. Open `chrome://webrtc-internals` on Android Chrome. Find the failing
   connection's ICE candidate pairs. With TURN working you'll see at
   least one pair where one side is type `relay` and `state: succeeded`.
   If no `relay` candidates appear, the carrier is blocking `tcp/5349`
   — uncommon but real on a few APNs (ask the carrier or try a
   different SIM as a sanity check).

## 8. Known limitations

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

## 9. Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `502 Bad Gateway` from the reverse proxy, port-scan from the proxy shows only `5355` / mDNS listening on the bridge IP | Containers never came up — `docker compose up -d` exits 0 even if a container crashes immediately, so the script reported success | `docker compose -f deploy/external-proxy/docker-compose.yml ps` to see crashed services; `… logs --tail 100` for the failure. Most common in LXC: OOM during the Vite build (give the container ≥2 GiB RAM or add swap) or missing `security.nesting=true` on the LXC profile |
| `502 Bad Gateway` from the reverse proxy, `docker compose ps` shows everything `running` | Component bound to `127.0.0.1` inside the container, proxy can't reach it across the bridge | Confirm `BIND_HOST=0.0.0.0` in `.env`, restart with `docker compose up -d`, re-check with `ss -tlnp` |
| `npm ci` killed during build, exit 137 | LXC out of memory during the Vite/React build | Raise the LXC memory limit (`incus config set <container> limits.memory 2GiB`) or attach swap; rerun installer |
| Proxy connects but page is blank | `PUBLIC_BASE_URL` empty or wrong scheme; CORS origin mismatch | Set `PUBLIC_BASE_URL=https://meet.example.com` in `.env`, rebuild frontend (`docker compose build meet-frontend && docker compose up -d`) |
| Frontend loads, API calls return 404 | Wrong `PUBLIC_API_URL` for the chosen mode | Single-domain: leave `PUBLIC_API_URL` blank. Three-domain: set `PUBLIC_API_URL=https://api.meet.example.com`. Rebuild frontend after either change |
| `POST https://<hostname>/api/<…> → 405 Method Not Allowed` | Single-domain in the reverse proxy is sending `/api/*` to the frontend (port 3000) instead of the API (port 8080). The frontend's nginx 405's POSTs to static paths | (a) Add a route on the same hostname that sends `/api/*` to `<bridge-ip>:8080` (and `/ws/*` for the admin WebSocket). If the proxy manager refuses to add a second rule for an existing hostname, your manager doesn't yet support multi-rule hosts — switch to three-domain mode. (b) Confirm with the reference Caddyfile / nginx config |
| `livekit.<hostname>` connects but the WebSocket immediately closes, or returns 502 | Mapped to the wrong port. Easy mistake: ProxyPilot / NPM auto-detect lists every TCP listener inside the LXC, including `5355` (mDNS/LLMNR) which is **not** LiveKit | LiveKit signaling is `<bridge-ip>:7880`. Run `bash deploy/external-proxy/info.sh` for the full port map |
| WebSocket to `/livekit` returns 404 | Proxy isn't stripping the `/livekit` prefix before forwarding to port 7880 | Use the reference Caddyfile / nginx config; if hand-rolled, ensure `handle_path /livekit/*` (Caddy) or `rewrite ^/livekit/(.*) /$1 break;` (nginx) |
| `POST /api/admin/login` returns 404 with body `Cannot POST /admin/login` (Express) | Proxy is stripping the `/api` prefix the same way it strips `/livekit`. The API requires the full path `/api/admin/login` | Single-domain config: `/livekit/*` is the **only** prefix that should be stripped. `/api/*` and `/ws/*` must use Caddy `handle` (not `handle_path`) or, in nginx, no `rewrite`. If you're using a proxy manager (ProxyPilot/NPM), toggle off the "strip prefix" flag on the `/api/*` and `/ws/*` routes and verify with `bash deploy/external-proxy/info.sh` (the routing probe should report "API reached, prefix preserved") |
| Login works, but the admin "Connection" panel shows **Disconnected** and `/api/rooms` calls fail with `Unauthorized: invalid API key` in the meet-api logs | `meet-api` and the `livekit` container disagree on the API key/secret. Login doesn't touch LiveKit so the breakage is invisible until the admin panel opens. Common causes: hand-edited `.env`, copying `.env` between hosts, or installing before the key fix in this repo (which never passed the generated key to the livekit container) | Re-run `./install.sh` and pick the External-proxy mode again. The installer reuses the existing key from `.env` and writes `LIVEKIT_KEYS` so both services load the same pair. Confirm with `bash deploy/external-proxy/info.sh` — the **LiveKit auth probe** should report ✓. Never edit `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, or `LIVEKIT_KEYS` individually — change all three together or rerun the installer |
| Embedding MEET in an iframe (XRay desktop, third-party portal, Notion, …) fails with `Refused to display in a frame because it set 'X-Frame-Options' to 'sameorigin'` | The host reverse proxy is injecting `X-Frame-Options: SAMEORIGIN` as a default security header. The MEET frontend nginx and API both already strip it, so any `X-Frame-Options` in the response is the proxy's | The reference Caddyfile sets `-X-Frame-Options` and `Content-Security-Policy: frame-ancestors *` in a `header { … }` block. Match that in your proxy: remove `X-Frame-Options` for this site **and** set `frame-ancestors` (use `*` to allow all, or specific origins). For a proxy manager UI, look for a per-service "allow framing" / "iframe embed" toggle and turn it on. Verify with the **iframe-embedding probe** in `info.sh` — both rows should be ✓ |
| Two-participant call upgrades to status 101 then sticks at "Connecting…" forever; no audio/video | The `/livekit/*` reverse-proxy block is missing `flush_interval -1` (Caddy) or `proxy_buffering off` (nginx). The WebSocket handshake completes, but the proxy buffers LiveKit's first signaling frame for ~1s — long enough for the LiveKit client to give up | Add to the `/livekit/*` route: Caddy `reverse_proxy { flush_interval -1; transport http { read_timeout 24h; write_timeout 24h; keepalive 30s } }`. nginx: `proxy_buffering off; proxy_read_timeout 24h; proxy_send_timeout 24h;`. The reference snippets in `deploy/external-proxy/caddy/single-domain.Caddyfile` and `deploy/external-proxy/nginx/single-domain.conf` set these correctly. The 24h timeouts also prevent established calls from dropping at 60s |
| Admin panel shows the room was created, but the joiner's browser logs `ConnectionError: could not establish pc connection` and disconnects | LiveKit signaling worked (token issued, room created) but the WebRTC peer connection couldn't reach the LXC over UDP. ICE failed on every candidate. Almost always one of: (a) wrong `LIVEKIT_NODE_IP`, (b) host firewall, (c) cloud-provider security group, (d) LXC bridge not WAN-routable and no Incus `proxy` device for UDP | Run `bash deploy/external-proxy/info.sh` — the **WebRTC media reachability** section reports `LIVEKIT_NODE_IP` vs the detected public IPv4 and lists the firewall/UDP checklist. From a machine **outside** the LXC and host (a phone on cellular is ideal): `nc -u -v -w 2 <host-public-ip> 50000` and `nc -v -w 2 <host-public-ip> 7881`. "No route to host" / "Connection refused" means a firewall layer is blocking — usually the cloud-provider security group, which has to be opened separately from the host's `ufw`/`iptables`. If clients are on UDP-blocking networks (corporate / hotel wifi), they need a TURN-over-TCP/443 server — not bundled in this install path |
| LiveKit logs show `removing participant without connection` after ~16 s with `connectionType: "unknown"` and `reason: "SIGNAL_SOURCE_CLOSE"`; signaling worked (room appears in admin) but the call never starts | This is the same class as the row above (ICE never paired any candidate within LiveKit's deadline) but with two specific common subcauses worth calling out: **(1) Incus proxy devices weren't added.** ProxyPilot/NPM/Caddy only handle HTTP — UDP `50000-60000` and TCP `7881` need separate L4 forwarding from the host into the LXC. **(2) NAT hairpinning** if you're testing from the same LAN as the server. LiveKit advertises only the public IP; reaching it from inside the same LAN requires the router to "hairpin" the packet, which most consumer routers don't | (1) Run on the **Incus host** (not the LXC): `incus config device add <container> rtcudp proxy listen=udp:0.0.0.0:50000-60000 connect=udp:<bridge-ip>:50000-60000` and the matching one for `tcp:7881`. `info.sh` prints these with your real bridge IP filled in. Open the same ports on the host firewall **and** the cloud-provider security group. (2) Tether your laptop to a phone hotspot (cellular) and try again. Cellular working + same-LAN failing = hairpinning, fix at the router or accept it as expected for same-LAN testing |
| After login, refreshing the admin panel page sends you back to the join screen | Pre-`<commit>`: admin-panel state was kept in React component state only, so a reload threw it away. Session token was preserved, so you stayed logged in but the panel was closed | Pull the latest frontend and rebuild (`docker compose build meet-frontend && docker compose up -d`). The admin panel and active tab are now persisted in the URL hash (`#admin`, `#admin/settings`, etc.), so refresh and back/forward both work, and you can bookmark a specific admin tab |
| WebSocket disconnects after ~60s | Default proxy read/write timeout | The reference configs set 24h; if you're customising, raise `proxy_read_timeout` / `transport http { read_timeout … }` on the LiveKit route |
| Signaling connects, two participants see "connecting" but no video / audio | UDP not reaching the LXC, OR LiveKit advertising the wrong IP | (a) Open `udp/50000-60000` on the host firewall pointed at the LXC's bridge IP (or add an Incus `proxy` device — see §5). (b) Set `LIVEKIT_NODE_IP=<host-public-ipv4>` in `.env` and `docker compose up -d livekit`. Verify with `tcpdump -ni any 'udp portrange 50000-60000'` |
| `docker compose up -d` hangs at "6/7" or the livekit container never reports `running` | Old layout published 10k UDP ports through `docker-proxy`, which can take minutes or fail inside an LXC | Pull the latest `deploy/external-proxy/docker-compose.yml`. The livekit service now uses `network_mode: host` and publishes nothing through Docker. `docker compose down && docker compose up -d` |
| `meet-api` logs `dial tcp: lookup livekit on …: no such host` | `LIVEKIT_URL` still points at the bridge service name from a previous install | Latest compose sets `LIVEKIT_URL=http://host.docker.internal:7880` and an `extra_hosts: host-gateway` mapping. Run `docker compose up -d --force-recreate meet-api` after pulling |
| Avatar / large upload fails with 413 | Body limit on the proxy | Reference configs set 50 MiB. Raise `request_body { max_size … }` (Caddy) or `client_max_body_size` (nginx) if you need more |
| Browser console: "blocked by CORS" | `CORS_ORIGIN` doesn't match `PUBLIC_BASE_URL` | They're wired together by default; if you've overridden one, override the other to match |

## 10. Acceptance checklist

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
