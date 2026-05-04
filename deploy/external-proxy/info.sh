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

# Pick the first global IPv4 — that's the bridge address the host proxy dials.
bridge_ip=$(ip -4 -o addr show scope global 2>/dev/null \
            | awk '{print $4}' | cut -d/ -f1 | head -n1)
bridge_ip=${bridge_ip:-<bridge-ip>}

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

echo "${BOLD}Prefix-strip rules${NC} (must match in your reverse proxy config):"
echo "    /livekit/*  →  ${BOLD}STRIP${NC}     (Caddy ${YELLOW}handle_path${NC}, nginx ${YELLOW}rewrite${NC})"
echo "    /api/*      →  ${BOLD}DO NOT STRIP${NC}  (Caddy ${YELLOW}handle${NC},      no rewrite)"
echo "    /ws/*       →  ${BOLD}DO NOT STRIP${NC}  (Caddy ${YELLOW}handle${NC},      no rewrite)"
echo "    /           →  catch-all → frontend"
echo

# ───────────────────────────── pitfalls ─────────────────────────────────
echo "${BOLD}Common pitfalls:${NC}"
echo "    • Don't map any service to ${YELLOW}5355${NC}. That's mDNS/LLMNR on the LXC, not MEET."
echo "    • Don't map a non-WebSocket route to ${YELLOW}${MEET_LIVEKIT_WS_PORT}${NC} — it'll 404."
echo "    • Don't reverse-proxy ${YELLOW}udp/${LIVEKIT_UDP_PORT_RANGE_START}-${LIVEKIT_UDP_PORT_RANGE_END}${NC} or ${YELLOW}tcp/${MEET_LIVEKIT_TCP_PORT}${NC} through Caddy/nginx;"
echo "      they're L4 forwards (host firewall or 'incus config device add … proxy …')."
echo "    • Don't strip the ${YELLOW}/api${NC} or ${YELLOW}/ws${NC} prefix — only ${YELLOW}/livekit${NC} is stripped."
echo "      If 'via proxy' returned 404 'Cannot POST /admin/login', that's this bug."
echo "    • Three-domain layout requires the frontend to be ${BOLD}rebuilt${NC} with"
echo "      ${YELLOW}PUBLIC_API_URL${NC} and ${YELLOW}PUBLIC_LIVEKIT_URL${NC} set, otherwise the SPA dials"
echo "      relative '/api' on the frontend host and you get 405s like"
echo "      ${DIM}POST https://${public_host}/api/admin/login → 405${NC}."
echo "      Rebuild with: ${YELLOW}docker compose build meet-frontend && docker compose up -d${NC}"
echo

echo "${DIM}Walk-through:  docs/install/external-reverse-proxy.md${NC}"
echo
