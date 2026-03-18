#!/usr/bin/env bash
set -euo pipefail

# Code Review Agent Launcher
# Usage: ./launch.sh <owner/repo> [interval_hours]
#
# Examples:
#   ./launch.sh facebook/react          # Review every 1 hour (default)
#   ./launch.sh facebook/react 2        # Review every 2 hours

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Validate arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 <owner/repo> [interval_hours]"
    echo "  owner/repo      GitHub repository to review (e.g., facebook/react)"
    echo "  interval_hours   Hours between review cycles (default: 1)"
    exit 1
fi

REPO="$1"
INTERVAL="${2:-1}"

# Check prerequisites
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

# Ensure state directory exists
mkdir -p "$SCRIPT_DIR/state"
mkdir -p "$SCRIPT_DIR/workspace"

echo "Starting code review agent..."
echo "  Repository:  $REPO"
echo "  Interval:    ${INTERVAL} hour(s)"
echo "  Skills:      $SCRIPT_DIR/skills/review, $SCRIPT_DIR/skills/verify"
echo ""

# Launch pi with the code review extension and skills
exec pi \
    -e "$SCRIPT_DIR/extensions/code-review.ts" \
    --skill "$SCRIPT_DIR/skills/review" \
    --skill "$SCRIPT_DIR/skills/verify" \
    --review-repo "$REPO" \
    --review-interval "$INTERVAL"
