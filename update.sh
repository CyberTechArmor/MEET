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
    # Detect cert ownership so coturn runs with a uid that can read 0600
    # cert files. If the cert isn't there yet, default to 0:0 (root) —
    # coturn won't be running anyway until the cert lands. Resolve the
    # cert path: TURN_CERT_MOUNT can be absolute (e.g. /var/meet-tls) or
    # relative to the compose dir.
    local _mount_abs
    case "$turn_cert_mount" in
        /*) _mount_abs="$turn_cert_mount" ;;
        *)  _mount_abs="$dir/${turn_cert_mount#./}" ;;
    esac
    local turn_uid="0" turn_gid="0"
    if [ -f "$_mount_abs/$turn_cert_file" ]; then
        turn_uid=$(stat -c '%u' "$_mount_abs/$turn_cert_file" 2>/dev/null || echo "0")
        turn_gid=$(stat -c '%g' "$_mount_abs/$turn_cert_file" 2>/dev/null || echo "0")
    fi

    write_env_kv TURN_ENABLED       "true"             "$env_file"
    write_env_kv TURN_DOMAIN        "$turn_domain"     "$env_file"
    write_env_kv TURN_USERNAME      "$turn_username"   "$env_file"
    write_env_kv TURN_PASSWORD      "$turn_password"   "$env_file"
    write_env_kv TURN_TLS_PORT      "5349"             "$env_file"
    write_env_kv TURN_UDP_PORT      "3478"             "$env_file"
    write_env_kv TURN_RELAY_RANGE_START "55000"        "$env_file"
    write_env_kv TURN_RELAY_RANGE_END   "60000"        "$env_file"
    write_env_kv TURN_CERT_MOUNT    "$turn_cert_mount" "$env_file"
    write_env_kv TURN_CERT_FILE     "$turn_cert_file"  "$env_file"
    write_env_kv TURN_KEY_FILE      "$turn_key_file"   "$env_file"
    write_env_kv TURN_UID           "$turn_uid"        "$env_file"
    write_env_kv TURN_GID           "$turn_gid"        "$env_file"

    echo -e "  ${GREEN}✓${NC} Wrote TURN config to $env_file"
    echo -e "    ${DIM}TURN_DOMAIN=$turn_domain${NC}"
    echo -e "    ${DIM}TURN_CERT_MOUNT=$turn_cert_mount  (file: $turn_cert_file)${NC}"

    # Cert mount status. If missing, instruct the operator clearly.
    # _mount_abs was set above; reuse it.
    if [ ! -d "$_mount_abs" ]; then
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

    # Resolve the cert mount path same way as configure_turn_in_env: it
    # may be absolute or relative-to-compose-dir.
    local _summary_mount_abs
    case "$turn_cert_mount_now" in
        /*) _summary_mount_abs="$turn_cert_mount_now" ;;
        *)  _summary_mount_abs="$dir/${turn_cert_mount_now#./}" ;;
    esac

    if [ "$turn_enabled_now" = "true" ]; then
        echo -e "  TURN:           ${GREEN}enabled${NC}  (coturn will be deployed)"
        echo -e "  TURN_DOMAIN:    ${CYAN}${turn_domain_now:-<unset>}${NC}"
        if [ -d "$_summary_mount_abs" ]; then
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
            printf 'LIVEKIT_KEYS="%s: %s"\n' "$k" "$s" >> "$dir/.env"
            echo -e "${YELLOW}!${NC} Migrated $dir/.env: added LIVEKIT_KEYS from existing key/secret"
        else
            echo -e "${RED}✗ LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing from $dir/.env${NC}"
            echo -e "  Re-run ./install.sh and choose option 5 to regenerate."
            exit 1
        fi
    fi

    # Older installs wrote LIVEKIT_KEYS unquoted, which makes `. .env`
    # in info.sh choke on the colon-space (bash treats it as ending the
    # assignment and tries to run the rest as a command). Detect and
    # re-quote in place.
    if grep -qE '^LIVEKIT_KEYS=[^"]' "$dir/.env"; then
        local raw_val
        raw_val=$(grep -E '^LIVEKIT_KEYS=' "$dir/.env" | tail -n1 | cut -d= -f2-)
        if [ -n "$raw_val" ]; then
            sed -i.bak "s|^LIVEKIT_KEYS=.*|LIVEKIT_KEYS=\"${raw_val}\"|" "$dir/.env"
            rm -f "$dir/.env.bak"
            echo -e "${YELLOW}!${NC} Migrated $dir/.env: quoted LIVEKIT_KEYS so info.sh can source .env safely"
        fi
    fi

    # Port-range consolidation migration. Older installs split host-edge
    # UDP into two disjoint ranges: udp/50000-60000 (LiveKit media) and
    # udp/30000-32000 (coturn relay). Operators had to remember both for
    # the host firewall + cloud security group. New layout: single
    # contiguous udp/50000-60000, split internally at 54900/55000 between
    # LiveKit and coturn. Only migrates when ALL four values exactly
    # match the old defaults — operator customizations survive.
    if grep -qE '^LIVEKIT_UDP_PORT_RANGE_END=60000$' "$dir/.env" \
       && grep -qE '^TURN_RELAY_RANGE_START=30000$' "$dir/.env" \
       && grep -qE '^TURN_RELAY_RANGE_END=32000$' "$dir/.env"; then
        sed -i.bak \
            -e 's|^LIVEKIT_UDP_PORT_RANGE_END=60000$|LIVEKIT_UDP_PORT_RANGE_END=54900|' \
            -e 's|^TURN_RELAY_RANGE_START=30000$|TURN_RELAY_RANGE_START=55000|' \
            -e 's|^TURN_RELAY_RANGE_END=32000$|TURN_RELAY_RANGE_END=60000|' \
            "$dir/.env"
        rm -f "$dir/.env.bak"
        echo -e "${YELLOW}!${NC} Migrated $dir/.env: consolidated UDP ports to a single contiguous"
        echo -e "  range (was: 50000-60000 + 30000-32000; now: 50000-54900 + 55000-60000)."
        echo -e "  ${BOLD}Update your host firewall:${NC} drop the udp/30000-32000 forward."
        echo -e "  ProxyPilot users: the MEET preset will follow up with a one-line change."
    fi

    # Detect the LXC bridge IP and read public IP from .env — needed by
    # both turnserver.conf (relay-ip, when TURN is on) and livekit.yaml
    # (nat_1_to_1_ips). Always run, regardless of turn_enabled, so even
    # non-TURN deployments behind NAT get nat_1_to_1_ips advertised.
    local detected_bridge_ip public_ip
    detected_bridge_ip=$(ip -4 -o addr show scope global 2>/dev/null \
                         | awk '$2 !~ /^(docker|br-|veth|cni|lxcbr|virbr|tun|tap)/ {print $4}' \
                         | cut -d/ -f1 | head -n1)
    detected_bridge_ip=${detected_bridge_ip:-127.0.0.1}
    public_ip=$(grep -E '^LIVEKIT_NODE_IP=' "$dir/.env" | tail -n1 | cut -d= -f2-)

    # If a previous `docker compose up` ran before these files were
    # rendered, Docker auto-created the bind-mount source paths
    # (turnserver.conf, livekit.yaml) as DIRECTORIES. Detect & remove
    # the empty directories so the renders below can write real files.
    local _stale
    for _stale in "$dir/livekit.yaml" "$dir/turnserver.conf"; do
        if [ -d "$_stale" ]; then
            if rmdir "$_stale" 2>/dev/null; then
                echo -e "${YELLOW}!${NC} Removed empty directory at $_stale (Docker auto-created it before the file existed)"
            else
                echo -e "${RED}✗${NC} $_stale is a non-empty directory — refusing to clobber."
                echo -e "  Inspect and remove manually, then re-run update.sh."
                exit 1
            fi
        fi
    done

    # Port ranges, read from .env so operator customizations are honored.
    # Defaults match install.sh's freshly-rendered .env (post-migration).
    local lk_udp_start lk_udp_end turn_relay_start turn_relay_end
    lk_udp_start=$(grep -E '^LIVEKIT_UDP_PORT_RANGE_START=' "$dir/.env" | tail -n1 | cut -d= -f2-)
    lk_udp_end=$(  grep -E '^LIVEKIT_UDP_PORT_RANGE_END='   "$dir/.env" | tail -n1 | cut -d= -f2-)
    turn_relay_start=$(grep -E '^TURN_RELAY_RANGE_START=' "$dir/.env" | tail -n1 | cut -d= -f2-)
    turn_relay_end=$(  grep -E '^TURN_RELAY_RANGE_END='   "$dir/.env" | tail -n1 | cut -d= -f2-)
    lk_udp_start=${lk_udp_start:-50000}
    lk_udp_end=${lk_udp_end:-54900}
    turn_relay_start=${turn_relay_start:-55000}
    turn_relay_end=${turn_relay_end:-60000}

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

        # Detect / refresh TURN_UID / TURN_GID on every update. The cert
        # owner uid only matters for coturn to read the file, and host
        # Caddy may be rebuilt with a different uid across upgrades —
        # cheap to re-stat each run rather than carry a stale value.
        local cur_turn_uid cur_turn_gid stat_uid stat_gid mig_mount_abs
        cur_turn_uid=$(grep -E '^TURN_UID=' "$dir/.env" | tail -n1 | cut -d= -f2-)
        cur_turn_gid=$(grep -E '^TURN_GID=' "$dir/.env" | tail -n1 | cut -d= -f2-)
        stat_uid="0"
        stat_gid="0"
        case "$turn_cert_mount" in
            /*) mig_mount_abs="$turn_cert_mount" ;;
            *)  mig_mount_abs="$dir/${turn_cert_mount#./}" ;;
        esac

        # Probe alternate layouts if the saved path doesn't resolve.
        # Older installs might have a flat path written but the actual
        # cert at <mount>/<domain>/<domain>.crt (Caddy nested) or
        # <mount>/{fullchain,privkey}.pem (certbot). Re-point .env to
        # whichever layout is actually present.
        if [ ! -f "$mig_mount_abs/$turn_cert_file" ]; then
            local _new_cert="" _new_key=""
            if [ -f "$mig_mount_abs/$turn_domain/$turn_domain.crt" ] \
               && [ -f "$mig_mount_abs/$turn_domain/$turn_domain.key" ]; then
                _new_cert="$turn_domain/$turn_domain.crt"
                _new_key="$turn_domain/$turn_domain.key"
            elif [ -f "$mig_mount_abs/fullchain.pem" ] && [ -f "$mig_mount_abs/privkey.pem" ]; then
                _new_cert="fullchain.pem"
                _new_key="privkey.pem"
            fi
            if [ -n "$_new_cert" ]; then
                sed -i.bak \
                    -e "s|^TURN_CERT_FILE=.*|TURN_CERT_FILE=$_new_cert|" \
                    -e "s|^TURN_KEY_FILE=.*|TURN_KEY_FILE=$_new_key|" \
                    "$dir/.env"
                rm -f "$dir/.env.bak"
                turn_cert_file="$_new_cert"
                turn_key_file="$_new_key"
                echo -e "${YELLOW}!${NC} Migrated $dir/.env: TURN_CERT_FILE/TURN_KEY_FILE re-pointed to actual cert location ($_new_cert)"
            fi
        fi

        if [ -f "$mig_mount_abs/$turn_cert_file" ]; then
            stat_uid=$(stat -c '%u' "$mig_mount_abs/$turn_cert_file" 2>/dev/null || echo "0")
            stat_gid=$(stat -c '%g' "$mig_mount_abs/$turn_cert_file" 2>/dev/null || echo "0")
        fi
        if [ "$cur_turn_uid" != "$stat_uid" ] || [ "$cur_turn_gid" != "$stat_gid" ] \
           || [ -z "$cur_turn_uid" ] || [ -z "$cur_turn_gid" ]; then
            # Use the same write_env_kv helper that configure_turn_in_env
            # uses so the .env stays single-source-of-truth.
            local tmp_env_file="$dir/.env"
            sed -i.bak '/^TURN_UID=/d;/^TURN_GID=/d' "$tmp_env_file" 2>/dev/null
            rm -f "$tmp_env_file.bak"
            printf 'TURN_UID=%s\nTURN_GID=%s\n' "$stat_uid" "$stat_gid" >> "$tmp_env_file"
            echo -e "${YELLOW}!${NC} Migrated $dir/.env: TURN_UID=$stat_uid TURN_GID=$stat_gid (matches cert owner)"
        fi

        # Warn if the bind-mount path doesn't exist — coturn will fail
        # to start, but the rest of the stack should be fine. Reuses
        # mig_mount_abs from the uid detection block above.
        if [ ! -d "$mig_mount_abs" ]; then
            echo -e "${YELLOW}!${NC} TURN_CERT_MOUNT ($turn_cert_mount) doesn't exist."
            echo -e "  Run on the Incus host: ${YELLOW}sudo bash $dir/mount-cert.sh${NC}"
            echo -e "  Then re-run update.sh."
        fi

        if [ -f "$dir/turnserver.conf.template" ]; then
            local turn_username turn_password
            turn_username=$(grep -E '^TURN_USERNAME=' "$dir/.env" | tail -n1 | cut -d= -f2-)
            turn_password=$(grep -E '^TURN_PASSWORD=' "$dir/.env" | tail -n1 | cut -d= -f2-)
            sed -e "s|@TURN_UDP_PORT@|3478|g" \
                -e "s|@TURN_TLS_PORT@|5349|g" \
                -e "s|@TURN_RELAY_RANGE_START@|$turn_relay_start|g" \
                -e "s|@TURN_RELAY_RANGE_END@|$turn_relay_end|g" \
                -e "s|@TURN_DOMAIN@|$turn_domain|g" \
                -e "s|@TURN_USERNAME@|$turn_username|g" \
                -e "s|@TURN_PASSWORD@|$turn_password|g" \
                -e "s|@TURN_CERT_FILE@|$turn_cert_file|g" \
                -e "s|@TURN_KEY_FILE@|$turn_key_file|g" \
                -e "s|@BRIDGE_IP@|$detected_bridge_ip|g" \
                -e "s|@LIVEKIT_NODE_IP@|$public_ip|g" \
                "$dir/turnserver.conf.template" > "$dir/turnserver.conf"
            echo -e "${YELLOW}!${NC} Re-rendered $dir/turnserver.conf from template (relay udp/$turn_relay_start-$turn_relay_end)"
        fi
    fi

    # Re-render livekit.yaml from its template every run. Substitute two
    # placeholders:
    #
    # @NAT_1_TO_1_IPS@ — LiveKit's nat_1_to_1_ips config. When the LXC
    #   bridge IP differs from the public IP (typical NAT'd-LXC case),
    #   advertise BOTH so coturn (which is on the bridge) can relay to
    #   LiveKit's bridge candidate directly without a host NAT-loopback.
    #   Symptom of needing this: cellular calls connect slowly (10s+) or
    #   fail with "camera/microphone unavailable".
    #
    # @TURN_SERVERS_BLOCK@ — LiveKit's rtc.turn_servers list. When TURN
    #   is enabled, populate so LiveKit advertises coturn to clients via
    #   the participant join response (a redundant path alongside
    #   meet-api's /api/token iceServers).
    if [ -f "$dir/livekit.yaml.template" ]; then
        local nat_1_to_1_block=""
        if [ -n "$public_ip" ] && [ -n "$detected_bridge_ip" ] && [ "$public_ip" != "$detected_bridge_ip" ]; then
            nat_1_to_1_block=$(cat <<NAT_BLOCK
  nat_1_to_1_ips:
    - $public_ip
    - $detected_bridge_ip
NAT_BLOCK
)
        fi

        # Render TWO turn_servers entries (TLS + UDP) so LiveKit's
        # JoinResponse iceServers covers both paths. The browser tries
        # them in order; cellular survives via TLS, faster networks use
        # UDP.
        local turn_servers_block=""
        if [ "$turn_enabled" = "true" ]; then
            local turn_domain_lk turn_username_lk turn_password_lk
            turn_domain_lk=$(grep -E '^TURN_DOMAIN='   "$dir/.env" | tail -n1 | cut -d= -f2-)
            turn_username_lk=$(grep -E '^TURN_USERNAME=' "$dir/.env" | tail -n1 | cut -d= -f2-)
            turn_password_lk=$(grep -E '^TURN_PASSWORD=' "$dir/.env" | tail -n1 | cut -d= -f2-)
            turn_servers_block=$(cat <<TURN_BLOCK

  turn_servers:
    - host: $turn_domain_lk
      port: 5349
      protocol: tls
      username: $turn_username_lk
      credential: $turn_password_lk
    - host: $turn_domain_lk
      port: 3478
      protocol: udp
      username: $turn_username_lk
      credential: $turn_password_lk
TURN_BLOCK
)
        fi
        awk -v nat_block="$nat_1_to_1_block" \
            -v turn_block="$turn_servers_block" \
            -v lk_udp_start="$lk_udp_start" \
            -v lk_udp_end="$lk_udp_end" '
            {
                gsub(/@NAT_1_TO_1_IPS@/, nat_block);
                gsub(/@TURN_SERVERS_BLOCK@/, turn_block);
                gsub(/@LIVEKIT_UDP_PORT_RANGE_START@/, lk_udp_start);
                gsub(/@LIVEKIT_UDP_PORT_RANGE_END@/, lk_udp_end);
                print
            }
        ' "$dir/livekit.yaml.template" > "$dir/livekit.yaml"
        echo -e "${YELLOW}!${NC} Re-rendered $dir/livekit.yaml (media udp/$lk_udp_start-$lk_udp_end)${turn_servers_block:+ (with turn_servers TLS+UDP)}${nat_1_to_1_block:+ (with nat_1_to_1_ips)}"
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
