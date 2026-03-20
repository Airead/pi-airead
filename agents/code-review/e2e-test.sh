#!/usr/bin/env bash
set -euo pipefail

# End-to-end test for the code review scheduling loop.
#
# Uses dry-run skill files (review-test / verify-test) so that:
#   - Sub-agents write empty findings / reject all findings
#   - No GitHub issues are ever created
#   - Full scheduling, Docker, RPC, monitoring pipeline is exercised
#
# Usage:
#   ./e2e-test.sh <owner/repo> [--provider <name>] [--model <id>]
#   ./e2e-test.sh <owner/repo>                          # uses REVIEW_PROVIDER / REVIEW_MODEL env vars
#
# Examples:
#   ./e2e-test.sh airead/WenZi
#   ./e2e-test.sh airead/WenZi --provider zai --model glm-5
#   REVIEW_PROVIDER=zai REVIEW_MODEL=glm-5 ./e2e-test.sh airead/WenZi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --------------------------------------------------------------------------
# Parse arguments
# --------------------------------------------------------------------------

REPO=""
PROVIDER="${REVIEW_PROVIDER:-}"
MODEL="${REVIEW_MODEL:-}"

require_arg() {
    if [ $# -lt 2 ] || [[ "$2" == --* ]]; then
        echo "Error: $1 requires a value"
        exit 1
    fi
}

usage() {
    cat <<EOF
Usage: $0 <owner/repo> [options]

Positional:
  <owner/repo>           GitHub repository to test against

Options:
  --provider <name>      AI provider (default: \$REVIEW_PROVIDER or anthropic)
  --model <id>           Model ID (default: \$REVIEW_MODEL or provider default)
  --help                 Show this help message

Environment variables:
  REVIEW_PROVIDER        Default provider (overridden by --provider)
  REVIEW_MODEL           Default model (overridden by --model)

Examples:
  $0 airead/WenZi
  $0 airead/WenZi --provider zai --model glm-5
  REVIEW_PROVIDER=zai REVIEW_MODEL=glm-5 $0 airead/WenZi
EOF
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --provider)
            require_arg "$@"
            PROVIDER="$2"; shift 2 ;;
        --model)
            require_arg "$@"
            MODEL="$2"; shift 2 ;;
        --help|-h)
            usage 0 ;;
        --*)
            echo "Error: Unknown option: $1"; usage 1 ;;
        *)
            if [ -z "$REPO" ]; then
                REPO="$1"; shift
            else
                echo "Error: Unexpected argument: $1"; usage 1
            fi ;;
    esac
done

if [ -z "$REPO" ]; then
    echo "Error: repository argument is required"
    echo ""
    usage 1
fi

# --------------------------------------------------------------------------
# Setup temporary data directory
# --------------------------------------------------------------------------

DATA_DIR="$(mktemp -d)/code-review-e2e"
echo "============================================"
echo " Code Review E2E Test (dry-run mode)"
echo "============================================"
echo "  Repo:      $REPO"
echo "  Provider:  ${PROVIDER:-anthropic}"
echo "  Model:     ${MODEL:-<default>}"
echo "  Data dir:  $DATA_DIR"
echo "  Interval:  0.1 hours (6 minutes)"
echo "  Skills:    review-test / verify-test"
echo "============================================"
echo ""
echo "The review loop will start automatically."
echo "Watch the output to verify scheduling behavior."
echo "Press Ctrl+C to stop when satisfied."
echo ""

# --------------------------------------------------------------------------
# Build launch args
# --------------------------------------------------------------------------

LAUNCH_ARGS=(
    --repo "$REPO"
    --data-dir "$DATA_DIR"
    --interval 0.1
    --auto-start
    --skill-suffix "-test"
)

if [ -n "$PROVIDER" ]; then
    LAUNCH_ARGS+=(--provider "$PROVIDER")
fi

if [ -n "$MODEL" ]; then
    LAUNCH_ARGS+=(--model "$MODEL")
fi

# --------------------------------------------------------------------------
# Cleanup on exit
# --------------------------------------------------------------------------

cleanup() {
    echo ""
    echo "============================================"
    echo " E2E Test Summary"
    echo "============================================"

    REPO_NAME="${REPO//\//_}"
    STATE_DIR="$DATA_DIR/$REPO_NAME/state"

    if [ -d "$STATE_DIR" ]; then
        echo ""
        echo "State files:"
        echo "  cycle.json:"
        cat "$STATE_DIR/cycle.json" 2>/dev/null || echo "    (not found)"
        echo ""
        echo "  daily-stats.json:"
        cat "$STATE_DIR/daily-stats.json" 2>/dev/null || echo "    (not found)"
        echo ""

        # Count reviewed files
        if [ -f "$STATE_DIR/reviewed-files.json" ]; then
            count=$(python3 -c "
import json, sys
d = json.load(open('$STATE_DIR/reviewed-files.json'))
total = sum(len(v) for v in d.values())
print(total)
" 2>/dev/null || echo "?")
            echo "  Reviewed files: $count"
        fi

        # Check findings cache
        if [ -f "$STATE_DIR/findings-cache.json" ]; then
            cache_size=$(python3 -c "
import json
d = json.load(open('$STATE_DIR/findings-cache.json'))
print(len(d))
" 2>/dev/null || echo "?")
            echo "  Findings in cache: $cache_size"
        fi
    fi

    # Verify no issues were created
    echo ""
    echo "Checking for accidentally created GitHub issues..."
    if command -v gh &>/dev/null; then
        issue_count=$(gh issue list -R "$REPO" -l "ai-code-review" --state all --limit 5 --json title 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
        echo "  Issues with 'ai-code-review' label: $issue_count"
    else
        echo "  (gh not available, skipping issue check)"
    fi

    echo ""
    echo "Data dir preserved at: $DATA_DIR"
    echo "  rm -rf $DATA_DIR  # to clean up"
    echo "============================================"
}

trap cleanup EXIT

# --------------------------------------------------------------------------
# Launch
# --------------------------------------------------------------------------

exec "$SCRIPT_DIR/launch.sh" "${LAUNCH_ARGS[@]}"
