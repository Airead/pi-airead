import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CycleState,
	type DailyStats,
	type Finding,
	type ReviewedFiles,
	type SessionRecord,
	type VerifyResult,
	assertPathAllowed,
	atomicWriteJson,
	checkSafetyGates,
	cleanupOldSessions,
	ensureDir,
	filterValidFindings,
	incrementDailyStats,
	isCodeFile,
	mergeFindingsIntoCache,
	parseIntervalHours,
	readJson,
	selectNextFile,
	trimReviewedFiles,
} from "./code-review-utils.js";

// ============================================================================
// Resource Safety Limits
// ============================================================================

export const LIMITS = {
	/** Max review cycles per calendar day */
	maxCyclesPerDay: 20,
	/** Max tool calls per sub-agent before abort */
	maxToolCallsPerSubAgent: 50,
	/** Review sub-agent timeout (ms) */
	reviewTimeoutMs: 300_000,
	/** Verify sub-agent timeout (ms) */
	verifyTimeoutMs: 180_000,
	/** Stop loop after N consecutive failures */
	maxConsecutiveFailures: 5,
	/** Delete session files older than N days */
	sessionRetentionDays: 7,
	/** Max entries in reviewed-files per repo */
	maxReviewedFilesPerRepo: 5000,
} as const;

// ============================================================================
// Lightweight RPC Client (avoids import issues with pi internals)
// ============================================================================

class SubAgentClient {
	private process: ChildProcess | null = null;
	private eventListeners: Array<(event: any) => void> = [];
	private exitListeners: Array<(code: number | null) => void> = [];
	private pendingRequests = new Map<
		string,
		{ resolve: (res: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private requestId = 0;
	private stderr = "";
	private buffer = "";

	constructor(
		private cliPath: string,
		private options: {
			cwd?: string;
			args?: string[];
			env?: Record<string, string>;
		} = {},
	) {}

	async start(): Promise<void> {
		if (this.process) throw new Error("Client already started");

		const args = ["--mode", "rpc", ...(this.options.args ?? [])];

		this.process = spawn("node", [this.cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.process.stderr?.on("data", (data: Buffer) => {
			this.stderr += data.toString();
		});

		this.process.stdout?.on("data", (data: Buffer) => {
			this.buffer += data.toString();
			let newlineIndex: number;
			while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
				const line = this.buffer.slice(0, newlineIndex);
				this.buffer = this.buffer.slice(newlineIndex + 1);
				this.handleLine(line);
			}
		});

		this.process.on("exit", (code) => {
			for (const [, pending] of this.pendingRequests) {
				pending.reject(new Error(`Process exited with code ${code}`));
				clearTimeout(pending.timer);
			}
			this.pendingRequests.clear();
			for (const listener of this.exitListeners) {
				listener(code);
			}
		});

		await new Promise((resolve) => setTimeout(resolve, 200));

		if (this.process.exitCode !== null) {
			throw new Error(`Agent process exited immediately with code ${this.process.exitCode}. Stderr: ${this.stderr}`);
		}
	}

	async stop(): Promise<void> {
		if (!this.process) return;

		// Skip wait if process already exited
		if (this.process.exitCode !== null) {
			this.process = null;
			this.pendingRequests.clear();
			return;
		}

		this.process.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 3000);
			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		this.process = null;
		this.pendingRequests.clear();
	}

	onEvent(listener: (event: any) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx !== -1) this.eventListeners.splice(idx, 1);
		};
	}

	onExit(listener: (code: number | null) => void): () => void {
		this.exitListeners.push(listener);
		return () => {
			const idx = this.exitListeners.indexOf(listener);
			if (idx !== -1) this.exitListeners.splice(idx, 1);
		};
	}

	getStderr(): string {
		return this.stderr;
	}

	async prompt(message: string): Promise<void> {
		await this.send({ type: "prompt", message });
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async getState(): Promise<any> {
		const res = await this.send({ type: "get_state" });
		return this.getData(res);
	}

	waitForIdle(timeout = 600_000): Promise<void> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				unsubEvent();
				unsubExit();
			};

			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Timeout waiting for agent idle after ${timeout}ms`));
			}, timeout);

			const unsubEvent = this.onEvent((event) => {
				if (event.type === "agent_end") {
					cleanup();
					resolve();
				}
			});

			const unsubExit = this.onExit((code) => {
				cleanup();
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`Sub-agent process exited with code ${code}`));
				}
			});
		});
	}

	async promptAndWait(message: string, timeout = 600_000): Promise<void> {
		const idlePromise = this.waitForIdle(timeout);
		try {
			await this.prompt(message);
		} catch (err) {
			// Prevent unhandled rejection from idlePromise if prompt() fails
			idlePromise.catch(() => {});
			throw err;
		}
		return idlePromise;
	}

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// Auto-respond to extension UI requests (permissions, confirmations)
			// Sub-agents run autonomously — approve all tool usage
			if (data.type === "extension_ui_request" && data.id) {
				this.autoRespondToUIRequest(data);
				return;
			}

			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				clearTimeout(pending.timer);
				pending.resolve(data);
				return;
			}

			for (const listener of this.eventListeners) {
				listener(data);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private autoRespondToUIRequest(request: any): void {
		if (!this.process?.stdin) return;

		let response: any;
		switch (request.method) {
			case "confirm":
				response = { type: "extension_ui_response", id: request.id, confirmed: true };
				break;
			case "select":
				// Select first option if available
				response = {
					type: "extension_ui_response",
					id: request.id,
					value: request.options?.[0] ?? "",
				};
				break;
			case "input":
			case "editor":
				response = { type: "extension_ui_response", id: request.id, value: "" };
				break;
			case "notify":
			case "setStatus":
			case "setWidget":
			case "setTitle":
				// No response needed for fire-and-forget UI methods
				return;
			default:
				// Unknown method — cancel to avoid hanging
				response = { type: "extension_ui_response", id: request.id, cancelled: true };
				break;
		}

		this.process.stdin.write(JSON.stringify(response) + "\n");
	}

	private send(command: Record<string, unknown>): Promise<any> {
		if (!this.process?.stdin) throw new Error("Client not started");

		const id = `req_${++this.requestId}`;
		const full = { ...command, id };

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, 30_000);

			this.pendingRequests.set(id, { resolve, reject, timer });
			this.process!.stdin!.write(JSON.stringify(full) + "\n");
		});
	}

	private getData<T>(response: any): T {
		if (!response.success) {
			throw new Error(response.error ?? "Unknown RPC error");
		}
		return response.data as T;
	}
}

// ============================================================================
// Main Extension
// ============================================================================

export default function codeReviewExtension(pi: ExtensionAPI): void {
	// Resolve paths relative to this extension file
	// jiti may provide __filename (CJS compat) or import.meta.url (ESM)
	const currentFile =
		typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
	const extensionDir = dirname(dirname(currentFile));
	const skillsDir = join(extensionDir, "skills");

	// State dir is lazily resolved from --review-data-dir flag
	let _stateDir: string | null = null;
	function getStateDir(): string {
		if (!_stateDir) {
			const dataDir = pi.getFlag("review-data-dir") as string | undefined;
			if (!dataDir) throw new Error("Missing required --review-data-dir flag");
			_stateDir = join(dataDir, "state");
			ensureDir(_stateDir);
		}
		return _stateDir;
	}

	function statePath(name: string): string {
		return join(getStateDir(), name);
	}

	/** Assert a path is inside stateDir before writing. */
	function assertStateWrite(targetPath: string): void {
		assertPathAllowed(targetPath, [getStateDir()]);
	}

	// repoDir = cwd (launch.sh already cd'd into the target repo)
	const repoDir = process.cwd();

	// Detect pi CLI entry point for spawning sub-agents
	const piCliPath = process.argv[1];

	// Register CLI flags
	pi.registerFlag("review-repo", {
		description: "GitHub repository to review (owner/repo)",
		type: "string",
	});
	pi.registerFlag("review-interval", {
		description: "Interval between review cycles in hours (default: 1)",
		type: "string",
		default: "1",
	});
	pi.registerFlag("review-data-dir", {
		description: "Directory for runtime data (state/ and workspace/)",
		type: "string",
	});

	// Register commands
	pi.registerCommand("review-start", {
		description: "Start the automated code review loop",
		handler: async (_args, ctx) => {
			const repo = pi.getFlag("review-repo") as string | undefined;
			if (!repo) {
				ctx.ui.notify("Missing --review-repo flag", "error");
				return;
			}
			startReviewLoop(repo, ctx);
		},
	});

	pi.registerCommand("review-now", {
		description: "Trigger an immediate review cycle",
		handler: async (_args, ctx) => {
			const repo = pi.getFlag("review-repo") as string | undefined;
			if (!repo) {
				ctx.ui.notify("Missing --review-repo flag", "error");
				return;
			}
			if (isRunning) {
				ctx.ui.notify("A review cycle is already running", "warning");
				return;
			}
			const blocked = checkSafetyGatesLocal();
			if (blocked) {
				ctx.ui.notify(blocked, "warning");
				return;
			}
			const prevFailures = consecutiveFailures;
			const didRun = await runCycle(repo, ctx);
			if (didRun && (consecutiveFailures === prevFailures || consecutiveFailures === 0)) {
				incrementDailyStatsLocal();
			}
		},
	});

	pi.registerCommand("review-stop", {
		description: "Stop the automated review loop",
		handler: async (_args, ctx) => {
			if (loopTimer) {
				clearTimeout(loopTimer);
				loopTimer = null;
			}
			loopActive = false;
			ctx.ui.notify("Review loop stopped", "info");
		},
	});

	pi.registerCommand("review-status", {
		description: "Show review progress",
		handler: async (_args, ctx) => {
			const repo = pi.getFlag("review-repo") as string | undefined;
			if (!repo) {
				ctx.ui.notify("Missing --review-repo flag", "error");
				return;
			}
			const reviewed = readJson<ReviewedFiles>(statePath("reviewed-files.json"), {});
			const repoReviewed = reviewed[repo] ?? {};
			const count = Object.keys(repoReviewed).length;
			const cache = readJson<Finding[]>(statePath("findings-cache.json"), []);
			const cycle = readJson<CycleState>(statePath("cycle.json"), { status: "idle" });
			const today = new Date().toISOString().slice(0, 10);
			const stats = readJson<DailyStats>(statePath("daily-stats.json"), { date: today, cycleCount: 0 });
			const todayCycles = stats.date === today ? stats.cycleCount : 0;
			ctx.ui.notify(
				`Repo: ${repo} | Reviewed: ${count} files | Cached findings: ${cache.length} | Cycle: ${cycle.status} | Loop: ${loopActive ? "active" : "stopped"} | Today: ${todayCycles}/${LIMITS.maxCyclesPerDay} cycles | Failures: ${consecutiveFailures}`,
				"info",
			);
		},
	});

	pi.registerCommand("review-reset", {
		description: "Reset reviewed files list for current repo",
		handler: async (_args, ctx) => {
			const repo = pi.getFlag("review-repo") as string | undefined;
			if (!repo) {
				ctx.ui.notify("Missing --review-repo flag", "error");
				return;
			}
			const p = statePath("reviewed-files.json");
			assertStateWrite(p);
			const reviewed = readJson<ReviewedFiles>(p, {});
			delete reviewed[repo];
			atomicWriteJson(p, reviewed);
			ctx.ui.notify(`Reset reviewed files for ${repo}`, "info");
		},
	});

	// Auto-start on session_start if --review-repo is provided
	pi.on("session_start", async (_event, ctx) => {
		const repo = pi.getFlag("review-repo") as string | undefined;
		if (repo) {
			ctx.ui.notify(`Code review agent starting for ${repo}`, "info");
			startReviewLoop(repo, ctx);
		}
	});

	// ========================================================================
	// Loop Control
	// ========================================================================

	let loopActive = false;
	let loopTimer: ReturnType<typeof setTimeout> | null = null;
	let isRunning = false;
	let consecutiveFailures = 0;

	function checkSafetyGatesLocal(): string | null {
		const today = new Date().toISOString().slice(0, 10);
		const stats = readJson<DailyStats>(statePath("daily-stats.json"), { date: today, cycleCount: 0 });
		return checkSafetyGates(consecutiveFailures, stats, today, LIMITS);
	}

	function incrementDailyStatsLocal(): void {
		const today = new Date().toISOString().slice(0, 10);
		const p = statePath("daily-stats.json");
		assertStateWrite(p);
		const stats = readJson<DailyStats>(p, { date: today, cycleCount: 0 });
		const updated = incrementDailyStats(stats, today);
		atomicWriteJson(p, updated);
	}

	function startReviewLoop(repo: string, ctx: any): void {
		if (loopActive) return;
		loopActive = true;
		consecutiveFailures = 0;

		const intervalHours = parseIntervalHours(pi.getFlag("review-interval") as string | undefined);
		const baseIntervalMs = intervalHours * 3600_000;

		const scheduleNext = () => {
			if (!loopActive) return;
			const backoffMultiplier = consecutiveFailures > 0 ? Math.pow(2, consecutiveFailures) : 1;
			const actualInterval = baseIntervalMs * backoffMultiplier;
			const hours = (actualInterval / 3600_000).toFixed(1);
			loopTimer = setTimeout(loop, actualInterval);
			ctx.ui.notify(`Next review in ${hours} hour(s)`, "info");
		};

		const loop = async () => {
			try {
				if (!loopActive) return;

				const blocked = checkSafetyGatesLocal();
				if (blocked) {
					ctx.ui.notify(blocked, "warning");
					// Check again in 1 hour (e.g., daily limit may reset at midnight)
					if (loopActive) loopTimer = setTimeout(loop, 3600_000);
					return;
				}

				const prevFailures = consecutiveFailures;
				const didRun = await runCycle(repo, ctx);

				// Only count cycles that actually ran toward daily limit
				if (didRun && (consecutiveFailures === prevFailures || consecutiveFailures === 0)) {
					incrementDailyStatsLocal();
				}

				// Circuit breaker (re-check after cycle, since runCycle may have incremented failures)
				if (consecutiveFailures >= LIMITS.maxConsecutiveFailures) {
					ctx.ui.notify(
						`Circuit breaker: ${consecutiveFailures} consecutive failures. Loop stopped. Use /review-start to resume.`,
						"error",
					);
					loopActive = false;
					return;
				}

				scheduleNext();
			} catch (err: any) {
				ctx.ui.notify(`Loop error: ${err.message}`, "error");
				consecutiveFailures++;
				if (consecutiveFailures >= LIMITS.maxConsecutiveFailures) {
					loopActive = false;
					ctx.ui.notify("Circuit breaker triggered from loop error. Loop stopped.", "error");
				} else {
					scheduleNext();
				}
			}
		};

		// Start first cycle immediately
		loop();
	}

	// ========================================================================
	// Review Cycle
	// ========================================================================

	/** Returns true if cycle actually ran, false if skipped (e.g., already running) */
	async function runCycle(repo: string, ctx: any): Promise<boolean> {
		if (isRunning) return false;
		isRunning = true;

		try {
			ctx.ui.setStatus("code-review", undefined); // Clear previous status

			// Check for incomplete cycle from crash recovery
			const prevCycle = readJson<CycleState>(statePath("cycle.json"), { status: "idle" });

			if (prevCycle.status === "verifying" && prevCycle.file) {
				// Resume from verification
				ctx.ui.notify(`Recovering: resuming verification for ${prevCycle.file}`, "info");
				await runVerifyRound(repo, ctx);
				finishCycle(repo, prevCycle.file);
				consecutiveFailures = 0;
				cleanupOldSessions(statePath("sessions.json"), LIMITS.sessionRetentionDays, [getStateDir()]);
				trimReviewedFiles(statePath("reviewed-files.json"), repo, LIMITS.maxReviewedFilesPerRepo);
				return true;
			}

			if (prevCycle.status !== "idle" && prevCycle.file) {
				// Other incomplete states: restart the file
				ctx.ui.notify(`Recovering: restarting review for ${prevCycle.file}`, "info");
			}

			// Step 1: Select file
			const file = selectFile(repo, prevCycle.status !== "idle" ? prevCycle.file : undefined);
			if (!file) {
				// All files reviewed is not a failure — just skip this cycle without penalizing
				updateCycleState({ status: "idle" });
				return true;
			}

			ctx.ui.notify(`Reviewing: ${file}`, "info");

			// Step 2: Review round
			updateCycleState({ status: "reviewing", file, repo, startedAt: new Date().toISOString() });
			await runReviewRound(repo, file, ctx);

			// Step 3: Verify round (if there are findings in cache)
			const cache = readJson<Finding[]>(statePath("findings-cache.json"), []);
			if (cache.length > 0) {
				updateCycleState({ status: "verifying", file, repo, startedAt: new Date().toISOString() });
				await runVerifyRound(repo, ctx);
			} else {
				ctx.ui.notify("No findings to verify", "info");
			}

			// Step 4: Finish
			finishCycle(repo, file);
			consecutiveFailures = 0;

			// Housekeeping after successful cycle
			cleanupOldSessions(statePath("sessions.json"), LIMITS.sessionRetentionDays, [getStateDir()]);
			trimReviewedFiles(statePath("reviewed-files.json"), repo, LIMITS.maxReviewedFilesPerRepo);
			return true;
		} catch (err: any) {
			consecutiveFailures++;
			ctx.ui.notify(
				`Review cycle error (failure ${consecutiveFailures}/${LIMITS.maxConsecutiveFailures}): ${err.message}`,
				"error",
			);
			updateCycleState({ status: "idle" });
			return true; // Cycle ran but failed — still counts as "attempted"
		} finally {
			isRunning = false;
		}
	}

	function finishCycle(repo: string, file: string): void {
		// Mark file as reviewed
		const p = statePath("reviewed-files.json");
		assertStateWrite(p);
		const reviewed = readJson<ReviewedFiles>(p, {});
		if (!reviewed[repo]) reviewed[repo] = {};
		reviewed[repo][file] = new Date().toISOString();
		atomicWriteJson(p, reviewed);

		updateCycleState({ status: "idle" });
	}

	function updateCycleState(state: CycleState): void {
		const p = statePath("cycle.json");
		assertStateWrite(p);
		atomicWriteJson(p, state);
	}

	// ========================================================================
	// File Selection
	// ========================================================================

	function selectFile(repo: string, forceFile?: string): string | undefined {
		if (forceFile) return forceFile;

		// Get all tracked files
		const output = execFileSync("git", ["ls-files"], { cwd: repoDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
		const allFiles = output
			.split("\n")
			.filter(Boolean)
			.filter((f) => isCodeFile(f));

		const reviewed = readJson<ReviewedFiles>(statePath("reviewed-files.json"), {});
		const repoReviewed = reviewed[repo] ?? {};
		const { file, updatedReviewed } = selectNextFile(allFiles, repoReviewed);

		// Persist if reviewed map was modified (oldest-half reset)
		if (Object.keys(updatedReviewed).length !== Object.keys(repoReviewed).length) {
			const p = statePath("reviewed-files.json");
			assertStateWrite(p);
			reviewed[repo] = updatedReviewed;
			atomicWriteJson(p, reviewed);
		}

		return file;
	}

	// ========================================================================
	// Round 1: Review
	// ========================================================================

	async function runReviewRound(repo: string, file: string, ctx: any): Promise<void> {
		// Clean previous output
		const pendingPath = statePath("pending-findings.json");
		assertStateWrite(pendingPath);
		try {
			writeFileSync(pendingPath, "[]", "utf-8");
		} catch {
			// Ignore
		}

		const reviewSkillPath = join(skillsDir, "review");

		const client = new SubAgentClient(piCliPath, {
			cwd: repoDir,
			args: ["--skill", reviewSkillPath, "--no-extensions"],
		});

		let toolCallCount = 0;
		const unsubscribe = client.onEvent((event: any) => {
			if (event.type === "tool_execution_start") {
				toolCallCount++;
				ctx.ui.notify(`[Review] Tool (${toolCallCount}/${LIMITS.maxToolCallsPerSubAgent}): ${event.toolName}`, "info");
				if (toolCallCount >= LIMITS.maxToolCallsPerSubAgent) {
					ctx.ui.notify("[Review] Tool call limit reached, aborting sub-agent", "warning");
					client.abort().catch(() => {});
				}
			}
			if (event.type === "tool_execution_end" && event.isError) {
				ctx.ui.notify(`[Review] Tool error: ${event.toolName}`, "warning");
			}
		});

		try {
			await client.start();
			await client.promptAndWait(
				`You are reviewing code in the repository "${repo}".

Use the "review" skill to guide your review process. Read the skill file to get detailed instructions.

**Target file:** ${file}
**Findings output path:** ${statePath("pending-findings.json")}

Review the file thoroughly and write your findings as a JSON array to the output path.`,
				LIMITS.reviewTimeoutMs,
			);

			// Save session reference
			try {
				const state = await client.getState();
				const sp = statePath("sessions.json");
				assertStateWrite(sp);
				const sessions = readJson<SessionRecord[]>(sp, []);
				sessions.push({
					timestamp: new Date().toISOString(),
					type: "review",
					file,
					sessionFile: state.sessionFile,
				});
				// Keep last 100 session records
				if (sessions.length > 100) sessions.splice(0, sessions.length - 100);
				atomicWriteJson(sp, sessions);
			} catch {
				// Session save is best-effort
			}
		} finally {
			unsubscribe();
			await client.stop();
		}

		// Merge new findings into cache (validate sub-agent output)
		const rawFindings = readJson<unknown[]>(statePath("pending-findings.json"), []);
		const newFindings = filterValidFindings(rawFindings);
		const discarded = rawFindings.length - newFindings.length;
		if (discarded > 0) {
			ctx.ui.notify(`[Review] Discarded ${discarded} malformed finding(s)`, "warning");
		}
		if (newFindings.length > 0) {
			ctx.ui.notify(`[Review] Found ${newFindings.length} issue(s) in ${file}`, "info");
			mergeFindingsCache(newFindings);
		} else {
			ctx.ui.notify(`[Review] No issues found in ${file}`, "info");
		}
	}

	function mergeFindingsCache(newFindings: Finding[]): void {
		const p = statePath("findings-cache.json");
		assertStateWrite(p);
		mergeFindingsIntoCache(p, newFindings, 10);
	}

	// ========================================================================
	// Round 2: Verify
	// ========================================================================

	async function runVerifyRound(repo: string, ctx: any): Promise<void> {
		const cache = readJson<Finding[]>(statePath("findings-cache.json"), []);
		if (cache.length === 0) return;

		// Take the top finding
		const finding = cache[0];
		ctx.ui.notify(`[Verify] Checking: ${finding.title} (${finding.file}:${finding.line})`, "info");

		// Clean previous output
		const verifyPath = statePath("verify-result.json");
		assertStateWrite(verifyPath);
		try {
			writeFileSync(verifyPath, "{}", "utf-8");
		} catch {
			// Ignore
		}

		const verifySkillPath = join(skillsDir, "verify");

		const client = new SubAgentClient(piCliPath, {
			cwd: repoDir,
			args: ["--skill", verifySkillPath, "--no-extensions"],
		});

		let toolCallCount = 0;
		const unsubscribe = client.onEvent((event: any) => {
			if (event.type === "tool_execution_start") {
				toolCallCount++;
				ctx.ui.notify(`[Verify] Tool (${toolCallCount}/${LIMITS.maxToolCallsPerSubAgent}): ${event.toolName}`, "info");
				if (toolCallCount >= LIMITS.maxToolCallsPerSubAgent) {
					ctx.ui.notify("[Verify] Tool call limit reached, aborting sub-agent", "warning");
					client.abort().catch(() => {});
				}
			}
			if (event.type === "tool_execution_end" && event.isError) {
				ctx.ui.notify(`[Verify] Tool error: ${event.toolName}`, "warning");
			}
		});

		try {
			await client.start();
			await client.promptAndWait(
				`You are verifying a code review finding before submitting it as a GitHub issue.

Use the "verify" skill to guide your verification process. Read the skill file to get detailed instructions.

**GitHub repo:** ${repo}
**Finding to verify:**
\`\`\`json
${JSON.stringify(finding, null, 2)}
\`\`\`
**Result output path:** ${statePath("verify-result.json")}

Verify this finding by re-reading the actual code, check for duplicates, and submit via gh issue create if valid. Write the result to the output path.`,
				LIMITS.verifyTimeoutMs,
			);

			// Save session reference
			try {
				const state = await client.getState();
				const sp = statePath("sessions.json");
				assertStateWrite(sp);
				const sessions = readJson<SessionRecord[]>(sp, []);
				sessions.push({
					timestamp: new Date().toISOString(),
					type: "verify",
					file: finding.file,
					sessionFile: state.sessionFile,
				});
				if (sessions.length > 100) sessions.splice(0, sessions.length - 100);
				atomicWriteJson(sp, sessions);
			} catch {
				// Session save is best-effort
			}
		} finally {
			unsubscribe();
			await client.stop();
		}

		// Process result
		const result = readJson<VerifyResult>(statePath("verify-result.json"), { status: "rejected", reason: "No output", finding });

		if (result.status === "submitted") {
			ctx.ui.notify(`[Verify] Issue submitted: ${result.issueUrl ?? "unknown URL"}`, "info");
		} else {
			ctx.ui.notify(`[Verify] Finding rejected: ${result.reason ?? "unknown reason"}`, "info");
		}

		// Remove processed finding from cache (always remove, whether submitted or rejected)
		const cp = statePath("findings-cache.json");
		assertStateWrite(cp);
		cache.shift();
		atomicWriteJson(cp, cache);
	}

	// ========================================================================
	// Housekeeping (delegated to utils)
	// ========================================================================
}
