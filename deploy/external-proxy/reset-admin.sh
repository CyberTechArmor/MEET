#!/usr/bin/env bash
# Wrapper around `docker compose exec meet-api node dist/reset-admin.js`.
# Run this from the host when you've lost the admin password and/or all
# your passkeys.
#
# Examples:
#
#   bash reset-admin.sh --help
#   bash reset-admin.sh --set-password 'newpass'
#   bash reset-admin.sh --clear-passkeys
#   bash reset-admin.sh --reset-all
#   echo 'newpass' | bash reset-admin.sh --set-password
#   bash reset-admin.sh                       # interactive --set-password (TTY)
#
# Default with no args: interactive password reset, also invalidates
# active sessions and clears passkeys (the assumption: you're recovering
# from a lockout, you want a clean slate). Pass --help to see all options.

set -e
cd "$(dirname "$0")"

if [ "$#" -eq 0 ]; then
    set -- --reset-all
fi

# -T disables docker compose's TTY allocation when stdin is piped; we leave
# it as default (with TTY) so the Node script's interactive prompt works.
exec docker compose exec meet-api node dist/reset-admin.js "$@"
