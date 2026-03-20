#!/bin/sh
# Container entrypoint for code-review agent.
#
# Two modes:
#   1. Root (Apple Container): shadow .env files via mount --bind, then drop to node user.
#   2. Non-root (Docker with --user): pass through directly.

set -e

if [ "$(id -u)" = "0" ]; then
    # Shadow .env files in the repo to prevent credential leakage.
    # Apple Container (VirtioFS) does not support file-level bind mounts,
    # so we handle this inside the container with mount --bind.
    for f in /workspace/repo/.env /workspace/repo/.env.*; do
        [ -f "$f" ] && mount --bind /dev/null "$f" 2>/dev/null || true
    done
    # Also shadow files ending with .env (e.g. app.env)
    for f in /workspace/repo/*.env; do
        [ -f "$f" ] && mount --bind /dev/null "$f" 2>/dev/null || true
    done

    # Drop privileges to node user (uid 1000)
    exec setpriv --reuid=1000 --regid=1000 --clear-groups -- "$@"
fi

# Already non-root — just run the command
exec "$@"
