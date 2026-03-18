#!/usr/bin/env bash
set -euo pipefail

# Code Review Agent Launcher
# Usage: ./launch.sh --repo <owner/repo> --data-dir <path> [--interval <hours>]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --------------------------------------------------------------------------
# Parse arguments
# --------------------------------------------------------------------------

REPO=""
DATA_DIR=""
INTERVAL="1"

usage() {
    cat <<EOF
Usage: $0 --repo <owner/repo> --data-dir <path> [--interval <hours>]

Required:
  --repo <owner/repo>    GitHub repository to review (e.g., facebook/react)
  --data-dir <path>      Directory for runtime data (state/ and workspace/)

Optional:
  --interval <hours>     Hours between review cycles (default: 1)
  --help                 Show this help message
EOF
    exit "${1:-0}"
}

require_arg() {
    if [ $# -lt 2 ] || [[ "$2" == --* ]]; then
        echo "Error: $1 requires a value"
        exit 1
    fi
}

while [ $# -gt 0 ]; do
    case "$1" in
        --repo)
            require_arg "$@"
            REPO="$2"; shift 2 ;;
        --data-dir)
            require_arg "$@"
            DATA_DIR="$2"; shift 2 ;;
        --interval)
            require_arg "$@"
            INTERVAL="$2"; shift 2 ;;
        --help|-h)
            usage 0 ;;
        *)
            echo "Error: Unknown argument: $1"
            usage 1 ;;
    esac
done

if [ -z "$REPO" ]; then
    echo "Error: --repo is required"
    usage 1
fi

if [ -z "$DATA_DIR" ]; then
    echo "Error: --data-dir is required"
    usage 1
fi

# Resolve to absolute path before any cd
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

# Validate repo format: owner/repo
if ! echo "$REPO" | grep -qE '^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$'; then
    echo "Error: Invalid repo format '$REPO'. Expected: owner/repo"
    exit 1
fi

# --------------------------------------------------------------------------
# Check prerequisites
# --------------------------------------------------------------------------

echo "Checking prerequisites..."

if ! command -v pi &>/dev/null; then
    echo "Error: 'pi' command not found. Please install pi-coding-agent first."
    exit 1
fi

if ! command -v gh &>/dev/null; then
    echo "Error: 'gh' command not found. Please install GitHub CLI first."
    exit 1
fi

if ! gh auth status &>/dev/null; then
    echo "Error: GitHub CLI not authenticated. Run 'gh auth login' first."
    exit 1
fi

# --------------------------------------------------------------------------
# Prepare directories
# --------------------------------------------------------------------------

STATE_DIR="$DATA_DIR/state"
WORKSPACE_DIR="$DATA_DIR/workspace"
REPO_NAME="${REPO//\//_}"
REPO_DIR="$WORKSPACE_DIR/$REPO_NAME"
MAX_REPO_SIZE_MB=500

mkdir -p "$STATE_DIR"
mkdir -p "$WORKSPACE_DIR"

# --------------------------------------------------------------------------
# Clone or update repository
# --------------------------------------------------------------------------

repo_size_ok() {
    local size_kb
    size_kb="$(gh api "repos/$REPO" --jq '.size' 2>/dev/null || echo "")"
    if [ -n "$size_kb" ]; then
        local size_mb=$(( size_kb / 1024 ))
        if [ "$size_mb" -gt "$MAX_REPO_SIZE_MB" ]; then
            echo "Error: Repository $REPO is ${size_mb}MB, exceeds ${MAX_REPO_SIZE_MB}MB limit."
            return 1
        fi
    fi
    return 0
}

if [ -d "$REPO_DIR/.git" ]; then
    echo "Updating repository: $REPO"
    if ! (cd "$REPO_DIR" && git status &>/dev/null && git pull --ff-only 2>/dev/null); then
        echo "Repository broken, re-cloning: $REPO"
        rm -rf "$REPO_DIR"
        repo_size_ok || exit 1
        gh repo clone "$REPO" "$REPO_DIR"
    fi
else
    repo_size_ok || exit 1
    echo "Cloning repository: $REPO"
    gh repo clone "$REPO" "$REPO_DIR"
fi

# --------------------------------------------------------------------------
# Launch pi inside the repo directory
# --------------------------------------------------------------------------

echo ""
echo "Starting code review agent..."
echo "  Repository:  $REPO"
echo "  Data dir:    $DATA_DIR"
echo "  Interval:    ${INTERVAL} hour(s)"
echo ""

cd "$REPO_DIR"

exec pi \
    --system-prompt "$SCRIPT_DIR/prompts/system.md" \
    --append-system-prompt "$SCRIPT_DIR/prompts/agents.md" \
    -e "$SCRIPT_DIR/extensions/code-review.ts" \
    --skill "$SCRIPT_DIR/skills/review" \
    --skill "$SCRIPT_DIR/skills/verify" \
    --review-repo "$REPO" \
    --review-interval "$INTERVAL" \
    --review-data-dir "$DATA_DIR"
