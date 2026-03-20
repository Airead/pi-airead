import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import {
	type CycleState,
	type DailyStats,
	type Finding,
	type ReviewedFiles,
	type SessionRecord,
	type VerifyResult,
	assertPathAllowed,
	atomicWriteJson,
	checkDuplicateIssue,
	checkSafetyGates,
	cleanupOldSessions,
	createGitHubIssue,
	detectRepetition,
	ensureDir,
	findingKey,
	findRelatedFindings,
	filterValidFindings,
	incrementDailyStats,
	isCodeFile,
	mergeFindingsIntoCache,
	parseIntervalHours,
	readJson,
	selectNextFile,
	trimReviewedFiles,
	validateRepo,
} from "./code-review-utils.js";
import {
	calculateBackoffInterval,
	decideCycleRecovery,
	decideLoopAction,
	decidePostCycle,
	shouldIncrementDailyStats,
} from "./code-review-scheduler.js";
import {
	buildContainerArgs,
	cleanupOrphans,
	CONTAINER_PATHS,
	ensureImageBuilt,
	piCliPathInContainer,
	runtimeBin,
	stopContainer,
	detectProxyBindHost,
	type ProviderConfig,
} from "./container-runtime.js";
import { CREDENTIAL_PROXY_PORT, startCredentialProxy, stopCredentialProxy } from "./credential-proxy.js";

// ============================================================================
// Resource Safety Limits
// ============================================================================

export const LIMITS = {
	/** Max review cycles per calendar day */
	maxCyclesPerDay: 20,
	/** Max tool calls per sub-agent before abort */
	maxToolCallsPerSubAgent: 50,
	/** Review sub-agent timeout (ms) */
	reviewTimeoutMs: 600_000,
	/** Verify sub-agent timeout (ms) */
	verifyTimeoutMs: 300_000,
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

export interface ContainerModeOptions {
	repoDir: string;
	stateDir: string;
	sessionsDir?: string;
	skillDirs: string[];
	providerConfig?: ProviderConfig;
}

class SubAgentClient {
	private process: ChildProcess | null = null;
	private eventListeners: Array<(event: any) => void> = [];
	private exitListeners: Array<(code: number | null) => void> = [];
	private pendingRequests = new Map<
		string,
		{ resolve: (res: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private stderr = "";
	private buffer = "";
	private containerName: string | null = null;

	constructor(
		private cliPath: string,
		private options: {
			cwd?: string;
			args?: string[];
			env?: Record<string, string>;
			containerMode?: ContainerModeOptions;
		} = {},
	) {}

	async start(): Promise<void> {
		if (this.process) throw new Error("Client already started");

		const args = ["--mode", "rpc", ...(this.options.args ?? [])];

		if (this.options.containerMode) {
			const { repoDir, stateDir, sessionsDir, skillDirs, providerConfig } = this.options.containerMode;
			this.containerName = `code-review-${Date.now()}`;

			const dockerArgs = buildContainerArgs({
				containerName: this.containerName,
				repoDir,
				stateDir,
				sessionsDir,
				skillDirs,
				piCommand: ["node", piCliPathInContainer(), ...args],
				providerConfig,
			});

			this.process = spawn(runtimeBin(), dockerArgs, {
				stdio: ["pipe", "pipe", "pipe"],
			});
		} else {
			this.process = spawn("node", [this.cliPath, ...args], {
				cwd: this.options.cwd,
				env: { ...process.env, ...this.options.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
		}

		this.process.stderr?.on("data", (data: Buffer) => {
			// Cap stderr to prevent unbounded memory growth
			if (this.stderr.length < 100_000) {
				this.stderr += data.toString();
			}
		});

		this.process.stdout?.on("data", (data: Buffer) => {
			this.buffer += data.toString();
			// Cap buffer to prevent unbounded growth from partial lines
			if (this.buffer.length > 1_000_000) {
				this.buffer = this.buffer.slice(-500_000);
			}
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
			this.containerName = null;
			return;
		}

		if (this.containerName) {
			// Container mode: use docker stop instead of SIGTERM
			stopContainer(this.containerName);
			// Wait for the process to exit after docker stop
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => resolve(), 5000);
				this.process?.on("exit", () => {
					clearTimeout(timeout);
					resolve();
				});
			});
		} else {
			// Direct mode: SIGTERM with fallback to SIGKILL
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
		}
		this.process = null;
		this.pendingRequests.clear();
		this.containerName = null;
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

		const id = randomUUID();
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

	/** Emit a message to the conversation stream (scrolling, persistent). */
	function emit(text: string): void {
		pi.sendMessage({ customType: "review-monitor", content: text, display: true });
	}

	/** Emit a warning message to the conversation stream. */
	function emitWarn(text: string): void {
		pi.sendMessage({ customType: "review-warning", content: `⚠ ${text}`, display: true });
	}

	// Data subdirectories are lazily resolved from --review-data-dir flag
	function getDataDir(): string {
		const dataDir = pi.getFlag("review-data-dir") as string | undefined;
		if (!dataDir) throw new Error("Missing required --review-data-dir flag");
		return dataDir;
	}

	const _dataDirs = new Map<string, string>();
	/** Resolve a subdirectory under --review-data-dir (cached, created on first access). */
	function getDataSubDir(name: string): string {
		let dir = _dataDirs.get(name);
		if (!dir) {
			dir = join(getDataDir(), name);
			ensureDir(dir);
			_dataDirs.set(name, dir);
		}
		return dir;
	}

	function getStateDir(): string {
		return getDataSubDir("state");
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
	pi.registerFlag("review-provider", {
		description: "AI provider for sub-agents (default: anthropic)",
		type: "string",
	});
	pi.registerFlag("review-model", {
		description: "Model ID for sub-agents",
		type: "string",
	});
	pi.registerFlag("review-auto-start", {
		description: "Automatically start review loop on session start",
		type: "boolean",
	});
	pi.registerFlag("review-skill-suffix", {
		description: "Suffix for skill directories (e.g., '-test' for e2e testing mode)",
		type: "string",
	});

	/** Cached provider config, resolved once at session start. */
	let _providerConfig: ProviderConfig | null = null;

	/** Resolve provider config from flags and environment (cached after first call). */
	function getProviderConfig(): ProviderConfig {
		if (!_providerConfig) {
			const provider = (pi.getFlag("review-provider") as string | undefined) ?? "anthropic";
			const model = pi.getFlag("review-model") as string | undefined;
			const apiKey = process.env.REVIEW_API_KEY;
			_providerConfig = { provider, model, apiKey };
		}
		return _providerConfig;
	}

	/** Build common sub-agent CLI args with provider/model flags. */
	function buildSubAgentArgs(skillName: string, config: ProviderConfig): string[] {
		const args = ["--skill", CONTAINER_PATHS.skill(skillName), "--no-extensions"];
		args.push("--provider", config.provider);
		if (config.model) {
			args.push("--model", config.model);
		}
		if (config.provider !== "anthropic" && config.apiKey) {
			args.push("--api-key", config.apiKey);
		}
		return args;
	}

	/** Returns repo+dataDir or shows errors and returns null. */
	function requireFlags(ctx: any): { repo: string; dataDir: string } | null {
		const repo = pi.getFlag("review-repo") as string | undefined;
		if (!repo) {
			ctx.ui.notify("Missing --review-repo flag", "error");
			return null;
		}
		const dataDir = pi.getFlag("review-data-dir") as string | undefined;
		if (!dataDir) {
			ctx.ui.notify("Missing --review-data-dir flag", "error");
			return null;
		}
		return { repo, dataDir };
	}

	// Register commands
	pi.registerCommand("review-start", {
		description: "Start the automated code review loop",
		handler: async (_args, ctx) => {
			const flags = requireFlags(ctx);
			if (!flags) return;
			startReviewLoop(flags.repo, ctx);
		},
	});

	pi.registerCommand("review-now", {
		description: "Trigger an immediate review cycle",
		handler: async (_args, ctx) => {
			const flags = requireFlags(ctx);
			if (!flags) return;
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
			const didRun = await runCycle(flags.repo, ctx);
			if (shouldIncrementDailyStats(didRun, prevFailures, consecutiveFailures)) {
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
			stopRequested = true;
			if (activeClient) {
				activeClient.abort().catch(() => {});
				ctx.ui.notify("Review loop stopped (aborting running sub-agent)", "info");
			} else {
				ctx.ui.notify("Review loop stopped", "info");
			}
		},
	});

	pi.registerCommand("review-status", {
		description: "Show review progress",
		handler: async (_args, ctx) => {
			const flags = requireFlags(ctx);
			if (!flags) return;
			const reviewed = readJson<ReviewedFiles>(statePath("reviewed-files.json"), {});
			const repoReviewed = reviewed[flags.repo] ?? {};
			const count = Object.keys(repoReviewed).length;
			const cache = readJson<Finding[]>(statePath("findings-cache.json"), []);
			const cycle = readJson<CycleState>(statePath("cycle.json"), { status: "idle" });
			const today = new Date().toISOString().slice(0, 10);
			const stats = readJson<DailyStats>(statePath("daily-stats.json"), { date: today, cycleCount: 0 });
			const todayCycles = stats.date === today ? stats.cycleCount : 0;
			ctx.ui.notify(
				`Repo: ${flags.repo} | Reviewed: ${count} files | Cached findings: ${cache.length} | Cycle: ${cycle.status} | Loop: ${loopActive ? "active" : "stopped"} | Today: ${todayCycles}/${LIMITS.maxCyclesPerDay} cycles | Failures: ${consecutiveFailures}`,
				"info",
			);
		},
	});

	pi.registerCommand("review-reset", {
		description: "Reset reviewed files list for current repo",
		handler: async (_args, ctx) => {
			const flags = requireFlags(ctx);
			if (!flags) return;
			const p = statePath("reviewed-files.json");
			assertStateWrite(p);
			const reviewed = readJson<ReviewedFiles>(p, {});
			delete reviewed[flags.repo];
			atomicWriteJson(p, reviewed);
			ctx.ui.notify(`Reset reviewed files for ${flags.repo}`, "info");
		},
	});

	// Credential proxy server instance (host-side)
	let proxyServer: Server | null = null;

	// Auto-start on session_start if required flags are provided (silent skip if missing)
	pi.on("session_start", async (_event, ctx) => {
		const repo = pi.getFlag("review-repo") as string | undefined;
		const dataDir = pi.getFlag("review-data-dir") as string | undefined;
		if (repo && dataDir) {
			const config = getProviderConfig();
			const useProxy = config.provider === "anthropic";
			try {
				// Initialize container infrastructure
				// ensureRuntimeRunning() is omitted — launch.sh already checked Docker,
				// and ensureImageBuilt() will fail with a clear error if Docker is down.
				cleanupOrphans();
				ensureImageBuilt(join(extensionDir, "container"));

				if (useProxy) {
					const proxyHost = detectProxyBindHost();
					proxyServer = await startCredentialProxy(CREDENTIAL_PROXY_PORT, proxyHost);
					// Register cleanup only after proxy is started
					// exit handler must be synchronous — use server.close() directly
					process.once("exit", () => {
						proxyServer?.close();
					});
					process.once("SIGTERM", () => {
						const server = proxyServer;
						proxyServer = null; // Prevent exit handler from double-closing
						if (server) {
							stopCredentialProxy(server).finally(() => process.exit(0));
						} else {
							process.exit(0);
						}
					});
				}

				const modeLabel = useProxy ? "container+proxy" : `container+direct (${config.provider})`;
				emit(`Code review agent ready for ${repo} (${modeLabel})`);
			} catch (err: any) {
				emitWarn(`Container setup failed: ${err.message}`);
				return;
			}

			if (pi.getFlag("review-auto-start")) {
				startReviewLoop(repo, ctx);
			} else {
				emit("Use /review-start to begin the review loop");
			}
		}
	});

	// ========================================================================
	// Loop Control
	// ========================================================================

	let loopActive = false;
	let loopTimer: ReturnType<typeof setTimeout> | null = null;
	let isRunning = false;
	let consecutiveFailures = 0;
	/** Currently running sub-agent client, if any. Set by round functions for stop/abort. */
	let activeClient: SubAgentClient | null = null;
	/** Set by review-stop to interrupt the current cycle between rounds. */
	let stopRequested = false;

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
		stopRequested = false;
		loopActive = true;
		consecutiveFailures = 0;

		const intervalHours = parseIntervalHours(pi.getFlag("review-interval") as string | undefined);
		const baseIntervalMs = intervalHours * 3600_000;

		const scheduleNext = () => {
			if (!loopActive) return;
			const actualInterval = calculateBackoffInterval(baseIntervalMs, consecutiveFailures);
			const hours = (actualInterval / 3600_000).toFixed(1);
			loopTimer = setTimeout(loop, actualInterval);
			emit(`Next review in ${hours} hour(s)`);
		};

		const loop = async () => {
			try {
				const today = new Date().toISOString().slice(0, 10);
				const stats = readJson<DailyStats>(statePath("daily-stats.json"), { date: today, cycleCount: 0 });
				const decision = decideLoopAction(loopActive, consecutiveFailures, stats, today, LIMITS);

				switch (decision.action) {
					case "stop-inactive":
						return;
					case "wait-blocked":
						emitWarn(decision.reason);
						if (loopActive) loopTimer = setTimeout(loop, decision.retryMs);
						return;
					case "run-cycle":
						break;
				}

				const prevFailures = consecutiveFailures;
				const didRun = await runCycle(repo, ctx);

				if (shouldIncrementDailyStats(didRun, prevFailures, consecutiveFailures)) {
					incrementDailyStatsLocal();
				}

				const postDecision = decidePostCycle(consecutiveFailures, LIMITS.maxConsecutiveFailures);
				if (postDecision.action === "stop-circuit-breaker") {
					emitWarn(`Circuit breaker: ${postDecision.failures} consecutive failures. Loop stopped. Use /review-start to resume.`);
					loopActive = false;
					return;
				}

				scheduleNext();
			} catch (err: any) {
				emitWarn(`Loop error: ${err.message}`);
				consecutiveFailures++;

				const postDecision = decidePostCycle(consecutiveFailures, LIMITS.maxConsecutiveFailures);
				if (postDecision.action === "stop-circuit-breaker") {
					loopActive = false;
					emitWarn("Circuit breaker triggered from loop error. Loop stopped.");
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
		if (!validateRepo(repo)) {
			throw new Error(`Invalid repo format: ${repo}. Expected: owner/repo`);
		}
		isRunning = true;
		stopRequested = false;

		try {
			ctx.ui.setStatus("code-review", undefined); // Clear previous status

			// Check for incomplete cycle from crash recovery
			const prevCycle = readJson<CycleState>(statePath("cycle.json"), { status: "idle" });
			const recovery = decideCycleRecovery(prevCycle);

			if (recovery.action === "resume-verify") {
				emit(`Recovering: resuming verification for ${recovery.file}`);
				await runVerifyRound(repo, ctx);
				finishCycle(repo, recovery.file);
				consecutiveFailures = 0;
				cleanupOldSessions(statePath("sessions.json"), LIMITS.sessionRetentionDays);
				trimReviewedFiles(statePath("reviewed-files.json"), repo, LIMITS.maxReviewedFilesPerRepo);
				return true;
			}

			if (recovery.action === "restart-review") {
				emit(`Recovering: restarting review for ${recovery.file}`);
			} else if (recovery.action === "skip-recovery") {
				emit(`Skipping recovery for ${recovery.reason}`);
				updateCycleState({ status: "idle" });
			}

			// Step 1: Select file
			const recoveryFile = recovery.action === "restart-review" ? recovery.file : undefined;
			const file = selectFile(repo, recoveryFile);
			if (!file) {
				// All files reviewed is not a failure — just skip this cycle without penalizing
				updateCycleState({ status: "idle" });
				return true;
			}

			emit(`────────────────────────────────────────\nReviewing: ${file}\n────────────────────────────────────────`);

			// Step 2: Review round
			updateCycleState({ status: "reviewing", file, repo, startedAt: new Date().toISOString() });
			await runReviewRound(repo, file, ctx);

			// Check if stop was requested between rounds
			if (stopRequested) {
				emit("[Cycle] Stop requested, skipping verify round");
				updateCycleState({ status: "idle" });
				return true;
			}

			// Step 3: Verify round (if there are findings in cache)
			const cache = readJson<Finding[]>(statePath("findings-cache.json"), []);
			if (cache.length > 0) {
				updateCycleState({ status: "verifying", file, repo, startedAt: new Date().toISOString() });
				await runVerifyRound(repo, ctx);
			} else {
				emit("No findings to verify");
			}

			// Step 4: Finish
			finishCycle(repo, file);
			consecutiveFailures = 0;

			// Housekeeping after successful cycle
			cleanupOldSessions(statePath("sessions.json"), LIMITS.sessionRetentionDays);
			trimReviewedFiles(statePath("reviewed-files.json"), repo, LIMITS.maxReviewedFilesPerRepo);
			return true;
		} catch (err: any) {
			consecutiveFailures++;
			emitWarn(`Review cycle error (failure ${consecutiveFailures}/${LIMITS.maxConsecutiveFailures}): ${err.message}`);
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
	// Sub-agent Helpers
	// ========================================================================

	/** Accumulated token usage and cost for a sub-agent run. */
	interface SubAgentStats {
		toolCalls: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	}

	/** Truncate a string to maxLen, appending "…" if truncated. */
	function truncate(s: string, maxLen: number): string {
		if (s.length <= maxLen) return s;
		return s.slice(0, maxLen) + "…";
	}

	/** Extract a human-readable summary of tool arguments. */
	function formatToolArgs(toolName: string, args: any): string {
		if (!args || typeof args !== "object") return "";
		switch (toolName) {
			case "read":
				return args.file_path ?? args.path ?? "";
			case "grep": {
				const pattern = args.pattern ? `"${args.pattern}"` : "";
				const path = args.path ?? "";
				return `${pattern} ${path}`.trim();
			}
			case "write":
				return args.file_path ?? args.path ?? "";
			case "bash":
				return truncate(String(args.command ?? ""), 120);
			case "glob":
				return args.pattern ?? "";
			default:
				return truncate(JSON.stringify(args), 120);
		}
	}

	/** Unwrap pi's tool result envelope: {content:[{type:"text",text:"..."}]} → text string. */
	function unwrapResult(result: any): string | null {
		if (result == null) return null;
		if (typeof result === "string") return result;
		// Pi wraps tool results as {content:[{type:"text",text:"..."}]}
		if (result.content && Array.isArray(result.content)) {
			const texts = result.content
				.filter((c: any) => c.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text);
			if (texts.length > 0) return texts.join("\n");
		}
		return JSON.stringify(result);
	}

	/** Extract a human-readable summary of a tool result. */
	function formatToolResult(toolName: string, result: any, isError: boolean): string {
		const text = unwrapResult(result);
		if (isError) return `ERROR: ${truncate(text ?? "", 150)}`;
		if (!text) return "(empty)";
		// For read results, show line count instead of dumping content
		if (toolName === "read") {
			const lines = text.split("\n");
			const preview = lines.slice(0, 2).join(" ").trim();
			return `${lines.length} lines` + (preview ? ` — ${truncate(preview, 100)}` : "");
		}
		return truncate(text, 200);
	}

	/** Format a finding's key details as display lines. */
	function formatFindingDetails(f: Finding): string[] {
		const lines: string[] = [];
		lines.push(`[${f.severity}/${f.category}] ${f.title} (${f.file}:${f.line}-${f.endLine})`);
		lines.push(`  ${f.description}`);
		if (f.codeSnippet) {
			lines.push(`  code: ${truncate(f.codeSnippet.replace(/\n/g, " "), 120)}`);
		}
		if (f.suggestion) {
			lines.push(`  fix: ${truncate(f.suggestion.replace(/\n/g, " "), 120)}`);
		}
		return lines;
	}

	/** Format stats summary as a single multi-line string. */
	function formatStatsSummary(stats: SubAgentStats, prefix: string): string {
		const lines = [
			`[${prefix}] Done`,
			`  tool calls:  ${stats.toolCalls}`,
			`  input:       ${stats.input} tokens`,
			`  output:      ${stats.output} tokens`,
			`  cache-read:  ${stats.cacheRead} tokens`,
			`  cache-write: ${stats.cacheWrite} tokens`,
		];
		if (stats.cost > 0) {
			lines.push(`  cost:        $${stats.cost.toFixed(4)}`);
		}
		return lines.join("\n");
	}

	/**
	 * Attach comprehensive monitoring to a sub-agent.
	 * Streams tool calls, arguments, results, and token usage to the host UI.
	 */
	function setupSubAgentMonitor(
		client: SubAgentClient,
		prefix: string,
	): { unsubscribe: () => void; getStats: () => SubAgentStats } {
		const stats: SubAgentStats = { toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

		// Unified turn buffer — all messages within a single turn are batched here
		// and emitted as one message block at message_end (or on abort/unsubscribe).
		const turnBuffer: string[] = [];
		let textBuffer = "";
		const TEXT_FLUSH_THRESHOLD = 500;

		// Repetition detection — separate window for text_delta + toolcall_delta
		const REP_CHECK_WINDOW = 200;
		const REP_CHECK_INTERVAL = 200;
		let repetitionWindow = "";
		let charsSinceRepCheck = 0;
		let aborted = false;

		function drainTextBuffer(): void {
			if (textBuffer.length > 0) {
				turnBuffer.push(`[${prefix}] ... ${truncate(textBuffer.trim(), 500)}`);
				textBuffer = "";
			}
		}

		function flushTurn(): void {
			drainTextBuffer();
			if (turnBuffer.length > 0) {
				emit(turnBuffer.join("\n"));
				turnBuffer.length = 0;
			}
		}

		const unsubscribe = client.onEvent((event: any) => {
			if (event.type === "tool_execution_start") {
				drainTextBuffer();
				stats.toolCalls++;
				const argSummary = formatToolArgs(event.toolName, event.args);
				let msg = `[${prefix}] → ${event.toolName} (${stats.toolCalls}/${LIMITS.maxToolCallsPerSubAgent})`;
				if (argSummary) msg += `\n  args: ${argSummary}`;
				turnBuffer.push(msg);
				if (stats.toolCalls >= LIMITS.maxToolCallsPerSubAgent) {
					flushTurn();
					emitWarn(`[${prefix}] Tool call limit reached, aborting sub-agent`);
					client.abort().catch(() => {});
				}
			}

			if (event.type === "tool_execution_end") {
				const resultSummary = formatToolResult(event.toolName, event.result, event.isError);
				turnBuffer.push(`[${prefix}] ← ${event.toolName}\n  result: ${resultSummary}`);
			}

			// Stream deltas and detect repetition (skip if already aborted)
			if (event.type === "message_update" && !aborted) {
				const sub = event.assistantMessageEvent;
				if (sub?.type === "text_delta") {
					textBuffer += sub.delta;
					repetitionWindow += sub.delta;
				} else if (sub?.type === "toolcall_delta") {
					repetitionWindow += sub.delta; // detection only, no display
				}

				if (sub?.type === "text_delta" || sub?.type === "toolcall_delta") {
					// Trim repetition window to check_window size
					if (repetitionWindow.length > REP_CHECK_WINDOW) {
						repetitionWindow = repetitionWindow.slice(-REP_CHECK_WINDOW);
					}

					// Drain text into turn buffer periodically to cap memory
					if (textBuffer.length >= TEXT_FLUSH_THRESHOLD) {
						drainTextBuffer();
					}

					// Check for repetition periodically
					charsSinceRepCheck += sub.delta.length;
					if (charsSinceRepCheck >= REP_CHECK_INTERVAL) {
						charsSinceRepCheck = 0;
						if (detectRepetition(repetitionWindow)) {
							flushTurn();
							emitWarn(`[${prefix}] Repetition detected in output, aborting sub-agent to save tokens`);
							aborted = true;
							repetitionWindow = "";
							charsSinceRepCheck = 0;
							client.abort().catch(() => {});
						}
					}
				}
			}

			// Accumulate token usage from assistant messages and emit the whole turn
			// Always processed (even after abort) to preserve stats
			if (event.type === "message_end" && event.message?.role === "assistant") {
				repetitionWindow = "";
				charsSinceRepCheck = 0;
				if (event.message.usage) {
					const u = event.message.usage;
					const turnIn = u.input ?? 0;
					const turnOut = u.output ?? 0;
					const turnCacheRead = u.cacheRead ?? 0;
					const turnCacheWrite = u.cacheWrite ?? 0;
					const turnCost = u.cost?.total ?? 0;
					stats.input += turnIn;
					stats.output += turnOut;
					stats.cacheRead += turnCacheRead;
					stats.cacheWrite += turnCacheWrite;
					stats.cost += turnCost;
					drainTextBuffer();
					let msg = `[${prefix}] :: turn tokens\n  input: ${turnIn}  output: ${turnOut}  cache-read: ${turnCacheRead}  cache-write: ${turnCacheWrite}`;
					if (turnCost > 0) msg += `\n  cost: $${turnCost.toFixed(4)}`;
					turnBuffer.push(msg);
				}
				flushTurn();
			}
		});

		return {
			unsubscribe: () => {
				flushTurn();
				unsubscribe();
			},
			getStats: () => stats,
		};
	}

	function getSessionsDir(): string {
		return getDataSubDir("sessions");
	}

	/** Create a container-isolated sub-agent for a given skill. */
	function createSubAgent(skillName: string): SubAgentClient {
		const suffix = (pi.getFlag("review-skill-suffix") as string | undefined) ?? "";
		const resolvedName = skillName + suffix;
		const config = getProviderConfig();
		const skillPath = join(skillsDir, resolvedName);
		return new SubAgentClient(piCliPath, {
			args: buildSubAgentArgs(resolvedName, config),
			containerMode: {
				repoDir,
				stateDir: getStateDir(),
				sessionsDir: getSessionsDir(),
				skillDirs: [skillPath],
				providerConfig: config,
			},
		});
	}

	/** Save a session reference for debugging. Best-effort — failures are silently ignored. */
	async function saveSessionRecord(client: SubAgentClient, type: "review" | "verify", file: string): Promise<void> {
		try {
			const state = await client.getState();
			const sp = statePath("sessions.json");
			assertStateWrite(sp);
			const sessions = readJson<SessionRecord[]>(sp, []);
			sessions.push({
				timestamp: new Date().toISOString(),
				type,
				file,
				sessionFile: state.sessionFile,
			});
			if (sessions.length > 100) sessions.splice(0, sessions.length - 100);
			atomicWriteJson(sp, sessions);
		} catch {
			// Session save is best-effort
		}
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

		const client = createSubAgent("review");
		activeClient = client;

		const monitor = setupSubAgentMonitor(client, "Review");

		try {
			await client.start();
			await client.promptAndWait(
				`You are reviewing code in the repository "${repo}".

Use the "review" skill to guide your review process. Read the skill file to get detailed instructions.

**Target file:** ${file}
**Findings output path:** ${CONTAINER_PATHS.stateFile("pending-findings.json")}

Review the file thoroughly and write your findings as a JSON array to the output path.`,
				LIMITS.reviewTimeoutMs,
			);

			await saveSessionRecord(client, "review", file);
		} finally {
			activeClient = null;
			monitor.unsubscribe();
			await client.stop();
		}

		emit(formatStatsSummary(monitor.getStats(), "Review"));

		// Merge new findings into cache (validate sub-agent output)
		const rawFindings = readJson<unknown[]>(statePath("pending-findings.json"), []);
		const newFindings = filterValidFindings(rawFindings);
		const discarded = rawFindings.length - newFindings.length;
		if (discarded > 0) {
			emitWarn(`[Review] Discarded ${discarded} malformed finding(s)`);
		}
		if (newFindings.length > 0) {
			const findingLines = newFindings.flatMap((f) =>
				formatFindingDetails(f).map((line) => `  ${line}`),
			);
			emit(`[Review] Found ${newFindings.length} issue(s) in ${file}:\n${findingLines.join("\n")}`);
			mergeFindingsCache(newFindings);
		} else {
			emit(`[Review] No issues found in ${file}`);
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

	/**
	 * Verify a single finding via sub-agent.
	 * Returns the verified finding if confirmed, or null if rejected.
	 */
	async function verifySingleFinding(repo: string, finding: Finding, label: string): Promise<Finding | null> {
		emit(`[${label}] Checking: ${finding.title}\n  file: ${finding.file}:${finding.line}-${finding.endLine}\n  severity: ${finding.severity}  category: ${finding.category}`);

		const verifyPath = statePath("verify-result.json");
		assertStateWrite(verifyPath);
		try {
			writeFileSync(verifyPath, "{}", "utf-8");
		} catch {
			// Ignore
		}

		const client = createSubAgent("verify");
		activeClient = client;

		const monitor = setupSubAgentMonitor(client, label);

		try {
			await client.start();
			await client.promptAndWait(
				`You are verifying a code review finding.

Use the "verify" skill to guide your verification process. Read the skill file to get detailed instructions.

**GitHub repo:** ${repo}
**Finding to verify:**
\`\`\`json
${JSON.stringify(finding)}
\`\`\`
**Result output path:** ${CONTAINER_PATHS.stateFile("verify-result.json")}

IMPORTANT: Do NOT run any gh commands. Only verify the finding against actual code and write your decision as JSON to the output path.`,
				LIMITS.verifyTimeoutMs,
			);

			await saveSessionRecord(client, "verify", finding.file);
		} finally {
			activeClient = null;
			monitor.unsubscribe();
			await client.stop();
		}

		emit(formatStatsSummary(monitor.getStats(), label));

		const result = readJson<VerifyResult>(statePath("verify-result.json"), { status: "rejected", reason: "No output", finding });

		if (result.status === "submitted") {
			const verifiedFinding = result.finding ?? finding;
			const details = formatFindingDetails(verifiedFinding).map((l) => `  ${l}`).join("\n");
			emit(`[${label}] CONFIRMED:\n${details}`);
			return verifiedFinding;
		}

		emit(`[${label}] REJECTED: ${result.reason ?? "unknown reason"}\n  was: [${finding.severity}/${finding.category}] ${finding.title} (${finding.file}:${finding.line})`);
		return null;
	}

	async function runVerifyRound(repo: string, ctx: any): Promise<void> {
		const cache = readJson<Finding[]>(statePath("findings-cache.json"), []);
		if (cache.length === 0) return;

		const finding = cache[0];
		emit("────────────────────────────────────────");

		// Verify primary finding
		const verified = await verifySingleFinding(repo, finding, "Verify");
		if (stopRequested) return; // Bail if stop was requested during verify

		// Collect all findings to remove from cache (verified or not, the primary is always removed)
		const removedKeys = new Set([findingKey(finding)]);

		if (verified) {
			const allVerified: Finding[] = [verified];

			// Find and verify related findings (same file + category)
			const related = findRelatedFindings(cache, finding);
			if (related.length > 0) {
				emit(`[Verify] Found ${related.length} related finding(s), verifying each...`);
			}
			for (const relatedFinding of related) {
				if (stopRequested) break;
				try {
					const relatedVerified = await verifySingleFinding(repo, relatedFinding, "Verify+");
					removedKeys.add(findingKey(relatedFinding));
					if (relatedVerified) {
						allVerified.push(relatedVerified);
					}
				} catch (err: any) {
					emitWarn(`[Verify+] Failed to verify related finding: ${err.message}`);
					removedKeys.add(findingKey(relatedFinding));
				}
			}

			// Create issue with all verified findings (skip if stop was requested)
			if (allVerified.length > 0 && !stopRequested) {
				const isDuplicate = checkDuplicateIssue(repo, allVerified[0]);
				if (!isDuplicate) {
					const issueUrl = createGitHubIssue(repo, allVerified);
					if (issueUrl) {
						emit(`[Verify] Issue created (${allVerified.length} verified finding(s)): ${issueUrl}`);
					} else {
						emitWarn("[Verify] Findings verified but issue creation failed");
					}
				} else {
					emit("[Verify] Duplicate found, skipping issue creation");
				}
			}
		}

		// Remove all processed findings from cache
		const cp = statePath("findings-cache.json");
		assertStateWrite(cp);
		const remainingCache = cache.filter((f) => !removedKeys.has(findingKey(f)));
		atomicWriteJson(cp, remainingCache);
	}

	// ========================================================================
	// Housekeeping (delegated to utils)
	// ========================================================================
}
