#!/usr/bin/env bash
set -euo pipefail

# Build the code-review-agent container image
# Usage: ./build.sh [--force]
#
# Respects CONTAINER_RUNTIME env var:
#   docker (default):    uses `docker build`
#   apple-container:     uses `container build`

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="code-review-agent"
RUNTIME="${CONTAINER_RUNTIME:-docker}"

FORCE=false
if [ "${1:-}" = "--force" ]; then
    FORCE=true
fi

# Select CLI binary
if [ "$RUNTIME" = "apple-container" ]; then
    CLI="container"
else
    CLI="docker"
fi

# Check if image already exists (skip build unless forced)
if [ "$FORCE" = false ] && $CLI image inspect "$IMAGE_NAME" &>/dev/null; then
    echo "Image '$IMAGE_NAME' already exists. Use --force to rebuild."
    exit 0
fi

echo "Building container image ($CLI): $IMAGE_NAME"
$CLI build -t "$IMAGE_NAME" "$SCRIPT_DIR"
echo "Image '$IMAGE_NAME' built successfully."
