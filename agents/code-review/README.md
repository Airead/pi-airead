# Code Review Agent

An autonomous AI agent that periodically reviews code in a GitHub repository and submits verified issues.

## How It Works

The agent runs in a loop:

1. **Clone/Pull** — Clones the target repo locally (or pulls latest changes)
2. **Select File** — Randomly picks an unreviewed code file
3. **Review (Round 1)** — Spawns a sub-agent to deeply review the file for bugs, security issues, performance problems, and design flaws
4. **Verify (Round 2)** — Spawns another sub-agent to verify the top finding by re-reading the actual code, checking for duplicates, and submitting a single GitHub issue if valid
5. **Wait** — Waits for the configured interval before starting the next cycle

### Key Design Decisions

- **Two-round review**: Round 1 generates findings, Round 2 verifies them against real code. This reduces false positives.
- **One issue per cycle**: Only the most severe finding is submitted each cycle. Others are cached (max 10) for future evaluation.
- **Sub-agent isolation**: Each round runs as an independent pi process via RPC, with its own session. Crash isolation is guaranteed.
- **Findings cache**: Findings accumulate across cycles, sorted by severity. Low-priority findings get naturally displaced by higher-severity ones.
- **Crash recovery**: A state machine (`cycle.json`) tracks progress. If the agent crashes mid-cycle, it resumes from the last checkpoint.

## Prerequisites

- [pi-coding-agent](https://github.com/nicobrinkkemper/pi-mono) installed and in PATH
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- An LLM API key configured for pi

## Usage

```bash
./launch.sh <owner/repo> [interval_hours]
```

### Examples

```bash
# Review facebook/react every hour (default)
./launch.sh facebook/react

# Review a repo every 2 hours
./launch.sh myorg/myrepo 2
```

### Interactive Commands

Once the agent is running, you can use these commands in the pi terminal:

| Command | Description |
|---------|-------------|
| `/review-start` | Start the review loop (auto-started on launch) |
| `/review-stop` | Stop the review loop |
| `/review-now` | Trigger an immediate review cycle |
| `/review-status` | Show review progress and stats |
| `/review-reset` | Reset the reviewed files list |

## File Structure

```
agents/code-review/
├── extensions/
│   └── code-review.ts        # Main extension: scheduling, RPC orchestration, state
├── skills/
│   ├── review/
│   │   └── SKILL.md           # Round 1: code review instructions
│   └── verify/
│       └── SKILL.md           # Round 2: verification & submission instructions
├── workspace/                 # Cloned repositories (gitignored)
├── state/                     # Persistent state (gitignored)
│   ├── cycle.json             # Current cycle state machine
│   ├── reviewed-files.json    # Reviewed file tracking per repo
│   ├── findings-cache.json    # Pending findings queue (max 10)
│   └── sessions.json          # Sub-agent session references
├── launch.sh                  # Entry point
└── README.md
```

## State Files

| File | Purpose |
|------|---------|
| `cycle.json` | Tracks current cycle phase (`idle`/`cloning`/`reviewing`/`verifying`) for crash recovery |
| `reviewed-files.json` | Maps `repo → file → lastReviewedDate`. When all files are reviewed, the oldest half is reset |
| `findings-cache.json` | Priority queue of findings sorted by severity. Max 10 items. One is verified per cycle |
| `sessions.json` | References to sub-agent session files in `~/.pi/sessions/` for debugging |

## GitHub Issues

Issues created by this agent have:
- Label: `ai-code-review`
- Title format: `[ai-review] <category>: <title> (<file>:<line>)`
- Structured body with description, code snippet, and suggested fix
