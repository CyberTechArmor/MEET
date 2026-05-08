#!/usr/bin/env bash
# Mount the host's existing cert directory into the MEET LXC as a
# read-only Incus disk device. The cert file is then the SAME file the
# host's reverse proxy (ProxyPilot's Caddy, host certbot, host Caddy,
# …) is already managing — when it rotates, the LXC sees the new
# content immediately. No cron, no copy, no two-sources-of-truth.
#
# Run on the INCUS HOST (not inside the LXC). Idempotent: re-running
# with the same source is a no-op; re-running with a different source
# rebinds.
#
#   sudo bash mount-cert.sh
#
# Override discovery / target via env vars (all optional):
#   MEET_CONTAINER       LXC name                       (default: meet)
#   TURN_DOMAIN          hostname the cert is for       (default: read from .env)
#   CADDY_CERT_DIR       Caddy cert dir on the host     (auto-detected)
#   LXC_MOUNT_PATH       where to expose it in the LXC  (default: /var/meet-tls)
#
# After the mount is in place, on the LXC:
#   ./update.sh        # picks up TURN_CERT_MOUNT, restarts coturn

set -e

CONTAINER="${MEET_CONTAINER:-meet}"
LXC_MOUNT_PATH="${LXC_MOUNT_PATH:-/var/meet-tls}"
LXC_DEPLOY_DIR="${LXC_DEPLOY_DIR:-/root/MEET/deploy/external-proxy}"
DEVICE_NAME="meet-tls"

if ! command -v incus >/dev/null 2>&1; then
    echo "incus CLI not found. Run this on the Incus host, not inside the LXC." >&2
    exit 1
fi

if ! incus list --format csv -c n 2>/dev/null | grep -qx "$CONTAINER"; then
    echo "Container '$CONTAINER' not found. Set MEET_CONTAINER if your LXC has a different name." >&2
    incus list --format csv -c n | sed 's/^/  - /' >&2
    exit 1
fi

# If TURN_DOMAIN isn't set, pull it from the LXC's .env.
if [ -z "${TURN_DOMAIN:-}" ]; then
    TURN_DOMAIN=$(incus exec "$CONTAINER" -- sh -c "grep -E '^TURN_DOMAIN=' $LXC_DEPLOY_DIR/.env 2>/dev/null | tail -n1 | cut -d= -f2-" 2>/dev/null || true)
fi
if [ -z "$TURN_DOMAIN" ]; then
    echo "Could not determine TURN_DOMAIN. Set it in $LXC_DEPLOY_DIR/.env or pass it via env." >&2
    exit 1
fi

# Discover the Caddy cert dir for $TURN_DOMAIN. ProxyPilot, host Caddy,
# and host certbot all keep certs in different places; try each.
candidates=()
if [ -n "${CADDY_CERT_DIR:-}" ]; then
    candidates+=("$CADDY_CERT_DIR")
fi
proxypilot_volumes=$(docker volume ls --format '{{.Name}}' 2>/dev/null \
                     | grep -iE '(proxypilot|caddy).*(caddy_data|data)' || true)
for vol in $proxypilot_volumes; do
    candidates+=(
        "/var/lib/docker/volumes/$vol/_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$TURN_DOMAIN"
        "/var/lib/docker/volumes/$vol/_data/caddy/certificates/acme.zerossl.com-v2-dv90/$TURN_DOMAIN"
    )
done
candidates+=(
    "/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$TURN_DOMAIN"
    "$HOME/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$TURN_DOMAIN"
    "/etc/letsencrypt/live/$TURN_DOMAIN"
)

src_dir=""
for d in "${candidates[@]}"; do
    if [ -d "$d" ] && { [ -f "$d/${TURN_DOMAIN}.crt" ] || [ -f "$d/fullchain.pem" ]; }; then
        src_dir="$d"
        break
    fi
done

if [ -z "$src_dir" ]; then
    echo "Could not find a cert dir for $TURN_DOMAIN. Tried:" >&2
    for d in "${candidates[@]}"; do echo "  - $d" >&2; done
    echo "" >&2
    echo "Override with:  CADDY_CERT_DIR=/path/to/cert/dir sudo bash $0" >&2
    exit 1
fi

# Idempotent: if the device already exists pointing at the same source,
# no-op. If it points elsewhere, rebind. Either way, end state is the
# device pointing at $src_dir.
existing_source=$(incus config device show "$CONTAINER" 2>/dev/null \
                  | awk -v d="$DEVICE_NAME:" '$0 ~ "^"d"$"{found=1; next} /^[a-z]/{found=0} found && /^[[:space:]]*source:/ {print $2; exit}')

if [ -n "$existing_source" ] && [ "$existing_source" = "$src_dir" ]; then
    echo "✓ Already mounted ($src_dir → $CONTAINER:$LXC_MOUNT_PATH)"
    echo "  Cert files visible in the LXC at $LXC_MOUNT_PATH/"
    exit 0
fi

if [ -n "$existing_source" ]; then
    echo "Rebinding mount from $existing_source to $src_dir…"
    incus config device remove "$CONTAINER" "$DEVICE_NAME"
fi

incus config device add "$CONTAINER" "$DEVICE_NAME" disk \
    source="$src_dir" \
    path="$LXC_MOUNT_PATH" \
    readonly=true >/dev/null

echo "✓ Mounted $src_dir → $CONTAINER:$LXC_MOUNT_PATH (readonly)"
echo "  Cert rotations propagate live; no cron required."
echo

# Trigger update.sh inside the LXC so coturn comes up automatically.
# Skipping requires explicit SKIP_UPDATE=1 — without it, the operator
# would run mount-cert.sh, see "✓ Mounted", and then have to remember
# to also run update.sh in the LXC. That's the manual step we're
# trying to remove.
if [ "${SKIP_UPDATE:-0}" = "1" ]; then
    echo "  SKIP_UPDATE=1 set — not invoking update.sh in the LXC."
    echo "  Run it yourself: incus exec $CONTAINER -- bash -c 'cd /root/MEET && ./update.sh'"
    exit 0
fi

LXC_REPO_DIR="$(dirname "$(dirname "$LXC_DEPLOY_DIR")")"
echo "  Triggering update.sh inside $CONTAINER…"
echo

if incus exec "$CONTAINER" -- bash -c "[ -f $LXC_REPO_DIR/update.sh ]" 2>/dev/null; then
    incus exec "$CONTAINER" --env TERM=xterm-256color -- bash -c "cd $LXC_REPO_DIR && ./update.sh --mode 5"
    echo
    echo "✓ Done. coturn should be running. Verify inside the LXC:"
    echo "    incus exec $CONTAINER -- bash -c 'cd $LXC_DEPLOY_DIR && bash info.sh'"
else
    echo "  update.sh not found at $LXC_REPO_DIR/update.sh inside $CONTAINER."
    echo "  Run it manually:"
    echo "    incus exec $CONTAINER -- bash -c 'cd /path/to/MEET && ./update.sh'"
fi
