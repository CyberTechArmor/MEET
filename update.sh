#!/usr/bin/env bash
# MEET — update script.
#
# Pulls the latest code and rebuilds/restarts your existing install without
# regenerating secrets, certificates, or hostnames. Run this when a new
# MEET version drops.
#
#   ./update.sh             # auto-detect; prompts only when ambiguous
#   ./update.sh --mode 5    # match install.sh option numbers (1..5)
#   ./update.sh --enable-turn   # for mode 5: enable TURN without prompting
#                                 (also: ENABLE_TURN=1 ./update.sh)
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
    local branch before_hash before_subject
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || true)
    before_hash=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
    before_subject=$(git log -1 --format=%s 2>/dev/null || echo "?")

    echo -e "${BOLD}1. Pulling latest code${NC}"
    echo -e "   ${DIM}branch:  ${branch:-DETACHED HEAD}${NC}"
    echo -e "   ${DIM}current: ${before_hash} ${before_subject}${NC}"

    # Detached HEAD: refuse. Continuing would deploy whatever happens to
    # be at this commit, which is rarely what's intended after a
    # `git checkout <hash>` workflow. Better to stop early than to ship
    # stale code silently.
    if [ -z "$branch" ]; then
        echo
        echo -e "${RED}✗ HEAD is detached — refusing to proceed.${NC}"
        echo -e "  This usually means an earlier 'git checkout <hash>' or '<tag>'."
        echo -e "  update.sh wants to track a branch so it can pull and stay current."
        echo
        echo -e "  Fix: ${YELLOW}git checkout <branch>${NC}   (e.g. main, or your fork's deployment branch)"
        exit 1
    fi

    # Dirty tree
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
        echo
        echo -e "  ${YELLOW}!${NC} Local changes detected:"
        git status --short
        echo
        read -p "  Continue without pulling? [y/N]: " yn
        case "$yn" in
            [Yy]*) echo "  Skipping git pull."; echo; check_working_tree_freshness; return ;;
            *) echo "  Aborted."; exit 1 ;;
        esac
    fi

    # Fetch first so we can report position relative to origin without
    # changing local state.
    if ! git fetch origin "$branch" >/dev/null 2>&1; then
        echo -e "  ${YELLOW}!${NC} git fetch failed (network?). Continuing with local copy."
        check_working_tree_freshness
        echo
        return
    fi

    local behind ahead
    behind=$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)
    ahead=$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo 0)

    if [ "$ahead" -gt 0 ] && [ "$behind" -gt 0 ]; then
        echo
        echo -e "  ${RED}✗ Local branch has diverged from origin/$branch${NC}"
        echo -e "    ${DIM}($ahead local commits not in origin, $behind remote commits not in local)${NC}"
        echo -e "  Resolve manually (rebase, reset, or different branch), then re-run."
        exit 1
    fi

    if [ "$behind" -gt 0 ]; then
        echo -e "   ${DIM}behind:  $behind commit(s) — fast-forwarding${NC}"
        if ! git pull --ff-only origin "$branch" 2>&1; then
            echo -e "  ${RED}✗ git pull failed${NC}"
            exit 1
        fi
        local after_hash after_subject
        after_hash=$(git rev-parse --short HEAD)
        after_subject=$(git log -1 --format=%s)
        echo -e "   ${GREEN}✓${NC} now at: ${after_hash} ${after_subject}"
    elif [ "$ahead" -gt 0 ]; then
        echo -e "   ${YELLOW}!${NC} ahead: $ahead local commit(s) not pushed (won't pull)"
    else
        echo -e "   ${GREEN}✓${NC} already up to date"
    fi

    check_working_tree_freshness
    echo
}

# Sanity-check that recently-added files exist in the working tree. If
# they don't, the branch / tag the operator is on predates the work and
# update.sh will silently skip features they expect. Surface this loudly
# rather than letting them debug "why isn't coturn there".
check_working_tree_freshness() {
    local missing=()
    [ ! -f "deploy/external-proxy/turnserver.conf.template" ] && missing+=("deploy/external-proxy/turnserver.conf.template")
    [ ! -f "deploy/external-proxy/mount-cert.sh" ]            && missing+=("deploy/external-proxy/mount-cert.sh")
    if [ ${#missing[@]} -gt 0 ]; then
        echo
        echo -e "  ${YELLOW}!${NC} Working tree is missing files added by recent TURN/coturn work:"
        for f in "${missing[@]}"; do echo "      $f"; done
        echo -e "  ${DIM}If you expected to have those, your branch is older than that work.${NC}"
        echo -e "  ${DIM}Check available branches: ${YELLOW}git branch -a${NC}"
    fi
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

# Walk an interactive operator through enabling TURN: ask for the
# domain, generate creds, fill in cert filenames, write everything to
# .env. Mirrors install.sh's TURN block so re-running install vs.
# answering Y here lands the same .env state.
#
# $1 = compose dir (deploy/external-proxy)
configure_turn_in_env() {
    local dir="$1"
    local env_file="$dir/.env"

    # Read what we already have (in case some keys are present)
    local turn_domain turn_username turn_password turn_cert_mount
    turn_domain=$(grep -E '^TURN_DOMAIN='     "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2-)
    turn_username=$(grep -E '^TURN_USERNAME=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2-)
    turn_password=$(grep -E '^TURN_PASSWORD=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2-)
    turn_cert_mount=$(grep -E '^TURN_CERT_MOUNT=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2-)

    # Default TURN_DOMAIN to the configured PUBLIC_BASE_URL hostname
    # (single-domain mode reuses the existing reverse-proxy cert).
    if [ -z "$turn_domain" ]; then
        local public_base_url public_host
        public_base_url=$(grep -E '^PUBLIC_BASE_URL=' "$env_file" | tail -n1 | cut -d= -f2-)
        public_host="${public_base_url#https://}"
        public_host="${public_host#http://}"
        public_host="${public_host%%/*}"
        turn_domain="$public_host"
    fi
    echo
    echo "  Cert reuse:"
    echo "    [1] Single-domain — reuse the cert your reverse proxy already serves"
    echo "        for $turn_domain. (recommended)"
    echo "    [2] Dedicated turn.<host> — separate cert + DNS record."
    echo
    # Skip interactive prompts when running non-interactively. ENABLE_TURN=1
    # OR a non-TTY environment means "take the defaults" (cert mode 1,
    # hostname = current $turn_domain).
    local cert_mode="1"
    if [ "${ENABLE_TURN:-0}" != "1" ] && [ -t 0 ] && [ -t 1 ]; then
        read -p "  Cert mode [1]: " cert_mode
        cert_mode=${cert_mode:-1}
        case "$cert_mode" in
            2)  turn_domain="turn.$turn_domain" ;;
            *)  ;;
        esac
        read -p "  TURN hostname [$turn_domain]: " turn_domain_in
        turn_domain="${turn_domain_in:-$turn_domain}"
    else
        echo -e "  ${DIM}Non-interactive — using cert mode 1 (single-domain) with hostname $turn_domain${NC}"
    fi

    # Generate creds if missing (idempotent on re-run).
    [ -z "$turn_username" ] && turn_username="meet"
    [ -z "$turn_password" ] && turn_password=$(openssl rand -hex 24 2>/dev/null \
                                               || head -c 24 /dev/urandom | xxd -p)

    # Cert mount default: prefer /var/meet-tls (host bind-mount target)
    # if it exists; otherwise fall back to ./tls.
    if [ -z "$turn_cert_mount" ]; then
        if [ -d "/var/meet-tls" ]; then
            turn_cert_mount="/var/meet-tls"
        else
            turn_cert_mount="./tls"
            mkdir -p "$dir/tls"
        fi
    fi
    local turn_cert_file="$turn_domain.crt"
    local turn_key_file="$turn_domain.key"

    # Write to .env. Replace existing keys, append missing ones. We avoid
    # rewriting the whole file so the operator's other manual edits to
    # .env (if any) survive.
    write_env_kv() {
        local key="$1" val="$2" file="$3"
        if grep -qE "^${key}=" "$file"; then
            # macOS sed and GNU sed differ on -i; use a temp file.
            sed "s|^${key}=.*|${key}=${val}|" "$file" > "$file.tmp" \
                && mv "$file.tmp" "$file"
        else
            printf '%s=%s\n' "$key" "$val" >> "$file"
        fi
    }
    write_env_kv TURN_ENABLED       "true"             "$env_file"
    write_env_kv TURN_DOMAIN        "$turn_domain"     "$env_file"
    write_env_kv TURN_USERNAME      "$turn_username"   "$env_file"
    write_env_kv TURN_PASSWORD      "$turn_password"   "$env_file"
    write_env_kv TURN_TLS_PORT      "5349"             "$env_file"
    write_env_kv TURN_UDP_PORT      "3478"             "$env_file"
    write_env_kv TURN_RELAY_RANGE_START "30000"        "$env_file"
    write_env_kv TURN_RELAY_RANGE_END   "32000"        "$env_file"
    write_env_kv TURN_CERT_MOUNT    "$turn_cert_mount" "$env_file"
    write_env_kv TURN_CERT_FILE     "$turn_cert_file"  "$env_file"
    write_env_kv TURN_KEY_FILE      "$turn_key_file"   "$env_file"

    echo -e "  ${GREEN}✓${NC} Wrote TURN config to $env_file"
    echo -e "    ${DIM}TURN_DOMAIN=$turn_domain${NC}"
    echo -e "    ${DIM}TURN_CERT_MOUNT=$turn_cert_mount  (file: $turn_cert_file)${NC}"

    # Cert mount status. If missing, instruct the operator clearly.
    if [ ! -d "$turn_cert_mount" ]; then
        echo -e "  ${YELLOW}!${NC} Cert mount is not in place yet."
        echo -e "  ${BOLD}Run on the Incus host (NOT inside this LXC):${NC}"
        echo -e "    ${YELLOW}sudo bash $(pwd)/$dir/mount-cert.sh${NC}"
        echo "  After that, this update will continue and coturn will start."
    fi
}

update_with_external_proxy() {
    local dir="deploy/external-proxy"
    [ -f "$dir/docker-compose.yml" ] || { echo -e "${RED}✗ $dir/docker-compose.yml not found.${NC}"; exit 1; }
    if [ ! -f "$dir/.env" ]; then
        echo -e "${RED}✗ $dir/.env not found — was install.sh option 5 ever run?${NC}"
        exit 1
    fi

    # Config summary BEFORE doing anything. Most "I ran update.sh and X
    # didn't happen" reports trace to a config flag the operator didn't
    # know was set. Print TURN_ENABLED + cert mount status loudly so
    # what's about to deploy is obvious.
    echo -e "${BOLD}External-proxy config (from $dir/.env):${NC}"
    local turn_enabled_now turn_domain_now turn_cert_mount_now
    turn_enabled_now=$(grep -E '^TURN_ENABLED='   "$dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
    turn_domain_now=$(grep -E '^TURN_DOMAIN='    "$dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
    turn_cert_mount_now=$(grep -E '^TURN_CERT_MOUNT=' "$dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
    turn_enabled_now=${turn_enabled_now:-false}
    turn_cert_mount_now=${turn_cert_mount_now:-/var/meet-tls}

    if [ "$turn_enabled_now" = "true" ]; then
        echo -e "  TURN:           ${GREEN}enabled${NC}  (coturn will be deployed)"
        echo -e "  TURN_DOMAIN:    ${CYAN}${turn_domain_now:-<unset>}${NC}"
        if [ -d "$turn_cert_mount_now" ]; then
            echo -e "  Cert mount:     ${GREEN}✓${NC} ${turn_cert_mount_now}  (bind-mount in place)"
        else
            echo -e "  Cert mount:     ${RED}✗${NC} ${turn_cert_mount_now}  (NOT mounted — coturn will fail to start)"
            echo -e "                  ${DIM}Run on the Incus host: ${YELLOW}sudo bash $dir/mount-cert.sh${NC}"
        fi
    else
        echo -e "  TURN:           ${YELLOW}disabled${NC}  ${DIM}(coturn will NOT be deployed)${NC}"
        echo -e "  ${DIM}Cellular users will see 'Connecting…' even when wifi works.${NC}"
        echo

        # Three paths to enable:
        #   1. ENABLE_TURN=1 env var or --enable-turn CLI flag — for
        #      non-interactive runs (ProxyPilot, CI, scripts).
        #   2. Interactive Y/n prompt — for normal operator runs.
        #   3. Non-TTY without ENABLE_TURN — VERY loud message rather
        #      than silent skip, since "I ran update and TURN didn't
        #      turn on" is the most common debug.
        local enable_turn_now=""
        if [ "${ENABLE_TURN:-0}" = "1" ]; then
            enable_turn_now="Y"
            echo -e "  ${DIM}ENABLE_TURN=1 — enabling without prompt.${NC}"
        elif [ -t 0 ] && [ -t 1 ]; then
            read -p "  Enable TURN now? [Y/n]: " enable_turn_now
        else
            echo -e "  ${YELLOW}!${NC} ${BOLD}Non-interactive run — TURN was NOT enabled.${NC}"
            echo -e "  ${DIM}stdin or stdout isn't a TTY (piped output, IDE terminal, incus exec${NC}"
            echo -e "  ${DIM}without -t, etc.). Skipping the prompt to avoid hanging.${NC}"
            echo
            echo -e "  ${BOLD}To enable TURN, do one of:${NC}"
            echo -e "    ${YELLOW}./update.sh --enable-turn${NC}        # one-shot, takes defaults"
            echo -e "    ${YELLOW}ENABLE_TURN=1 ./update.sh${NC}        # same, env-var form"
            echo -e "    edit $dir/.env: set TURN_ENABLED=true and TURN_DOMAIN=<host>,"
            echo -e "      then re-run update.sh"
            echo
        fi

        if [[ "$enable_turn_now" =~ ^[Yy]?$ ]]; then
            configure_turn_in_env "$dir"
            # Re-read so the rest of update_with_external_proxy sees
            # the freshly-written values.
            turn_enabled_now="true"
        elif [[ "$enable_turn_now" =~ ^[Nn]$ ]]; then
            echo -e "  ${DIM}OK — leaving TURN disabled. Re-run with --enable-turn to flip later.${NC}"
        fi
    fi
    echo

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
    # CLI flag for non-interactive runs that want TURN turned on without
    # an operator at the prompt. Sets ENABLE_TURN=1 which
    # update_with_external_proxy reads in place of the TTY prompt.
    while [ $# -gt 0 ]; do
        case "$1" in
            --mode)    cli_mode="$2"; shift 2 ;;
            --mode=*)  cli_mode="${1#--mode=}"; shift ;;
            --enable-turn) export ENABLE_TURN=1; shift ;;
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
