#!/usr/bin/env bash
set -euo pipefail

# Code Review Agent Launcher
# Usage: ./launch.sh --repo <owner/repo> --data-dir <path> [--interval <hours>] [--provider <name>] [--model <id>] [--runtime <docker|apple-container>]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --------------------------------------------------------------------------
# Provider → API key env var mapping
# --------------------------------------------------------------------------

# NOTE: container-runtime.ts has a parallel mapping in PROVIDER_API_KEY_ENV — keep in sync.
resolve_api_key_env() {
    local provider="$1"
    case "$provider" in
        anthropic)  echo "ANTHROPIC_API_KEY" ;;
        zai)        echo "ZAI_API_KEY" ;;
        openai)     echo "OPENAI_API_KEY" ;;
        google)     echo "GEMINI_API_KEY" ;;
        groq)       echo "GROQ_API_KEY" ;;
        xai)        echo "XAI_API_KEY" ;;
        cerebras)   echo "CEREBRAS_API_KEY" ;;
        openrouter) echo "OPENROUTER_API_KEY" ;;
        mistral)    echo "MISTRAL_API_KEY" ;;
        minimax)    echo "MINIMAX_API_KEY" ;;
        minimax-cn) echo "MINIMAX_CN_API_KEY" ;;
        huggingface) echo "HF_TOKEN" ;;
        kimi)       echo "KIMI_API_KEY" ;;
        *)
            # Fallback: PROVIDER_API_KEY (uppercase, dashes to underscores)
            local upper
            upper="$(echo "$provider" | tr '[:lower:]-' '[:upper:]_')"
            echo "${upper}_API_KEY"
            ;;
    esac
}

# --------------------------------------------------------------------------
# Parse arguments
# --------------------------------------------------------------------------

REPO=""
DATA_DIR=""
INTERVAL="1"
PROVIDER=""
MODEL=""
AUTO_START=false
SKILL_SUFFIX=""
RUNTIME="${CONTAINER_RUNTIME:-docker}"

usage() {
    cat <<EOF
Usage: $0 --repo <owner/repo> --data-dir <path> [options]

Required:
  --repo <owner/repo>    GitHub repository to review (e.g., facebook/react)
  --data-dir <path>      Directory for runtime data (state/ and workspace/)

Optional:
  --interval <hours>     Hours between review cycles (default: 1)
  --provider <name>      AI provider (default: anthropic). e.g., zai, openai, google
  --model <id>           Model ID. e.g., glm-5, gpt-5.4
  --runtime <name>       Container runtime: docker (default) or apple-container
  --auto-start           Automatically start review loop (default: wait for /review-start)
  --skill-suffix <str>   Suffix for skill dirs (e.g., "-test" for e2e dry-run mode)
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
        --provider)
            require_arg "$@"
            PROVIDER="$2"; shift 2 ;;
        --model)
            require_arg "$@"
            MODEL="$2"; shift 2 ;;
        --auto-start)
            AUTO_START=true; shift ;;
        --runtime)
            require_arg "$@"
            RUNTIME="$2"; shift 2 ;;
        --skill-suffix)
            require_arg "$@"
            SKILL_SUFFIX="$2"; shift 2 ;;
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

# Default provider
PROVIDER="${PROVIDER:-anthropic}"

# Resolve to absolute path before any cd
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

# Validate repo format: owner/repo
if ! echo "$REPO" | grep -qE '^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$'; then
    echo "Error: Invalid repo format '$REPO'. Expected: owner/repo"
    exit 1
fi

# --------------------------------------------------------------------------
# Validate runtime
# --------------------------------------------------------------------------

if [ "$RUNTIME" != "docker" ] && [ "$RUNTIME" != "apple-container" ]; then
    echo "Error: Unknown runtime '$RUNTIME'. Supported: docker, apple-container"
    exit 1
fi

export CONTAINER_RUNTIME="$RUNTIME"

# Select CLI binary
if [ "$RUNTIME" = "apple-container" ]; then
    CONTAINER_CLI="container"
else
    CONTAINER_CLI="docker"
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

if ! command -v "$CONTAINER_CLI" &>/dev/null; then
    if [ "$RUNTIME" = "apple-container" ]; then
        echo "Error: 'container' command not found. Install Apple Container: https://github.com/apple/container"
    else
        echo "Error: 'docker' command not found. Docker is required for container isolation."
    fi
    exit 1
fi

if [ "$RUNTIME" = "apple-container" ]; then
    if ! $CONTAINER_CLI system status &>/dev/null 2>&1; then
        echo "Error: Apple Container is not running. Try: container system start"
        exit 1
    fi
else
    if ! $CONTAINER_CLI info &>/dev/null 2>&1; then
        echo "Error: Docker is not running. Please start Docker first."
        exit 1
    fi
fi

# Check API key for the specified provider
API_KEY_ENV="$(resolve_api_key_env "$PROVIDER")"
API_KEY_VALUE="${!API_KEY_ENV:-}"

if [ -z "$API_KEY_VALUE" ]; then
    echo "Error: $API_KEY_ENV environment variable is required for provider '$PROVIDER'."
    exit 1
fi

# Export API key as REVIEW_API_KEY for the extension to read (provider-agnostic)
export REVIEW_API_KEY="$API_KEY_VALUE"

# --------------------------------------------------------------------------
# Prepare directories
# --------------------------------------------------------------------------

REPO_NAME="${REPO//\//_}"
DATA_DIR="$DATA_DIR/$REPO_NAME"
STATE_DIR="$DATA_DIR/state"
REPO_DIR="$DATA_DIR/repo"
MAX_REPO_SIZE_MB=500

mkdir -p "$STATE_DIR"

# --------------------------------------------------------------------------
# Ensure container image is built
# --------------------------------------------------------------------------

IMAGE_NAME="code-review-agent"
CONTAINER_DIR="$SCRIPT_DIR/container"

if ! $CONTAINER_CLI image inspect "$IMAGE_NAME" &>/dev/null; then
    echo "Building container image ($CONTAINER_CLI): $IMAGE_NAME"
    $CONTAINER_CLI build -t "$IMAGE_NAME" "$CONTAINER_DIR"
else
    echo "Container image '$IMAGE_NAME' already exists."
fi

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
echo "  Provider:    $PROVIDER"
echo "  Model:       ${MODEL:-<default>}"
echo "  Runtime:     $RUNTIME"
echo "  Data dir:    $DATA_DIR"
echo "  Interval:    ${INTERVAL} hour(s)"
echo ""

cd "$REPO_DIR"

# Build pi command with optional provider/model flags
PI_ARGS=(
    --append-system-prompt "$SCRIPT_DIR/prompts/APPEND_SYSTEM.md"
    --append-system-prompt "$SCRIPT_DIR/prompts/agents.md"
    -e "$SCRIPT_DIR/extensions/code-review.ts"
    --skill "$SCRIPT_DIR/skills/review${SKILL_SUFFIX}"
    --skill "$SCRIPT_DIR/skills/verify${SKILL_SUFFIX}"
    --review-repo "$REPO"
    --review-interval "$INTERVAL"
    --review-data-dir "$DATA_DIR"
    --review-provider "$PROVIDER"
)

# Pass --provider and --model to pi (built-in flags for the host process)
PI_ARGS+=(--provider "$PROVIDER")

if [ -n "$MODEL" ]; then
    PI_ARGS+=(--model "$MODEL")
    PI_ARGS+=(--review-model "$MODEL")
fi

if [ "$AUTO_START" = true ]; then
    PI_ARGS+=(--review-auto-start)
fi

if [ -n "$SKILL_SUFFIX" ]; then
    PI_ARGS+=(--review-skill-suffix "$SKILL_SUFFIX")
fi

exec pi "${PI_ARGS[@]}"
