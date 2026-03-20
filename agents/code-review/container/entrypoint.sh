#!/bin/sh
# Container entrypoint for code-review agent.
#
# Two modes:
#   1. Root (Apple Container): shadow .env files via mount --bind, run as root.
#      Apple Container uses VM-level isolation, so root is safe.
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
fi

exec "$@"
