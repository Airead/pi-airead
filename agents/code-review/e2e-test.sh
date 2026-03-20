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
#   ./e2e-test.sh --repo <owner/repo> [--provider <name>] [--model <id>]
#
# Example:
#   ./e2e-test.sh --repo Airead/pi-airead
#   ./e2e-test.sh --repo Airead/pi-airead --provider openai --model gpt-4o-mini

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --------------------------------------------------------------------------
# Parse arguments (only repo, provider, model — rest is hardcoded for testing)
# --------------------------------------------------------------------------

REPO=""
PROVIDER=""
MODEL=""

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
        --provider)
            require_arg "$@"
            PROVIDER="$2"; shift 2 ;;
        --model)
            require_arg "$@"
            MODEL="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: $0 --repo <owner/repo> [--provider <name>] [--model <id>]"
            exit 0 ;;
        *)
            echo "Error: Unknown argument: $1"; exit 1 ;;
    esac
done

if [ -z "$REPO" ]; then
    echo "Error: --repo is required"
    exit 1
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
