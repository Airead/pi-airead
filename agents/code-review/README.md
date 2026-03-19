# Code Review Agent

An autonomous AI agent that periodically reviews code in a GitHub repository and submits verified issues.

## How It Works

The agent runs in a loop:

1. **Select File** — Randomly picks an unreviewed code file
2. **Review (Round 1)** — Spawns a sub-agent in a Docker container to deeply review the file for bugs, security issues, performance problems, and design flaws
3. **Verify (Round 2)** — Spawns another containerized sub-agent to verify the top finding by re-reading the actual code. If verified, the host orchestrator checks for duplicates and submits a GitHub issue
4. **Wait** — Waits for the configured interval before starting the next cycle

### Key Design Decisions

- **Two-round review**: Round 1 generates findings, Round 2 verifies them against real code. This reduces false positives.
- **One issue per cycle**: Only the most severe finding is submitted each cycle. Others are cached (max 10) for future evaluation.
- **Container isolation**: Each sub-agent runs inside a Docker container with the repo mounted read-only, no real API keys (injected via a credential proxy), resource limits (2 GB memory, 2 CPUs, 256 PIDs), and `.env` files shadowed. All GitHub operations (issue creation, duplicate checks) happen on the host side.
- **Sub-agent RPC**: Communication uses JSON-RPC over stdin/stdout (`docker run -i` + `pi --mode rpc`), preserving real-time tool call monitoring and abort capabilities.
- **Findings cache**: Findings accumulate across cycles, sorted by severity. Low-priority findings get naturally displaced by higher-severity ones.
- **Crash recovery**: A state machine (`cycle.json`) tracks progress. If the agent crashes mid-cycle, it resumes from the last checkpoint.
- **External data directory**: All runtime data (state, cloned repos) lives outside the project directory, specified via `--data-dir`.
- **Path safety**: All file writes are constrained to the state directory via `assertPathAllowed`.

## Prerequisites

- [pi-coding-agent](https://github.com/nicobrinkkemper/pi-mono) installed and in PATH
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- [Docker](https://www.docker.com/) installed and running
- `ANTHROPIC_API_KEY` environment variable set (used by the credential proxy)

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
├── container/
│   ├── Dockerfile                 # Sub-agent container image (node + git, non-root)
│   └── build.sh                   # Standalone image build script
├── prompts/
│   ├── APPEND_SYSTEM.md            # Appended system prompt (--append-system-prompt)
│   └── agents.md                  # Project instructions (--append-system-prompt)
├── extensions/
│   ├── code-review.ts             # Main extension: scheduling, RPC, state
│   ├── code-review-utils.ts       # Pure utility functions + host-side GitHub ops
│   ├── code-review-utils.test.ts  # Tests for utils
│   ├── container-runtime.ts       # Docker runtime abstraction (mounts, env, resource limits)
│   ├── container-runtime.test.ts  # Tests for container runtime
│   ├── credential-proxy.ts        # HTTP proxy that injects API key for containers
│   └── credential-proxy.test.ts   # Tests for credential proxy
├── skills/
│   ├── review/
│   │   └── SKILL.md               # Round 1: code review instructions
│   └── verify/
│       └── SKILL.md               # Round 2: verification only (no GitHub ops)
├── launch.sh                      # Entry point (checks Docker, builds image, clones repo)
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
| Container memory | 2 GB | Docker `--memory` limit per sub-agent container. |
| Container CPUs | 2 | Docker `--cpus` limit per sub-agent container. |
| Container PIDs | 256 | Docker `--pids-limit` to prevent fork bombs. |

## Container Security

Sub-agents run inside Docker containers to mitigate prompt injection from audited code:

| Threat | Mitigation |
|--------|------------|
| Code tampering | Repository mounted read-only (`-v repo:ro`) |
| Credential theft | Credential proxy injects API key; containers only see a placeholder |
| `.env` file leaks | `.env` files shadowed with `/dev/null` mounts |
| Git hook execution | `GIT_CONFIG_NOSYSTEM=1` disables system git config |
| Resource exhaustion | `--memory=2g --cpus=2 --pids-limit=256` |
| Container escape | Non-root user, no `--privileged`, no `docker.sock` mount |
| Unauthorized GitHub actions | All `gh` commands run on host side only; containers have no `gh` access |

## GitHub Issues

Issues created by this agent have:
- Label: `ai-code-review`
- Title format: `[ai-review] <category>: <title> (<file>:<line>)`
- Structured body with description, code snippet, and suggested fix
