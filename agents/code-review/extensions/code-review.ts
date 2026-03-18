import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Types
// ============================================================================

interface Finding {
	file: string;
	line: number;
	endLine: number;
	severity: "critical" | "high" | "medium";
	category: "security" | "bug" | "performance" | "design" | "maintainability";
	title: string;
	description: string;
	codeSnippet: string;
	suggestion: string;
}

interface CycleState {
	status: "idle" | "cloning" | "reviewing" | "verifying";
	file?: string;
	repo?: string;
	startedAt?: string;
}

interface ReviewedFiles {
	[repo: string]: { [file: string]: string };
}

interface VerifyResult {
	status: "submitted" | "rejected";
	issueUrl?: string;
	reason?: string;
	finding: Finding;
}

interface SessionRecord {
	timestamp: string;
	type: "review" | "verify";
	file: string;
	sessionFile?: string;
}

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
		await this.prompt(message);
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
// State Management
// ============================================================================

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath: string, data: unknown): void {
	ensureDir(dirname(filePath));
	const tmp = filePath + ".tmp";
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
	renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

// ============================================================================
// Main Extension
// ============================================================================

export default function codeReviewExtension(pi: ExtensionAPI): void {
	// Resolve paths relative to this extension file
	const currentFile = fileURLToPath(import.meta.url);
	const extensionDir = dirname(dirname(currentFile));
	const stateDir = join(extensionDir, "state");
	const workspaceDir = join(extensionDir, "workspace");
	const skillsDir = join(extensionDir, "skills");

	const cycleStatePath = join(stateDir, "cycle.json");
	const reviewedFilesPath = join(stateDir, "reviewed-files.json");
	const findingsCachePath = join(stateDir, "findings-cache.json");
	const sessionsPath = join(stateDir, "sessions.json");
	const findingsOutputPath = join(stateDir, "pending-findings.json");
	const verifyOutputPath = join(stateDir, "verify-result.json");

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
			await runCycle(repo, ctx);
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
			const reviewed = readJson<ReviewedFiles>(reviewedFilesPath, {});
			const repoReviewed = reviewed[repo] ?? {};
			const count = Object.keys(repoReviewed).length;
			const cache = readJson<Finding[]>(findingsCachePath, []);
			const cycle = readJson<CycleState>(cycleStatePath, { status: "idle" });
			ctx.ui.notify(
				`Repo: ${repo} | Reviewed: ${count} files | Cached findings: ${cache.length} | Cycle: ${cycle.status} | Loop: ${loopActive ? "active" : "stopped"}`,
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
			const reviewed = readJson<ReviewedFiles>(reviewedFilesPath, {});
			delete reviewed[repo];
			atomicWriteJson(reviewedFilesPath, reviewed);
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

	function startReviewLoop(repo: string, ctx: any): void {
		if (loopActive) return;
		loopActive = true;

		const intervalHours = parseFloat((pi.getFlag("review-interval") as string) ?? "1") || 1;
		const intervalMs = intervalHours * 3600_000;

		const loop = async () => {
			if (!loopActive) return;
			await runCycle(repo, ctx);
			if (loopActive) {
				loopTimer = setTimeout(loop, intervalMs);
				ctx.ui.notify(`Next review in ${intervalHours} hour(s)`, "info");
			}
		};

		// Start first cycle immediately
		loop();
	}

	// ========================================================================
	// Review Cycle
	// ========================================================================

	async function runCycle(repo: string, ctx: any): Promise<void> {
		if (isRunning) return;
		isRunning = true;

		try {
			ctx.ui.setStatus("code-review", undefined); // Clear previous status

			// Check for incomplete cycle from crash recovery
			const prevCycle = readJson<CycleState>(cycleStatePath, { status: "idle" });

			if (prevCycle.status === "verifying" && prevCycle.file) {
				// Resume from verification
				ctx.ui.notify(`Recovering: resuming verification for ${prevCycle.file}`, "info");
				await runVerifyRound(repo, ctx);
				finishCycle(repo, prevCycle.file);
				return;
			}

			if (prevCycle.status !== "idle" && prevCycle.file) {
				// Other incomplete states: restart the file
				ctx.ui.notify(`Recovering: restarting review for ${prevCycle.file}`, "info");
			}

			// Step 1: Clone or pull
			updateCycleState({ status: "cloning", repo, startedAt: new Date().toISOString() });
			const repoDir = await ensureRepo(repo, ctx);
			if (!repoDir) {
				updateCycleState({ status: "idle" });
				return;
			}

			// Step 2: Select file
			const file = await selectFile(repo, repoDir, prevCycle.status !== "idle" ? prevCycle.file : undefined);
			if (!file) {
				ctx.ui.notify("No files available for review (all reviewed). Use /review-reset to start over.", "info");
				updateCycleState({ status: "idle" });
				return;
			}

			ctx.ui.notify(`Reviewing: ${file}`, "info");

			// Step 3: Review round
			updateCycleState({ status: "reviewing", file, repo, startedAt: new Date().toISOString() });
			await runReviewRound(repo, repoDir, file, ctx);

			// Step 4: Verify round (if there are findings in cache)
			const cache = readJson<Finding[]>(findingsCachePath, []);
			if (cache.length > 0) {
				updateCycleState({ status: "verifying", file, repo, startedAt: new Date().toISOString() });
				await runVerifyRound(repo, ctx);
			} else {
				ctx.ui.notify("No findings to verify", "info");
			}

			// Step 5: Finish
			finishCycle(repo, file);
		} catch (err: any) {
			ctx.ui.notify(`Review cycle error: ${err.message}`, "error");
		} finally {
			isRunning = false;
		}
	}

	function finishCycle(repo: string, file: string): void {
		// Mark file as reviewed
		const reviewed = readJson<ReviewedFiles>(reviewedFilesPath, {});
		if (!reviewed[repo]) reviewed[repo] = {};
		reviewed[repo][file] = new Date().toISOString();
		atomicWriteJson(reviewedFilesPath, reviewed);

		updateCycleState({ status: "idle" });
	}

	function updateCycleState(state: CycleState): void {
		atomicWriteJson(cycleStatePath, state);
	}

	// ========================================================================
	// Repository Management
	// ========================================================================

	function ensureRepo(repo: string, ctx: any): string | null {
		ensureDir(workspaceDir);
		const repoName = repo.replace("/", "_");
		const repoDir = join(workspaceDir, repoName);

		try {
			if (existsSync(join(repoDir, ".git"))) {
				// Verify and pull
				try {
					execSync("git status", { cwd: repoDir, stdio: "pipe" });
					execSync("git pull --ff-only", { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
					ctx.ui.notify(`Repository updated: ${repo}`, "info");
				} catch {
					// Broken repo, re-clone
					ctx.ui.notify(`Repository broken, re-cloning: ${repo}`, "warning");
					execSync(`rm -rf "${repoDir}"`, { stdio: "pipe" });
					execSync(`gh repo clone ${repo} "${repoDir}"`, { stdio: "pipe", timeout: 300_000 });
				}
			} else {
				// Fresh clone
				ctx.ui.notify(`Cloning repository: ${repo}`, "info");
				execSync(`gh repo clone ${repo} "${repoDir}"`, { stdio: "pipe", timeout: 300_000 });
			}
			return repoDir;
		} catch (err: any) {
			ctx.ui.notify(`Failed to clone/update repo: ${err.message}`, "error");
			return null;
		}
	}

	// ========================================================================
	// File Selection
	// ========================================================================

	function selectFile(repo: string, repoDir: string, forceFile?: string): string | undefined {
		if (forceFile) return forceFile;

		// Get all tracked files
		const output = execSync("git ls-files", { cwd: repoDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
		const allFiles = output
			.split("\n")
			.filter(Boolean)
			.filter((f) => isCodeFile(f));

		if (allFiles.length === 0) return undefined;

		// Filter out already reviewed files
		const reviewed = readJson<ReviewedFiles>(reviewedFilesPath, {});
		const repoReviewed = reviewed[repo] ?? {};
		let candidates = allFiles.filter((f) => !repoReviewed[f]);

		// If all files reviewed, reset to the oldest reviewed ones
		if (candidates.length === 0) {
			const sorted = Object.entries(repoReviewed).sort(
				([, a], [, b]) => new Date(a).getTime() - new Date(b).getTime(),
			);
			// Reset oldest half
			const resetCount = Math.max(1, Math.floor(sorted.length / 2));
			for (let i = 0; i < resetCount; i++) {
				delete repoReviewed[sorted[i][0]];
			}
			atomicWriteJson(reviewedFilesPath, reviewed);
			candidates = allFiles.filter((f) => !repoReviewed[f]);
		}

		// Random selection
		return candidates[Math.floor(Math.random() * candidates.length)];
	}

	function isCodeFile(file: string): boolean {
		const codeExtensions = new Set([
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs",
			".py",
			".go",
			".rs",
			".java",
			".kt",
			".scala",
			".c",
			".cpp",
			".h",
			".hpp",
			".cs",
			".rb",
			".php",
			".swift",
			".m",
			".mm",
			".vue",
			".svelte",
			".astro",
			".sh",
			".bash",
			".zsh",
			".sql",
			".graphql",
			".gql",
			".proto",
			".yaml",
			".yml",
			".toml",
			".zig",
			".lua",
			".ex",
			".exs",
			".erl",
			".hrl",
			".clj",
			".cljs",
			".elm",
			".hs",
			".ml",
			".mli",
			".r",
			".R",
			".dart",
			".nim",
			".v",
			".sol",
		]);

		const ext = "." + file.split(".").pop();
		if (!codeExtensions.has(ext)) return false;

		// Exclude common non-reviewable paths
		const excludePatterns = [
			"node_modules/",
			"vendor/",
			"dist/",
			"build/",
			".min.",
			"package-lock.json",
			"yarn.lock",
			"pnpm-lock.yaml",
			"__snapshots__/",
			".generated.",
			"/generated/",
		];
		return !excludePatterns.some((p) => file.includes(p));
	}

	// ========================================================================
	// Round 1: Review
	// ========================================================================

	async function runReviewRound(repo: string, repoDir: string, file: string, ctx: any): Promise<void> {
		// Clean previous output
		try {
			writeFileSync(findingsOutputPath, "[]", "utf-8");
		} catch {
			// Ignore
		}

		const reviewSkillPath = join(skillsDir, "review");

		const client = new SubAgentClient(piCliPath, {
			cwd: repoDir,
			args: ["--skill", reviewSkillPath, "--no-extensions"],
		});

		const unsubscribe = client.onEvent((event: any) => {
			if (event.type === "tool_execution_start") {
				ctx.ui.notify(`[Review] Tool: ${event.toolName}`, "info");
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
**Findings output path:** ${findingsOutputPath}

Review the file thoroughly and write your findings as a JSON array to the output path.`,
				600_000,
			);

			// Save session reference
			try {
				const state = await client.getState();
				const sessions = readJson<SessionRecord[]>(sessionsPath, []);
				sessions.push({
					timestamp: new Date().toISOString(),
					type: "review",
					file,
					sessionFile: state.sessionFile,
				});
				// Keep last 100 session records
				if (sessions.length > 100) sessions.splice(0, sessions.length - 100);
				atomicWriteJson(sessionsPath, sessions);
			} catch {
				// Session save is best-effort
			}
		} finally {
			unsubscribe();
			await client.stop();
		}

		// Merge new findings into cache
		const newFindings = readJson<Finding[]>(findingsOutputPath, []);
		if (newFindings.length > 0) {
			ctx.ui.notify(`[Review] Found ${newFindings.length} issue(s) in ${file}`, "info");
			mergeFindingsCache(newFindings);
		} else {
			ctx.ui.notify(`[Review] No issues found in ${file}`, "info");
		}
	}

	function mergeFindingsCache(newFindings: Finding[]): void {
		const cache = readJson<Finding[]>(findingsCachePath, []);

		// Add new findings
		cache.push(...newFindings);

		// Sort by severity (critical > high > medium)
		const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2 };
		cache.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

		// Keep top 10
		const trimmed = cache.slice(0, 10);
		atomicWriteJson(findingsCachePath, trimmed);
	}

	// ========================================================================
	// Round 2: Verify
	// ========================================================================

	async function runVerifyRound(repo: string, ctx: any): Promise<void> {
		const cache = readJson<Finding[]>(findingsCachePath, []);
		if (cache.length === 0) return;

		// Take the top finding
		const finding = cache[0];
		ctx.ui.notify(`[Verify] Checking: ${finding.title} (${finding.file}:${finding.line})`, "info");

		// Clean previous output
		try {
			writeFileSync(verifyOutputPath, "{}", "utf-8");
		} catch {
			// Ignore
		}

		const repoName = repo.replace("/", "_");
		const repoDir = join(workspaceDir, repoName);
		const verifySkillPath = join(skillsDir, "verify");

		const client = new SubAgentClient(piCliPath, {
			cwd: repoDir,
			args: ["--skill", verifySkillPath, "--no-extensions"],
		});

		const unsubscribe = client.onEvent((event: any) => {
			if (event.type === "tool_execution_start") {
				ctx.ui.notify(`[Verify] Tool: ${event.toolName}`, "info");
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
**Result output path:** ${verifyOutputPath}

Verify this finding by re-reading the actual code, check for duplicates, and submit via gh issue create if valid. Write the result to the output path.`,
				600_000,
			);

			// Save session reference
			try {
				const state = await client.getState();
				const sessions = readJson<SessionRecord[]>(sessionsPath, []);
				sessions.push({
					timestamp: new Date().toISOString(),
					type: "verify",
					file: finding.file,
					sessionFile: state.sessionFile,
				});
				if (sessions.length > 100) sessions.splice(0, sessions.length - 100);
				atomicWriteJson(sessionsPath, sessions);
			} catch {
				// Session save is best-effort
			}
		} finally {
			unsubscribe();
			await client.stop();
		}

		// Process result
		const result = readJson<VerifyResult>(verifyOutputPath, { status: "rejected", reason: "No output", finding });

		if (result.status === "submitted") {
			ctx.ui.notify(`[Verify] Issue submitted: ${result.issueUrl ?? "unknown URL"}`, "info");
		} else {
			ctx.ui.notify(`[Verify] Finding rejected: ${result.reason ?? "unknown reason"}`, "info");
		}

		// Remove processed finding from cache (always remove, whether submitted or rejected)
		cache.shift();
		atomicWriteJson(findingsCachePath, cache);
	}
}
