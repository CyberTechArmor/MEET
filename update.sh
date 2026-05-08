#!/usr/bin/env bash
# MEET — update script.
#
# Pulls the latest code and rebuilds/restarts your existing install without
# regenerating secrets, certificates, or hostnames. Run this when a new
# MEET version drops.
#
#   ./update.sh             # auto-detect; prompts only when ambiguous
#   ./update.sh --mode 5    # match install.sh option numbers (1..5)
#
# To force a clean rebuild (no Docker layer cache):
#   FORCE_REBUILD=1 ./update.sh
#
# Modes (mirror install.sh):
#   1  Demo                                          docker-compose.yml
#   2  Bundled Caddy (auto-HTTPS)                    docker-compose.proxy.yml
#   3  Host nginx + Let's Encrypt                    docker-compose.nginx.yml
#   4  ProxyPilot subdomain mode (legacy)            docker-compose.proxypilot.yml
#   5  Behind external reverse proxy / LXC           deploy/external-proxy/

set -e

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'; DIM='\033[2m'
if [ ! -t 1 ]; then CYAN=; GREEN=; YELLOW=; RED=; NC=; BOLD=; DIM=; fi

SUDO=""
[ "$EUID" -ne 0 ] && SUDO="sudo"

# ─────────────────────────── helpers ───────────────────────────────────

print_banner() {
    echo
    echo -e "${BOLD}MEET update${NC}"
    echo -e "${DIM}Pulls latest code and rebuilds without regenerating secrets.${NC}"
    echo
}

require_repo_root() {
    if [ ! -f install.sh ] || [ ! -d frontend ] || [ ! -d api ]; then
        echo -e "${RED}✗ Run this from the MEET repo root.${NC}"
        exit 1
    fi
}

git_pull() {
    if [ ! -d .git ]; then
        echo -e "${YELLOW}!${NC} Not a git checkout — skipping git pull"
        echo
        return
    fi
    local branch
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
    echo -e "${BOLD}1. Pulling latest code${NC} ${DIM}(branch: ${branch:-detached})${NC}"

    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
        echo -e "  ${YELLOW}!${NC} Local changes detected:"
        git status --short
        read -p "  Continue without pulling? [y/N]: " yn
        case "$yn" in
            [Yy]*) echo "  Skipping git pull."; echo; return ;;
            *) echo "  Aborted."; exit 1 ;;
        esac
    fi

    if [ -n "$branch" ]; then
        if ! git pull --ff-only origin "$branch" 2>&1; then
            echo -e "  ${RED}✗ git pull failed${NC} (not fast-forward, conflicts, or network)."
            echo -e "  ${DIM}Resolve manually, then re-run update.sh.${NC}"
            exit 1
        fi
    else
        echo -e "  ${YELLOW}!${NC} detached HEAD — skipping pull"
    fi
    echo
}

# Echo the mode numbers (1..5) that have running containers.
# One per line. Empty if nothing is running.
detect_running_modes() {
    if [ -f docker-compose.yml ] && \
       [ -n "$(docker compose ps -q 2>/dev/null)" ]; then
        # Distinguish demo (frontend/api/livekit) from a coincidental project
        # by checking for the meet-frontend service.
        if docker compose ps --services 2>/dev/null | grep -q '^meet-frontend$'; then
            echo 1
        fi
    fi
    if [ -f docker-compose.proxy.yml ] && \
       [ -n "$(docker compose -f docker-compose.proxy.yml ps -q 2>/dev/null)" ]; then
        echo 2
    fi
    if [ -f docker-compose.nginx.yml ] && \
       [ -n "$(docker compose -f docker-compose.nginx.yml ps -q 2>/dev/null)" ]; then
        echo 3
    fi
    if [ -f docker-compose.proxypilot.yml ] && \
       [ -n "$(docker compose -f docker-compose.proxypilot.yml ps -q 2>/dev/null)" ]; then
        echo 4
    fi
    if [ -f deploy/external-proxy/docker-compose.yml ] && \
       [ -n "$(cd deploy/external-proxy && docker compose ps -q 2>/dev/null)" ]; then
        echo 5
    fi
}

prompt_mode() {
    echo -e "${BOLD}Which install mode are you using?${NC}"
    echo "  ${CYAN}[1]${NC} Demo"
    echo "  ${CYAN}[2]${NC} Bundled Caddy (auto-HTTPS)"
    echo "  ${CYAN}[3]${NC} Host nginx + Let's Encrypt"
    echo "  ${CYAN}[4]${NC} ProxyPilot subdomain (legacy)"
    echo "  ${CYAN}[5]${NC} Behind external reverse proxy / LXC"
    read -p "Enter choice [1-5]: " chosen_mode
    echo
}

build_args=""
[ "${FORCE_REBUILD:-}" = "1" ] && build_args="--no-cache"

# Wait up to 2 minutes for every service in the stack to be running and
# (where a healthcheck exists) healthy. Returns 0 on success, 1 on timeout.
wait_for_healthy() {
    local i
    for i in $(seq 1 24); do
        local bad
        bad=$(docker compose "$@" ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null \
              | awk '$2 != "running" || ($3 != "" && $3 != "healthy" && $3 != "starting") {print $1}' || true)
        if [ -z "$bad" ]; then
            return 0
        fi
        sleep 5
    done
    return 1
}

rebuild_and_up() {
    local label=$1
    shift
    echo -e "${BOLD}Rebuilding ${label}${NC} ${DIM}(${build_args:-cached layers})${NC}"
    if ! docker compose "$@" build $build_args; then
        echo -e "${RED}✗ Build failed.${NC}"
        exit 1
    fi
    echo -e "${BOLD}Restarting${NC}"
    if ! docker compose "$@" up -d; then
        echo -e "${RED}✗ Restart failed.${NC}"
        exit 1
    fi
    echo -e "${BOLD}Waiting for containers to settle…${NC}"
    if wait_for_healthy "$@"; then
        echo -e "${GREEN}✓${NC} all containers running"
    else
        echo -e "${YELLOW}!${NC} some containers still not healthy after 2m:"
        docker compose "$@" ps
        echo -e "${DIM}  Logs: docker compose $* logs --tail 100${NC}"
    fi
}

# ─────────────────────────── per-mode update ───────────────────────────

update_demo() {
    [ -f docker-compose.yml ] || { echo -e "${RED}✗ docker-compose.yml not found.${NC}"; exit 1; }
    rebuild_and_up "demo stack"
    echo
    echo -e "${GREEN}✓ Demo updated.${NC}  ${DIM}http://localhost:3000${NC}"
}

update_with_proxy() {
    [ -f docker-compose.proxy.yml ] || { echo -e "${RED}✗ docker-compose.proxy.yml not found.${NC}"; exit 1; }
    if [ ! -f .env ]; then
        echo -e "${YELLOW}!${NC} .env not found — Caddy needs MEET_DOMAIN. Run install.sh option 2 first."
        exit 1
    fi
    rebuild_and_up "Caddy stack" -f docker-compose.proxy.yml
    local domain
    domain=$(grep -E '^MEET_DOMAIN=' .env 2>/dev/null | tail -n1 | cut -d= -f2-)
    echo
    echo -e "${GREEN}✓ Caddy stack updated.${NC} ${DIM}https://${domain:-<your-domain>}${NC}"
}

update_with_nginx() {
    [ -f docker-compose.nginx.yml ] || { echo -e "${RED}✗ docker-compose.nginx.yml not found.${NC}"; exit 1; }
    rebuild_and_up "nginx-mode containers" -f docker-compose.nginx.yml
    echo
    echo -e "${GREEN}✓ Nginx-mode containers updated.${NC}"
    echo -e "${DIM}This update does NOT touch /etc/nginx/sites-available/meet or your${NC}"
    echo -e "${DIM}Let's Encrypt certificates. If nginx config or templates changed:${NC}"
    echo -e "  ${YELLOW}${SUDO} nginx -t && ${SUDO} systemctl reload nginx${NC}"
}

update_with_proxypilot() {
    [ -f docker-compose.proxypilot.yml ] || { echo -e "${RED}✗ docker-compose.proxypilot.yml not found.${NC}"; exit 1; }
    rebuild_and_up "ProxyPilot subdomain stack" -f docker-compose.proxypilot.yml
    echo
    echo -e "${GREEN}✓ ProxyPilot subdomain stack updated.${NC}"
    echo -e "${DIM}Note: this is the legacy subdomain install. The newer 'External${NC}"
    echo -e "${DIM}reverse proxy / LXC' option (5) is recommended — it ships info.sh${NC}"
    echo -e "${DIM}with single/three-domain probes for ProxyPilot.${NC}"
}

update_with_external_proxy() {
    local dir="deploy/external-proxy"
    [ -f "$dir/docker-compose.yml" ] || { echo -e "${RED}✗ $dir/docker-compose.yml not found.${NC}"; exit 1; }
    if [ ! -f "$dir/.env" ]; then
        echo -e "${RED}✗ $dir/.env not found — was install.sh option 5 ever run?${NC}"
        exit 1
    fi

    # Older installs (before the LiveKit-keys fix) wrote LIVEKIT_API_KEY /
    # LIVEKIT_API_SECRET but no LIVEKIT_KEYS. Reconstruct it from the existing
    # pair so the livekit container can authenticate meet-api after the
    # update — without regenerating credentials, which would invalidate any
    # baked-in API keys.
    if ! grep -q '^LIVEKIT_KEYS=' "$dir/.env"; then
        local k s
        k=$(grep -E '^LIVEKIT_API_KEY='    "$dir/.env" | tail -n1 | cut -d= -f2-)
        s=$(grep -E '^LIVEKIT_API_SECRET=' "$dir/.env" | tail -n1 | cut -d= -f2-)
        if [ -n "$k" ] && [ -n "$s" ]; then
            printf 'LIVEKIT_KEYS=%s: %s\n' "$k" "$s" >> "$dir/.env"
            echo -e "${YELLOW}!${NC} Migrated $dir/.env: added LIVEKIT_KEYS from existing key/secret"
        else
            echo -e "${RED}✗ LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing from $dir/.env${NC}"
            echo -e "  Re-run ./install.sh and choose option 5 to regenerate."
            exit 1
        fi
    fi

    # If TURN is enabled, re-render turnserver.conf from the template +
    # current .env. This catches: bridge IP changes, TURN_DOMAIN changes,
    # TURN_PASSWORD rotations, and template improvements landing via git.
    # Also pre-compute the --profile flag so coturn comes up alongside
    # the rest of the stack.
    local turn_enabled
    turn_enabled=$(grep -E '^TURN_ENABLED=' "$dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
    turn_enabled=${turn_enabled:-false}
    local profile_args=""
    if [ "$turn_enabled" = "true" ]; then
        profile_args="--profile turn"

        # Backfill TURN_CERT_MOUNT / TURN_CERT_FILE / TURN_KEY_FILE for
        # installs that predate the bind-mount refactor. Same pattern as
        # the LIVEKIT_KEYS migration: fill in sensible defaults so update
        # is non-destructive.
        local turn_domain turn_cert_mount turn_cert_file turn_key_file
        turn_domain=$(grep -E '^TURN_DOMAIN=' "$dir/.env" | tail -n1 | cut -d= -f2-)
        turn_cert_mount=$(grep -E '^TURN_CERT_MOUNT=' "$dir/.env" | tail -n1 | cut -d= -f2-)
        turn_cert_file=$(grep -E '^TURN_CERT_FILE=' "$dir/.env" | tail -n1 | cut -d= -f2-)
        turn_key_file=$(grep -E '^TURN_KEY_FILE=' "$dir/.env" | tail -n1 | cut -d= -f2-)
        if [ -z "$turn_cert_mount" ]; then
            if [ -d "/var/meet-tls" ]; then
                turn_cert_mount="/var/meet-tls"
            else
                turn_cert_mount="./tls"
            fi
            printf 'TURN_CERT_MOUNT=%s\n' "$turn_cert_mount" >> "$dir/.env"
            echo -e "${YELLOW}!${NC} Migrated $dir/.env: added TURN_CERT_MOUNT=$turn_cert_mount"
        fi
        if [ -z "$turn_cert_file" ] && [ -n "$turn_domain" ]; then
            turn_cert_file="$turn_domain.crt"
            printf 'TURN_CERT_FILE=%s\n' "$turn_cert_file" >> "$dir/.env"
            echo -e "${YELLOW}!${NC} Migrated $dir/.env: added TURN_CERT_FILE=$turn_cert_file"
        fi
        if [ -z "$turn_key_file" ] && [ -n "$turn_domain" ]; then
            turn_key_file="$turn_domain.key"
            printf 'TURN_KEY_FILE=%s\n' "$turn_key_file" >> "$dir/.env"
            echo -e "${YELLOW}!${NC} Migrated $dir/.env: added TURN_KEY_FILE=$turn_key_file"
        fi

        # Warn if the bind-mount path doesn't exist — coturn will fail
        # to start, but the rest of the stack should be fine.
        if [ ! -d "$turn_cert_mount" ]; then
            echo -e "${YELLOW}!${NC} TURN_CERT_MOUNT ($turn_cert_mount) doesn't exist."
            echo -e "  Run on the Incus host: ${YELLOW}sudo bash $dir/mount-cert.sh${NC}"
            echo -e "  Then re-run update.sh."
        fi

        if [ -f "$dir/turnserver.conf.template" ]; then
            local turn_username turn_password public_ip
            turn_username=$(grep -E '^TURN_USERNAME=' "$dir/.env" | tail -n1 | cut -d= -f2-)
            turn_password=$(grep -E '^TURN_PASSWORD=' "$dir/.env" | tail -n1 | cut -d= -f2-)
            public_ip=$(grep -E '^LIVEKIT_NODE_IP=' "$dir/.env" | tail -n1 | cut -d= -f2-)
            local detected_bridge_ip
            detected_bridge_ip=$(ip -4 -o addr show scope global 2>/dev/null \
                                 | awk '$2 !~ /^(docker|br-|veth|cni|lxcbr|virbr|tun|tap)/ {print $4}' \
                                 | cut -d/ -f1 | head -n1)
            detected_bridge_ip=${detected_bridge_ip:-127.0.0.1}
            sed -e "s|@TURN_UDP_PORT@|3478|g" \
                -e "s|@TURN_TLS_PORT@|5349|g" \
                -e "s|@TURN_RELAY_RANGE_START@|30000|g" \
                -e "s|@TURN_RELAY_RANGE_END@|32000|g" \
                -e "s|@TURN_DOMAIN@|$turn_domain|g" \
                -e "s|@TURN_USERNAME@|$turn_username|g" \
                -e "s|@TURN_PASSWORD@|$turn_password|g" \
                -e "s|@TURN_CERT_FILE@|$turn_cert_file|g" \
                -e "s|@TURN_KEY_FILE@|$turn_key_file|g" \
                -e "s|@BRIDGE_IP@|$detected_bridge_ip|g" \
                -e "s|@LIVEKIT_NODE_IP@|$public_ip|g" \
                "$dir/turnserver.conf.template" > "$dir/turnserver.conf"
            echo -e "${YELLOW}!${NC} Re-rendered $dir/turnserver.conf from template"
        fi
    fi

    (
        cd "$dir"
        # rebuild_and_up does docker compose build + up + healthcheck
        # wait. We pass the profile so coturn is included when enabled.
        local profiles_args="$profile_args"
        if [ -n "$profiles_args" ]; then
            rebuild_and_up "external-proxy stack (with TURN)" $profiles_args
        else
            rebuild_and_up "external-proxy stack"
        fi
    )

    echo
    echo -e "${GREEN}✓ External-proxy stack updated.${NC}"
    echo -e "${DIM}Diagnostics: ${YELLOW}bash $dir/info.sh${NC}"
}

# ─────────────────────────────── main ──────────────────────────────────

main() {
    local cli_mode=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --mode)    cli_mode="$2"; shift 2 ;;
            --mode=*)  cli_mode="${1#--mode=}"; shift ;;
            -h|--help)
                # Print the leading comment block as usage.
                awk '/^#!/{next} /^[^#]/{exit} {sub(/^# ?/,""); print}' "$0"
                exit 0
                ;;
            *) echo -e "${RED}Unknown argument: $1${NC}"; exit 1 ;;
        esac
    done

    print_banner
    require_repo_root
    git_pull

    local chosen_mode="$cli_mode"
    if [ -z "$chosen_mode" ]; then
        local detected
        detected=$(detect_running_modes)
        local count
        count=$(printf '%s' "$detected" | grep -c . || true)
        if [ "$count" = "1" ]; then
            chosen_mode="$(printf '%s' "$detected" | head -n1)"
            echo -e "${BOLD}Detected install mode:${NC} option $chosen_mode"
            echo
        elif [ "$count" -gt 1 ]; then
            echo -e "${YELLOW}!${NC} multiple install modes appear to be running:"
            for m in $detected; do echo "    option $m"; done
            echo
            prompt_mode
        else
            echo -e "${YELLOW}!${NC} no running MEET stack detected."
            prompt_mode
        fi
    fi

    case "$chosen_mode" in
        1) update_demo ;;
        2) update_with_proxy ;;
        3) update_with_nginx ;;
        4) update_with_proxypilot ;;
        5) update_with_external_proxy ;;
        *) echo -e "${RED}Invalid mode: '$chosen_mode' (must be 1..5)${NC}"; exit 1 ;;
    esac
}

main "$@"
