#!/usr/bin/env bash
# Host-operator entry point. Explicit check/apply/renew + config are required.
# Never run this through an agent to bypass a denied certificate mount.
set -euo pipefail
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/turn-cert.py" "$@"
