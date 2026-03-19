#!/usr/bin/env bash
set -euo pipefail

# Build the code-review-agent Docker image
# Usage: ./build.sh [--force]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="code-review-agent"

FORCE=false
if [ "${1:-}" = "--force" ]; then
    FORCE=true
fi

# Check if image already exists (skip build unless forced)
if [ "$FORCE" = false ] && docker image inspect "$IMAGE_NAME" &>/dev/null; then
    echo "Image '$IMAGE_NAME' already exists. Use --force to rebuild."
    exit 0
fi

echo "Building Docker image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"
echo "Image '$IMAGE_NAME' built successfully."
