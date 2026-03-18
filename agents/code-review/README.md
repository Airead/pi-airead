# Code Review Agent

An autonomous AI agent that periodically reviews code in a GitHub repository and submits verified issues.

## How It Works

The agent runs in a loop:

1. **Select File** — Randomly picks an unreviewed code file
2. **Review (Round 1)** — Spawns a sub-agent to deeply review the file for bugs, security issues, performance problems, and design flaws
3. **Verify (Round 2)** — Spawns another sub-agent to verify the top finding by re-reading the actual code, checking for duplicates, and submitting a single GitHub issue if valid
4. **Wait** — Waits for the configured interval before starting the next cycle

### Key Design Decisions

- **Two-round review**: Round 1 generates findings, Round 2 verifies them against real code. This reduces false positives.
- **One issue per cycle**: Only the most severe finding is submitted each cycle. Others are cached (max 10) for future evaluation.
- **Sub-agent isolation**: Each round runs as an independent pi process via RPC, with its own session. Crash isolation is guaranteed.
- **Findings cache**: Findings accumulate across cycles, sorted by severity. Low-priority findings get naturally displaced by higher-severity ones.
- **Crash recovery**: A state machine (`cycle.json`) tracks progress. If the agent crashes mid-cycle, it resumes from the last checkpoint.
- **External data directory**: All runtime data (state, cloned repos) lives outside the project directory, specified via `--data-dir`.
- **Path safety**: All file writes are constrained to the state directory via `assertPathAllowed`.

## Prerequisites

- [pi-coding-agent](https://github.com/nicobrinkkemper/pi-mono) installed and in PATH
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- An LLM API key configured for pi

## Usage

```bash
./launch.sh --repo <owner/repo> --data-dir <path> [--interval <hours>]
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--repo <owner/repo>` | Yes | GitHub repository to review |
| `--data-dir <path>` | Yes | Directory for runtime data (state/ and workspace/). Relative paths are auto-resolved to absolute. |
| `--interval <hours>` | No | Hours between review cycles (default: 1, range: 0.1–24) |

### Examples

```bash
# Review facebook/react every hour, storing data in /tmp/cr-data
./launch.sh --repo facebook/react --data-dir /tmp/cr-data

# Review a repo every 2 hours
./launch.sh --repo myorg/myrepo --data-dir ~/.code-review-data --interval 2
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

## Directory Structure

```
agents/code-review/               # Project directory (checked into git)
├── prompts/
│   ├── system.md                  # System prompt (--system-prompt)
│   └── agents.md                  # Project instructions (--append-system-prompt)
├── extensions/
│   ├── code-review.ts             # Main extension: scheduling, RPC, state
│   ├── code-review-utils.ts       # Pure utility functions
│   └── code-review-utils.test.ts  # Tests
├── skills/
│   ├── review/
│   │   └── SKILL.md               # Round 1: code review instructions
│   └── verify/
│       └── SKILL.md               # Round 2: verification & submission instructions
├── launch.sh                      # Entry point
└── README.md

<data-dir>/                        # External runtime directory (user-specified)
├── state/                         # Persistent state
│   ├── cycle.json                 # Current cycle state machine
│   ├── reviewed-files.json        # Reviewed file tracking per repo
│   ├── findings-cache.json        # Pending findings queue (max 10)
│   ├── sessions.json              # Sub-agent session references
│   ├── pending-findings.json      # Review round output
│   ├── verify-result.json         # Verify round output
│   └── daily-stats.json           # Daily cycle counter
└── workspace/                     # Cloned repositories
    └── <owner_repo>/
```

## State Files

| File | Purpose |
|------|---------|
| `cycle.json` | Tracks current cycle phase (`idle`/`reviewing`/`verifying`) for crash recovery |
| `reviewed-files.json` | Maps `repo → file → lastReviewedDate`. When all files are reviewed, the oldest half is reset |
| `findings-cache.json` | Priority queue of findings sorted by severity. Max 10 items. One is verified per cycle |
| `sessions.json` | References to sub-agent session files for debugging |
| `daily-stats.json` | Tracks cycle count per day to enforce daily limits |
| `pending-findings.json` | Transient output from the review round (overwritten each cycle) |
| `verify-result.json` | Transient output from the verify round (overwritten each cycle) |

## Safety Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Max cycles per day | 20 | Prevents runaway API usage. Resets at midnight (UTC). |
| Circuit breaker | 5 consecutive failures | Stops the loop automatically. Use `/review-start` to reset and resume. |
| Max repo size | 500 MB | Repositories exceeding this are refused at clone time. |
| Interval range | 0.1–24 hours | Values outside this range are clamped. Invalid input defaults to 1 hour. |
| Failure backoff | Exponential (2^n × base) | Each consecutive failure doubles the wait time. Resets on success. |
| Sub-agent tool calls | 50 per round | Aborts the sub-agent if exceeded, preventing infinite tool loops. |
| Sub-agent timeout | 5 min (review), 3 min (verify) | Hard timeout per round. |
| Session retention | 7 days | Old sub-agent session files are cleaned up after each successful cycle. |
| Reviewed files cap | 5000 per repo | When exceeded, the oldest half is trimmed. |

## GitHub Issues

Issues created by this agent have:
- Label: `ai-code-review`
- Title format: `[ai-review] <category>: <title> (<file>:<line>)`
- Structured body with description, code snippet, and suggested fix
