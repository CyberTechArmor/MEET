#!/usr/bin/env bash
# Sync the host's existing TLS cert into the MEET LXC's TURN cert dir
# and restart coturn so it picks up the rotation.
#
# Run on the INCUS HOST (not inside the LXC). Designed to be called from
# cron daily so cert rotations propagate automatically.
#
#   sudo bash deploy/external-proxy/sync-cert.sh
#
# Override discovery via env vars (all optional):
#   MEET_CONTAINER       LXC name to push into        (default: meet)
#   TURN_DOMAIN          hostname the cert is for     (default: read from .env)
#   CADDY_CERT_DIR       Caddy data dir on the host   (auto-detected)
#   LXC_TLS_PATH         where to put the cert in LXC (default: /root/MEET/deploy/external-proxy/tls)
#
# Recommended cron entry on the host:
#   /etc/cron.daily/meet-turn-cert-sync   →  this script

set -e

CONTAINER="${MEET_CONTAINER:-meet}"
LXC_TLS_PATH="${LXC_TLS_PATH:-/root/MEET/deploy/external-proxy/tls}"
LXC_DEPLOY_DIR="${LXC_DEPLOY_DIR:-/root/MEET/deploy/external-proxy}"

if ! command -v incus >/dev/null 2>&1; then
    echo "incus CLI not found. Run this on the Incus host, not inside the LXC." >&2
    exit 1
fi

if ! incus list --format csv -c n 2>/dev/null | grep -qx "$CONTAINER"; then
    echo "Container '$CONTAINER' not found. Set MEET_CONTAINER if your LXC has a different name." >&2
    incus list --format csv -c n | sed 's/^/  - /'
    exit 1
fi

# If TURN_DOMAIN isn't set, pull it from the LXC's .env.
if [ -z "${TURN_DOMAIN:-}" ]; then
    TURN_DOMAIN=$(incus exec "$CONTAINER" -- sh -c "grep -E '^TURN_DOMAIN=' $LXC_DEPLOY_DIR/.env | tail -n1 | cut -d= -f2-" 2>/dev/null || true)
fi
if [ -z "$TURN_DOMAIN" ]; then
    echo "Could not determine TURN_DOMAIN. Set it in $LXC_DEPLOY_DIR/.env or pass it via env." >&2
    exit 1
fi

# Find the cert. ProxyPilot, host Caddy, and host certbot all keep it in
# different places; try each. CADDY_CERT_DIR overrides discovery.
candidate_dirs=()
if [ -n "${CADDY_CERT_DIR:-}" ]; then
    candidate_dirs+=("$CADDY_CERT_DIR")
fi
# ProxyPilot's caddy data volume.
proxypilot_volumes=$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -iE '(proxypilot|caddy).*(caddy_data|data)' || true)
for vol in $proxypilot_volumes; do
    candidate_dirs+=("/var/lib/docker/volumes/$vol/_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$TURN_DOMAIN")
    candidate_dirs+=("/var/lib/docker/volumes/$vol/_data/caddy/certificates/acme.zerossl.com-v2-dv90/$TURN_DOMAIN")
done
# Plain host Caddy.
candidate_dirs+=(
    "/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$TURN_DOMAIN"
    "$HOME/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$TURN_DOMAIN"
)
# certbot.
candidate_dirs+=(
    "/etc/letsencrypt/live/$TURN_DOMAIN"
)

src_dir=""
src_crt=""
src_key=""
for d in "${candidate_dirs[@]}"; do
    if [ -f "$d/${TURN_DOMAIN}.crt" ] && [ -f "$d/${TURN_DOMAIN}.key" ]; then
        src_dir="$d"
        src_crt="$d/${TURN_DOMAIN}.crt"
        src_key="$d/${TURN_DOMAIN}.key"
        break
    elif [ -f "$d/fullchain.pem" ] && [ -f "$d/privkey.pem" ]; then
        src_dir="$d"
        src_crt="$d/fullchain.pem"
        src_key="$d/privkey.pem"
        break
    fi
done

if [ -z "$src_dir" ]; then
    echo "Could not find a cert for $TURN_DOMAIN. Tried:" >&2
    for d in "${candidate_dirs[@]}"; do echo "  - $d" >&2; done
    echo "Override with CADDY_CERT_DIR=/path/to/cert/dir" >&2
    exit 1
fi

echo "Source: $src_dir"
echo "  cert: $src_crt"
echo "  key:  $src_key"
echo "Target: $CONTAINER:$LXC_TLS_PATH/turn.{crt,key}"

incus file push "$src_crt" "$CONTAINER$LXC_TLS_PATH/turn.crt" -m 0644
incus file push "$src_key" "$CONTAINER$LXC_TLS_PATH/turn.key" -m 0600

echo "✓ Cert files synced. Restarting coturn…"
incus exec "$CONTAINER" -- sh -c "cd $LXC_DEPLOY_DIR && docker compose --profile turn restart coturn"
echo "✓ Done. Run 'bash $LXC_DEPLOY_DIR/info.sh' inside the LXC to verify."
