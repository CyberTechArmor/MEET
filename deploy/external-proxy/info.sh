#!/usr/bin/env bash
# MEET — external reverse proxy info / status reference.
#
# Run from this directory after installing. Safe to re-run anytime.
# Prints the port → service table, the routing the host reverse proxy
# needs (single-domain and three-domain), firewall openings, and a
# reachability check against each upstream.
#
#   bash info.sh
#
# No flags. Reads .env if present.

set -u

GREEN=$'\e[32m'
YELLOW=$'\e[33m'
RED=$'\e[31m'
CYAN=$'\e[36m'
BOLD=$'\e[1m'
DIM=$'\e[2m'
NC=$'\e[0m'

if [ -t 1 ]; then :; else GREEN= YELLOW= RED= CYAN= BOLD= DIM= NC=; fi

cd "$(dirname "$0")" || exit 1

if [ -f .env ]; then
    # shellcheck disable=SC1091
    set -a; . ./.env; set +a
fi

PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-}
PUBLIC_API_URL=${PUBLIC_API_URL:-}
PUBLIC_LIVEKIT_URL=${PUBLIC_LIVEKIT_URL:-}
MEET_FRONTEND_PORT=${MEET_FRONTEND_PORT:-3000}
MEET_API_PORT=${MEET_API_PORT:-8080}
MEET_LIVEKIT_WS_PORT=${MEET_LIVEKIT_WS_PORT:-7880}
MEET_LIVEKIT_TCP_PORT=${MEET_LIVEKIT_TCP_PORT:-7881}
LIVEKIT_UDP_PORT_RANGE_START=${LIVEKIT_UDP_PORT_RANGE_START:-50000}
LIVEKIT_UDP_PORT_RANGE_END=${LIVEKIT_UDP_PORT_RANGE_END:-60000}

# Pick the LXC's external IPv4 — the address the host reverse proxy actually
# dials. Filter out Docker's per-network bridges (docker0, br-<hash>, veth*)
# and CNI/libvirt/lxcbr scaffolding so we don't return e.g. 172.18.0.1, which
# is only reachable from inside the LXC.
bridge_ip=$(ip -4 -o addr show scope global 2>/dev/null \
            | awk '$2 !~ /^(docker|br-|veth|cni|lxcbr|virbr|tun|tap)/ {print $4}' \
            | cut -d/ -f1 | head -n1)
# Fall back to the first global address if the filter eliminated everything
# (e.g. the LXC's only nic is named br-something for some reason).
if [ -z "$bridge_ip" ]; then
    bridge_ip=$(ip -4 -o addr show scope global 2>/dev/null \
                | awk '{print $4}' | cut -d/ -f1 | head -n1)
fi
bridge_ip=${bridge_ip:-<bridge-ip>}

# Compose project name = directory name (which is what compose v2 uses by
# default when -p isn't passed). Used to spell out container names in the
# diagnostics output.
compose_project=$(basename "$(pwd)")

# Layout inference: empty PUBLIC_API_URL/PUBLIC_LIVEKIT_URL → single-domain.
if [ -z "$PUBLIC_API_URL" ] && [ -z "$PUBLIC_LIVEKIT_URL" ]; then
    layout="single-domain"
else
    layout="three-domain"
fi

# Pull a hostname for the example URLs even if the .env is missing.
public_host="${PUBLIC_BASE_URL#https://}"
public_host="${public_host#http://}"
public_host="${public_host%%/*}"
public_host=${public_host:-meet.example.com}

echo
echo "${BOLD}MEET — external reverse proxy${NC}"
echo "${DIM}═══════════════════════════════════════════════════════════${NC}"
echo
printf "  %-22s %s\n" "Container bridge IP:" "${CYAN}${bridge_ip}${NC}"
printf "  %-22s %s\n" "Public hostname:"     "${CYAN}${public_host}${NC}"
printf "  %-22s %s\n" "Configured layout:"   "${CYAN}${layout}${NC}"
echo

# ───────────────────────── port → service table ─────────────────────────
echo "${BOLD}Port → service map (give these to your reverse proxy):${NC}"
echo
printf "  ${BOLD}%-6s %-26s %-22s %s${NC}\n" "PROTO" "UPSTREAM" "SERVICE" "NOTES"
printf "  %-6s %-26s %-22s %s\n" "HTTP"  "${bridge_ip}:${MEET_FRONTEND_PORT}"  "frontend"            "SPA (nginx)"
printf "  %-6s %-26s %-22s %s\n" "HTTP"  "${bridge_ip}:${MEET_API_PORT}"       "meet-api"            "/api/* and /ws/*"
printf "  %-6s %-26s %-22s %s\n" "WS"    "${bridge_ip}:${MEET_LIVEKIT_WS_PORT}" "livekit (signaling)" "WebSocket — needs 24h timeouts"
printf "  %-6s %-26s %-22s %s\n" "TCP"   "${bridge_ip}:${MEET_LIVEKIT_TCP_PORT}" "livekit (TCP fb)"   "L4 forward, NOT through Caddy"
printf "  %-6s %-26s %-22s %s\n" "UDP"   "${bridge_ip}:${LIVEKIT_UDP_PORT_RANGE_START}-${LIVEKIT_UDP_PORT_RANGE_END}" "livekit (RTC media)" "L4 forward, NOT through Caddy"
echo

# ─────────────────────────── routing snippets ───────────────────────────
echo "${BOLD}Reverse-proxy routing for ${CYAN}${public_host}${NC}:"
echo
echo "  ${BOLD}[single-domain]${NC}  one hostname, path-based fan-out"
printf "    https://%-32s → ${CYAN}%s${NC}\n"  "${public_host}/"          "${bridge_ip}:${MEET_FRONTEND_PORT}    (catch-all)"
printf "    https://%-32s → ${CYAN}%s${NC}\n"  "${public_host}/api/*"     "${bridge_ip}:${MEET_API_PORT}"
printf "    https://%-32s → ${CYAN}%s${NC}\n"  "${public_host}/ws/*"      "${bridge_ip}:${MEET_API_PORT}    (WebSocket)"
printf "    https://%-32s → ${CYAN}%s${NC}\n"  "${public_host}/livekit/*" "${bridge_ip}:${MEET_LIVEKIT_WS_PORT}    (WS, ${BOLD}strip prefix${NC}, 24h)"
echo
echo "  ${BOLD}[three-domain]${NC}    one hostname per service"
printf "    https://%-32s → ${CYAN}%s${NC}\n"  "${public_host}/"           "${bridge_ip}:${MEET_FRONTEND_PORT}"
printf "    https://%-32s → ${CYAN}%s${NC}\n"  "api.${public_host}/"       "${bridge_ip}:${MEET_API_PORT}"
printf "    wss://%-34s → ${CYAN}%s${NC}\n"    "livekit.${public_host}/"   "${bridge_ip}:${MEET_LIVEKIT_WS_PORT}    (WS, 24h)"
echo
echo "  ${DIM}Reference snippets: caddy/single-domain.Caddyfile, caddy/three-domain.Caddyfile,${NC}"
echo "  ${DIM}                    nginx/single-domain.conf,    nginx/three-domain.conf${NC}"
echo

# ─────────────────────────────── firewall ───────────────────────────────
echo "${BOLD}Host firewall (internet-facing):${NC}"
echo "    tcp/443                  — HTTPS via your reverse proxy"
echo "    tcp/${MEET_LIVEKIT_TCP_PORT}                 — LiveKit TCP fallback (direct, NOT proxied)"
echo "    udp/${LIVEKIT_UDP_PORT_RANGE_START}-${LIVEKIT_UDP_PORT_RANGE_END}        — LiveKit RTC media       (direct, NOT proxied)"
echo

# ────────────────────────── reachability check ──────────────────────────
echo "${BOLD}Reachability (from this host):${NC}"

check_http() {
    local label=$1 url=$2 expect=${3:-200}
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 "$url" 2>/dev/null || true)
    code=${code:-000}
    if [ "$code" = "$expect" ]; then
        printf "    ${GREEN}✓${NC} %-22s %-3s  ${DIM}%s${NC}\n" "$label" "$code" "$url"
    elif [ "$code" = "000" ]; then
        printf "    ${RED}✗${NC} %-22s %-3s  ${DIM}%s (unreachable)${NC}\n" "$label" "$code" "$url"
    else
        printf "    ${YELLOW}!${NC} %-22s %-3s  ${DIM}%s${NC}\n" "$label" "$code" "$url"
    fi
}

check_tcp_listen() {
    local label=$1 port=$2
    if ss -tlnH "sport = :$port" 2>/dev/null | grep -q LISTEN; then
        printf "    ${GREEN}✓${NC} %-22s %s\n" "$label" "tcp/$port listening"
    else
        printf "    ${RED}✗${NC} %-22s %s\n" "$label" "tcp/$port NOT listening"
    fi
}

check_udp_range_listen() {
    local label=$1 start=$2 end=$3
    local count
    count=$(ss -ulnH 2>/dev/null \
            | awk -v s="$start" -v e="$end" '
                {
                    n = split($4, a, ":")
                    p = a[n] + 0
                    if (p >= s && p <= e) c++
                }
                END { print c+0 }')
    if [ "$count" -gt 0 ]; then
        printf "    ${GREEN}✓${NC} %-22s %s\n" "$label" "udp/$start-$end: $count port(s) listening"
    else
        printf "    ${YELLOW}!${NC} %-22s %s\n" "$label" "udp/$start-$end: 0 listening (livekit allocates on demand)"
    fi
}

check_http "frontend"       "http://${bridge_ip}:${MEET_FRONTEND_PORT}/health"
check_http "meet-api"       "http://${bridge_ip}:${MEET_API_PORT}/health"
check_http "livekit signal" "http://${bridge_ip}:${MEET_LIVEKIT_WS_PORT}/"
check_tcp_listen "livekit TCP fb" "${MEET_LIVEKIT_TCP_PORT}"
check_udp_range_listen "livekit RTC udp" "${LIVEKIT_UDP_PORT_RANGE_START}" "${LIVEKIT_UDP_PORT_RANGE_END}"
echo

# ───────────────────── /api/admin/login routing probe ───────────────────
# Diagnoses the most common reverse-proxy bug: the manager generates a
# prefix-stripping route for /api/* (correct only for /livekit/*), so the
# API sees /admin/login instead of /api/admin/login and 404s.
echo "${BOLD}/api routing probe${NC}  ${DIM}(POST /api/admin/login with empty body):${NC}"

probe_login() {
    local label=$1 url=$2
    local body code
    body=$(curl -sS -o /tmp/.meet-probe.$$ -w '%{http_code}' \
                --max-time 6 \
                -X POST -H 'content-type: application/json' -d '{}' \
                "$url" 2>/dev/null || true)
    code=${body:-000}
    local payload
    payload=$(head -c 200 /tmp/.meet-probe.$$ 2>/dev/null || true)
    rm -f /tmp/.meet-probe.$$

    case "$code" in
        400)
            if printf '%s' "$payload" | grep -qi 'username'; then
                printf "    ${GREEN}✓${NC} %-30s %s — API reached, prefix preserved\n" "$label" "$code"
            else
                printf "    ${YELLOW}!${NC} %-30s %s — 400 but unexpected body: %s\n" "$label" "$code" "$payload"
            fi
            ;;
        404)
            if printf '%s' "$payload" | grep -q 'Cannot POST /admin/login'; then
                printf "    ${RED}✗${NC} %-30s %s — proxy is ${BOLD}stripping /api${NC}; API got /admin/login\n" "$label" "$code"
            else
                printf "    ${RED}✗${NC} %-30s %s — %s\n" "$label" "$code" "$payload"
            fi
            ;;
        405)
            if printf '%s' "$payload" | grep -qi 'nginx'; then
                printf "    ${RED}✗${NC} %-30s %s — request hit ${BOLD}frontend nginx${NC}; /api/* route missing or losing to catch-all\n" "$label" "$code"
            else
                printf "    ${RED}✗${NC} %-30s %s — %s\n" "$label" "$code" "$payload"
            fi
            ;;
        502|503|504)
            printf "    ${RED}✗${NC} %-30s %s — proxy can't reach upstream (check bridge IP / port)\n" "$label" "$code"
            ;;
        000)
            printf "    ${RED}✗${NC} %-30s --- — unreachable\n" "$label"
            ;;
        *)
            printf "    ${YELLOW}!${NC} %-30s %s — unexpected; first 200 bytes: %s\n" "$label" "$code" "$payload"
            ;;
    esac
}

probe_login "direct (bridge)" "http://${bridge_ip}:${MEET_API_PORT}/api/admin/login"
if [ -n "$PUBLIC_BASE_URL" ]; then
    if [ "$layout" = "single-domain" ]; then
        probe_login "via proxy ($public_host)" "${PUBLIC_BASE_URL%/}/api/admin/login"
    else
        # Three-domain: API lives at api.<host>/admin/login, no /api prefix
        probe_login "via proxy (${PUBLIC_API_URL:-api.$public_host})" "${PUBLIC_API_URL%/}/admin/login"
    fi
else
    printf "    ${DIM}(skipping public-URL probe — PUBLIC_BASE_URL not set)${NC}\n"
fi
echo

echo "${BOLD}Strip-prefix rule${NC}  ${DIM}(applies to single-domain only):${NC}"
echo "    Only ${YELLOW}/livekit/*${NC} strips its prefix. ${YELLOW}/api/*${NC} and ${YELLOW}/ws/*${NC} ${BOLD}must NOT strip${NC} —"
echo "    the upstreams expect to receive the path with the prefix intact."
echo
printf "    %-12s %-14s %s\n" "PATH"        "BEHAVIOUR"     "PROXY DIRECTIVE"
printf "    %-12s ${BOLD}%-14s${NC} %s\n"   "/livekit/*" "STRIP"          "Caddy ${YELLOW}handle_path${NC} · nginx ${YELLOW}rewrite${NC}"
printf "    %-12s ${BOLD}%-14s${NC} %s\n"   "/api/*"     "PRESERVE"       "Caddy ${YELLOW}handle${NC}      · no rewrite"
printf "    %-12s ${BOLD}%-14s${NC} %s\n"   "/ws/*"      "PRESERVE"       "Caddy ${YELLOW}handle${NC}      · no rewrite"
printf "    %-12s ${BOLD}%-14s${NC} %s\n"   "/"          "catch-all"      "→ frontend (port ${MEET_FRONTEND_PORT})"
echo
echo "    ${DIM}Failure modes if the rule is violated:${NC}"
echo "    ${DIM}  • /api stripped     → 404 'Cannot POST /admin/login' from Express${NC}"
echo "    ${DIM}  • /api unmatched    → 405 from frontend nginx (catch-all wins)${NC}"
echo "    ${DIM}  • /livekit not WS   → 404 / immediate disconnect${NC}"
echo

# ───────────────── iframe-embedding header probe ────────────────────────
# Catches the case where the host reverse proxy injects
# "X-Frame-Options: SAMEORIGIN" as a default security header — the
# frontend's nginx and the API both already remove it, so any X-Frame-Options
# in the response is the proxy's. With it set, MEET cannot be embedded in
# any iframe (XRay desktop app, third-party portal, etc.) regardless of
# what's in the admin panel's "iframe allowed domains".
if [ -n "$PUBLIC_BASE_URL" ]; then
    echo "${BOLD}Iframe-embedding probe${NC}  ${DIM}(GET ${PUBLIC_BASE_URL%/}/  HEAD-only):${NC}"
    headers=$(curl -sS -I --max-time 5 "${PUBLIC_BASE_URL%/}/" 2>/dev/null || true)
    xfo=$(printf '%s' "$headers" | awk 'tolower($1) == "x-frame-options:" { sub(/^[^:]*: */, ""); sub(/\r$/, ""); print; exit }')
    csp=$(printf '%s' "$headers" | awk 'tolower($1) == "content-security-policy:" { sub(/^[^:]*: */, ""); sub(/\r$/, ""); print; exit }')

    if [ -n "$xfo" ]; then
        printf "    ${RED}✗${NC} X-Frame-Options: ${BOLD}%s${NC} — set by the proxy. Iframe embedding will be blocked.\n" "$xfo"
        printf "    ${DIM}Fix in the proxy: add header directive ${YELLOW}-X-Frame-Options${DIM} for this site${NC}\n"
        printf "    ${DIM}                   and set ${YELLOW}Content-Security-Policy: frame-ancestors *${DIM} (or specific origins).${NC}\n"
    else
        printf "    ${GREEN}✓${NC} no X-Frame-Options header\n"
    fi

    if printf '%s' "$csp" | grep -qi 'frame-ancestors'; then
        printf "    ${GREEN}✓${NC} Content-Security-Policy frame-ancestors present\n"
    else
        printf "    ${YELLOW}!${NC} Content-Security-Policy frame-ancestors missing — embedding may be blocked by some browsers\n"
    fi
    echo
fi

# ───────────────── LiveKit signaling flush/timeout probe ────────────────
# Catches the "WS upgrades to 101 but the call sticks at 'Connecting…'" bug:
# Caddy's default reverse_proxy buffers writes until ~1s; LiveKit's first
# signaling frame is tiny so it sits in the buffer forever. Reference
# Caddyfile uses flush_interval -1 + 24h timeouts. ProxyPilot/NPM defaults
# do neither.
#
# We can't speak the LiveKit binary protocol from shell, but we can do the
# next-best thing: time how long curl takes to receive bytes after the
# Upgrade handshake. With flush_interval -1, LiveKit's join-response shows
# up in <500ms. With the default, curl just hangs until the upstream gives
# up. We give it 4s and report.
if [ -n "$PUBLIC_BASE_URL" ]; then
    case "$layout" in
        single-domain) ws_url="${PUBLIC_BASE_URL%/}/livekit/" ;;
        *)             ws_url="${PUBLIC_LIVEKIT_URL:-wss://livekit.$public_host}" ;;
    esac
    # Force https scheme for curl (it speaks ws over http(s) natively when
    # the right Upgrade headers are sent).
    probe_url="${ws_url/wss:\/\//https://}"
    probe_url="${probe_url/ws:\/\//http://}"
    probe_url="${probe_url%/}/"

    echo "${BOLD}LiveKit signaling probe${NC}  ${DIM}(WS upgrade to ${probe_url}):${NC}"
    # Generate a fake but valid Sec-WebSocket-Key
    ws_key=$(head -c 16 /dev/urandom 2>/dev/null | base64 2>/dev/null \
             || printf '%s' "abcdefghijklmnop" | base64)

    ws_out=$(curl -sS -i --http1.1 --max-time 4 \
                  -H "Connection: Upgrade" \
                  -H "Upgrade: websocket" \
                  -H "Sec-WebSocket-Version: 13" \
                  -H "Sec-WebSocket-Key: ${ws_key}" \
                  -w '\n__TIME=%{time_total} __CODE=%{http_code}' \
                  "$probe_url" 2>&1 || true)

    code=$(printf '%s' "$ws_out" | sed -n 's/.*__CODE=\([0-9][0-9]*\).*/\1/p' | tail -n1)
    elapsed=$(printf '%s' "$ws_out" | sed -n 's/.*__TIME=\([0-9.][0-9.]*\).*/\1/p' | tail -n1)
    code=${code:-000}
    elapsed=${elapsed:-0}

    case "$code" in
        101)
            printf "    ${GREEN}✓${NC} WS upgrade returned 101 in ${elapsed}s — proxy is forwarding the handshake\n"
            printf "    ${DIM}Note: this only proves the upgrade works. If calls still stick at 'Connecting…',${NC}\n"
            printf "    ${DIM}the proxy is buffering post-handshake frames. Add to the /livekit/* route:${NC}\n"
            printf "    ${DIM}  • Caddy: ${YELLOW}flush_interval -1${DIM} and ${YELLOW}read_timeout 24h${DIM} / ${YELLOW}write_timeout 24h${NC}\n"
            printf "    ${DIM}  • nginx: ${YELLOW}proxy_buffering off${DIM}; ${YELLOW}proxy_read_timeout 24h${DIM}; ${YELLOW}proxy_send_timeout 24h${DIM};${NC}\n"
            ;;
        404)
            printf "    ${RED}✗${NC} 404 — /livekit/* route missing or pointed at the wrong upstream\n"
            ;;
        502|503|504)
            printf "    ${RED}✗${NC} %s — proxy can't reach the livekit upstream (port %s)\n" "$code" "$MEET_LIVEKIT_WS_PORT"
            ;;
        000)
            printf "    ${RED}✗${NC} timed out / unreachable after ${elapsed}s\n"
            ;;
        *)
            printf "    ${YELLOW}!${NC} unexpected status %s after ${elapsed}s\n" "$code"
            ;;
    esac
    echo
fi

# ─────────────────────── LiveKit auth probe ─────────────────────────────
# Catches the OTHER silent breakage: meet-api and the livekit container
# disagree on the API key/secret. Login still works (no LiveKit involved),
# but every /api/rooms call returns "Unauthorized: invalid API key" and
# the admin panel just shows "Disconnected". We invoke the SDK from inside
# the meet-api container so we test the EXACT credentials it would use.
echo "${BOLD}LiveKit auth probe${NC}  ${DIM}(meet-api → livekit RoomService.listRooms):${NC}"

meet_api_id=$(docker compose ps -q meet-api 2>/dev/null || true)
if [ -z "$meet_api_id" ]; then
    printf "    ${YELLOW}!${NC} %s\n" "meet-api container is not running (try: docker compose up -d)"
else
    lk_probe=$(docker compose exec -T meet-api node -e "
      try {
        const { RoomServiceClient } = require('livekit-server-sdk');
        const c = new RoomServiceClient(
          process.env.LIVEKIT_URL,
          process.env.LIVEKIT_API_KEY,
          process.env.LIVEKIT_API_SECRET
        );
        c.listRooms()
         .then(() => process.stdout.write('OK'))
         .catch(e => process.stdout.write('ERR:' + (e && e.message ? e.message : String(e))));
      } catch (e) {
        process.stdout.write('ERR:' + (e && e.message ? e.message : String(e)));
      }
    " 2>&1 || echo "ERR:exec_failed")

    api_key=$(docker compose exec -T meet-api sh -c 'printf "%s" "$LIVEKIT_API_KEY"' 2>/dev/null)
    api_key_short="${api_key:0:14}…"

    case "$lk_probe" in
        OK*)
            printf "    ${GREEN}✓${NC} %s\n" "auth OK — meet-api can list rooms with key ${BOLD}${api_key_short}${NC}"
            ;;
        *"invalid API key"*|*"Unauthorized"*"key"*)
            printf "    ${RED}✗${NC} %s\n" "${BOLD}KEY MISMATCH${NC} — meet-api's key (${api_key_short}) is not configured in livekit"
            printf "    ${DIM}%s${NC}\n" "Reinstall (./install.sh option 5) — it will reuse meet-api's key and install the matching pair in livekit."
            ;;
        *"signature is invalid"*|*"Unauthorized"*)
            printf "    ${RED}✗${NC} %s\n" "${BOLD}SECRET MISMATCH${NC} — key ${api_key_short} is known to livekit but the secret differs"
            printf "    ${DIM}%s${NC}\n" "Reinstall (./install.sh option 5) — it will rewrite LIVEKIT_KEYS to match meet-api's secret."
            ;;
        *"ECONNREFUSED"*|*"connection refused"*|*"ETIMEDOUT"*|*"timeout"*)
            printf "    ${RED}✗${NC} %s\n" "livekit unreachable from meet-api — check that the livekit container is running on host networking"
            ;;
        *"Cannot find module"*"livekit-server-sdk"*)
            printf "    ${YELLOW}!${NC} %s\n" "livekit-server-sdk not found in meet-api image — rebuild meet-api"
            ;;
        ERR:exec_failed)
            printf "    ${YELLOW}!${NC} %s\n" "could not exec into meet-api (compose project mismatch?). Try: docker compose -p $compose_project ps"
            ;;
        ERR:*)
            printf "    ${RED}✗${NC} %s\n" "${lk_probe#ERR:}"
            ;;
        *)
            printf "    ${YELLOW}!${NC} %s\n" "unexpected output: $lk_probe"
            ;;
    esac
fi
echo

# ───────────────── WebRTC media reachability sanity ─────────────────────
# "could not establish pc connection" is the LiveKit client telling you ICE
# failed: signaling worked (room created in admin panel) but no peer
# connection candidates could be reached. This is almost always one of:
#   (a) LIVEKIT_NODE_IP isn't the address clients see (mismatch with NAT'd
#       public IP, or it's the LXC's bridge IP and the WAN can't route to it)
#   (b) host firewall is dropping udp/${LIVEKIT_UDP_PORT_RANGE_START}-${LIVEKIT_UDP_PORT_RANGE_END} inbound
#   (c) LXC isn't forwarding UDP to the container (no incus proxy device,
#       bridge not WAN-routable)
#   (d) cloud-provider security group is blocking UDP independently of the
#       host firewall (very common — gets missed)
echo "${BOLD}WebRTC media reachability${NC}  ${DIM}(why 'could not establish pc connection' happens):${NC}"

printf "    %-32s ${CYAN}%s${NC}\n" "Advertised to clients:"  "${LIVEKIT_NODE_IP:-<auto via STUN>}"

detected_pub=$(curl -4 -sS --max-time 3 https://ifconfig.me 2>/dev/null \
               || curl -4 -sS --max-time 3 https://api.ipify.org 2>/dev/null \
               || true)
if [ -n "$detected_pub" ]; then
    printf "    %-32s ${CYAN}%s${NC}\n" "Detected public IPv4:" "$detected_pub"
    if [ -n "$LIVEKIT_NODE_IP" ] && [ "$LIVEKIT_NODE_IP" != "$detected_pub" ]; then
        printf "    ${YELLOW}!${NC} mismatch — clients will dial ${BOLD}%s${NC}, but this host\n" "$LIVEKIT_NODE_IP"
        printf "      appears as ${BOLD}%s${NC} from the internet. If you're behind NAT, NODE_IP\n" "$detected_pub"
        printf "      should be your router's WAN IP — fix in .env then ${YELLOW}docker compose up -d livekit${NC}.\n"
    elif [ -z "$LIVEKIT_NODE_IP" ]; then
        printf "    ${YELLOW}!${NC} LIVEKIT_NODE_IP empty — relying on STUN auto-detect. Set it to ${BOLD}%s${NC}\n" "$detected_pub"
        printf "      in .env to skip STUN ambiguity.\n"
    else
        printf "    ${GREEN}✓${NC} LIVEKIT_NODE_IP matches detected public IP\n"
    fi
fi
echo
echo "    ${DIM}From a machine OUTSIDE the LXC/host (a phone on cellular works):${NC}"
printf "      ${YELLOW}nc -u -v -w 2 %s 50000${NC}\n" "${LIVEKIT_NODE_IP:-<host-public-ip>}"
printf "      ${YELLOW}nc    -v -w 2 %s 7881${NC}    ${DIM}# TCP fallback${NC}\n" "${LIVEKIT_NODE_IP:-<host-public-ip>}"
echo "    ${DIM}'No route to host' / 'Connection refused' = firewall (host or cloud SG) is blocking.${NC}"
echo
echo "    ${DIM}Checklist when signaling succeeds but the call sticks at 'Connecting…':${NC}"
echo "    ${DIM}  • host firewall (ufw/firewalld/iptables) allows udp/${LIVEKIT_UDP_PORT_RANGE_START}-${LIVEKIT_UDP_PORT_RANGE_END} + tcp/${MEET_LIVEKIT_TCP_PORT} inbound${NC}"
echo "    ${DIM}  • cloud-provider security group / VPC firewall allows the same (often a separate layer)${NC}"
echo "    ${DIM}  • LXC: bridge IP routable from WAN, OR an incus 'proxy' device forwards UDP to the LXC${NC}"
echo "    ${DIM}  • LIVEKIT_NODE_IP equals the address browsers reach — not the LXC's internal IP${NC}"
echo "    ${DIM}  • If clients are behind UDP-blocking networks (corporate / hotel wifi), they need TURN${NC}"
echo "    ${DIM}    over tcp/443 — not bundled in this install path${NC}"
echo

# ───────────────────────────── pitfalls ─────────────────────────────────
echo "${BOLD}Common pitfalls:${NC}"
echo "    • ${YELLOW}5355${NC} (tcp + udp) is the LXC's mDNS/LLMNR responder — ${BOLD}not${NC} a MEET port."
echo "      ProxyPilot/NPM auto-detect will surface it. Ignore it."
echo "    • Don't map a non-WebSocket route to ${YELLOW}${MEET_LIVEKIT_WS_PORT}${NC} — it'll 404."
echo "    • Don't reverse-proxy ${YELLOW}udp/${LIVEKIT_UDP_PORT_RANGE_START}-${LIVEKIT_UDP_PORT_RANGE_END}${NC} or ${YELLOW}tcp/${MEET_LIVEKIT_TCP_PORT}${NC} through Caddy/nginx;"
echo "      they're L4 forwards (host firewall or 'incus config device add … proxy …')."
echo "    • Don't edit ${YELLOW}LIVEKIT_API_KEY${NC} / ${YELLOW}LIVEKIT_API_SECRET${NC} / ${YELLOW}LIVEKIT_KEYS${NC} in .env"
echo "      individually — they must agree. Re-run install.sh to regenerate consistently."
echo "    • The proxy must NOT inject ${YELLOW}X-Frame-Options${NC}. The frontend and API both"
echo "      already strip it. If the iframe probe shows it, your proxy is adding it as a"
echo "      default header — remove it for this site (Caddy ${YELLOW}-X-Frame-Options${NC})."
echo "    • The ${YELLOW}/livekit/*${NC} reverse-proxy block needs ${BOLD}flush_interval -1${NC} (Caddy) or"
echo "      ${BOLD}proxy_buffering off${NC} (nginx) and ${BOLD}24h read/write timeouts${NC}. Without these,"
echo "      the WS upgrades but signaling frames stick in the proxy's write buffer and"
echo "      the call hangs at 'Connecting…'."
echo "    • Three-domain layout requires the frontend to be ${BOLD}rebuilt${NC} with"
echo "      ${YELLOW}PUBLIC_API_URL${NC} and ${YELLOW}PUBLIC_LIVEKIT_URL${NC} set, otherwise the SPA dials"
echo "      relative '/api' on the frontend host and you get 405s like"
echo "      ${DIM}POST https://${public_host}/api/admin/login → 405${NC}."
echo "      Rebuild with: ${YELLOW}docker compose build meet-frontend && docker compose up -d${NC}"
echo

# ────────────────────────── compose handles ─────────────────────────────
echo "${BOLD}Compose handles${NC}  ${DIM}(project name: ${compose_project}):${NC}"
echo "    ${YELLOW}docker compose ps${NC}                              # from this directory"
echo "    ${YELLOW}docker compose logs -f meet-api${NC}                # service-name form (always works)"
echo "    ${YELLOW}docker compose exec meet-api sh${NC}"
echo "    ${DIM}# If you're outside this directory, prepend  -p ${compose_project}${NC}"
echo "    ${DIM}# Container names: ${compose_project}-<service>-1  (e.g. ${compose_project}-meet-api-1)${NC}"
echo

echo "${DIM}Walk-through:  docs/install/external-reverse-proxy.md${NC}"
echo
