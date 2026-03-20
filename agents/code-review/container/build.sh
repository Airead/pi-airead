#!/usr/bin/env bash
set -euo pipefail

# Build the code-review-agent container image
# Usage: ./build.sh [--force]
#
# Respects CONTAINER_RUNTIME env var. Auto-detects on macOS if not set.
#
# Apple Container's buildkit has DNS issues (containers cannot resolve hostnames
# during build). Workaround: build with Docker first, then export as OCI tarball
# and import into Apple Container.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="code-review-agent"
RUNTIME="${CONTAINER_RUNTIME:-auto}"

FORCE=false
if [ "${1:-}" = "--force" ]; then
    FORCE=true
fi

# Resolve runtime
if [ "$RUNTIME" = "auto" ]; then
    if [ "$(uname)" = "Darwin" ] && command -v container &>/dev/null; then
        RUNTIME="apple-container"
    else
        RUNTIME="docker"
    fi
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

if [ "$RUNTIME" = "apple-container" ]; then
    # Apple Container buildkit cannot resolve DNS during build.
    # Build with Docker, export as OCI tarball, and import.
    if ! command -v docker &>/dev/null; then
        echo "Error: Docker is required to build images for Apple Container (buildkit DNS workaround)."
        echo "Install Docker or build the image manually."
        exit 1
    fi

    echo "Building image via Docker (Apple Container buildkit DNS workaround)..."
    docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"

    echo "Exporting OCI tarball..."
    OCI_TAR="$(mktemp -d)/${IMAGE_NAME}.tar"
    docker save -o "$OCI_TAR" "$IMAGE_NAME"

    echo "Importing into Apple Container..."
    container image load -i "$OCI_TAR"

    rm -f "$OCI_TAR"
    echo "Image '$IMAGE_NAME' imported into Apple Container successfully."
else
    echo "Building container image ($CLI): $IMAGE_NAME"
    $CLI build -t "$IMAGE_NAME" "$SCRIPT_DIR"
    echo "Image '$IMAGE_NAME' built successfully."
fi
