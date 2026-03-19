import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ============================================================================
// Repetition Detection
// ============================================================================

/**
 * Detect consecutive repeating patterns at the tail of text.
 * Ported from VoiceText's repetition.py — prevents LLM output loops.
 *
 * Shorter patterns require more repeats (scaled so total repeated length >= minRepeatedChars).
 * E.g., a 1-char pattern needs 20 repeats; a 5-char pattern needs 4 repeats.
 */
export function detectRepetition(
	text: string,
	checkWindow = 200,
	minRepeatedChars = 20,
	minRepeats = 4,
): boolean {
	if (text.length < minRepeatedChars) return false;
	const tail = text.length > checkWindow ? text.slice(-checkWindow) : text;
	const maxPatLen = Math.floor(tail.length / minRepeats);
	for (let patLen = 1; patLen <= maxPatLen; patLen++) {
		const needed = Math.max(minRepeats, Math.floor(minRepeatedChars / patLen));
		if (patLen * needed > tail.length) continue;

		const pattern = tail.slice(-patLen);
		if (pattern.trim().length === 0) continue;

		let matched = true;
		for (let i = 1; i < needed; i++) {
			const start = tail.length - patLen * (i + 1);
			if (start < 0 || tail.slice(start, start + patLen) !== pattern) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
	}
	return false;
}

// ============================================================================
// Types
// ============================================================================

export interface Finding {
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

export interface CycleState {
	status: "idle" | "reviewing" | "verifying";
	file?: string;
	repo?: string;
	startedAt?: string;
}

export interface ReviewedFiles {
	[repo: string]: { [file: string]: string };
}

export interface VerifyResult {
	status: "submitted" | "rejected";
	reason?: string;
	finding: Finding;
}

export interface SessionRecord {
	timestamp: string;
	type: "review" | "verify";
	file: string;
	sessionFile?: string;
}

export interface DailyStats {
	date: string;
	cycleCount: number;
}

// ============================================================================
// State Management
// ============================================================================

export function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function atomicWriteJson(filePath: string, data: unknown): void {
	ensureDir(dirname(filePath));
	const tmp = filePath + ".tmp";
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
	renameSync(tmp, filePath);
}

export function readJson<T>(filePath: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

// ============================================================================
// Path Safety
// ============================================================================

/** Throws if targetPath is not inside one of the allowedRoots after resolution. */
export function assertPathAllowed(targetPath: string, allowedRoots: string[]): void {
	const resolved = resolve(targetPath);
	const allowed = allowedRoots.some((root) => {
		const normalizedRoot = resolve(root);
		return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + "/");
	});
	if (!allowed) {
		throw new Error(`Path "${resolved}" is outside allowed roots: ${allowedRoots.join(", ")}`);
	}
}

// ============================================================================
// Validation
// ============================================================================

export function validateRepo(repo: string): boolean {
	return /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo);
}

export function isCodeFile(file: string): boolean {
	const codeExtensions = new Set([
		".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
		".py", ".go", ".rs", ".java", ".kt", ".scala",
		".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php",
		".swift", ".m", ".mm", ".vue", ".svelte", ".astro",
		".sh", ".bash", ".zsh", ".sql", ".graphql", ".gql",
		".proto", ".yaml", ".yml", ".toml", ".zig", ".lua",
		".ex", ".exs", ".erl", ".hrl", ".clj", ".cljs",
		".elm", ".hs", ".ml", ".mli", ".r", ".R",
		".dart", ".nim", ".v", ".sol",
	]);

	const ext = "." + file.split(".").pop();
	if (!codeExtensions.has(ext)) return false;

	const excludePatterns = [
		"node_modules/", "vendor/", "dist/", "build/",
		".min.", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
		"__snapshots__/", ".generated.", "/generated/",
	];
	return !excludePatterns.some((p) => file.includes(p));
}

const VALID_SEVERITIES = new Set(["critical", "high", "medium"]);
const VALID_CATEGORIES = new Set(["security", "bug", "performance", "design", "maintainability"]);

/** Returns true if the value has all required Finding fields with correct types. */
export function isValidFinding(value: unknown): value is Finding {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.file === "string" && v.file.length > 0 &&
		typeof v.line === "number" && Number.isFinite(v.line) &&
		typeof v.endLine === "number" && Number.isFinite(v.endLine) &&
		typeof v.severity === "string" && VALID_SEVERITIES.has(v.severity) &&
		typeof v.category === "string" && VALID_CATEGORIES.has(v.category) &&
		typeof v.title === "string" && v.title.length > 0 &&
		typeof v.description === "string" &&
		typeof v.codeSnippet === "string" &&
		typeof v.suggestion === "string"
	);
}

/** Filters an array of unknown values, returning only valid Findings. */
export function filterValidFindings(raw: unknown[]): Finding[] {
	return raw.filter(isValidFinding);
}

/** Parse interval string to hours, clamped to [0.1, 24]. Returns defaultVal on invalid input. */
export function parseIntervalHours(input: string | undefined, defaultVal: number = 1): number {
	if (input == null) return defaultVal;
	const parsed = parseFloat(input);
	if (!Number.isFinite(parsed) || parsed <= 0) return defaultVal;
	return Math.min(Math.max(parsed, 0.1), 24);
}

// ============================================================================
// Safety Gates & Daily Stats
// ============================================================================

export interface SafetyLimits {
	maxConsecutiveFailures: number;
	maxCyclesPerDay: number;
}

/** Returns an error message if the cycle should be blocked, null if OK. */
export function checkSafetyGates(
	consecutiveFailures: number,
	dailyStats: DailyStats,
	today: string,
	limits: SafetyLimits,
): string | null {
	if (consecutiveFailures >= limits.maxConsecutiveFailures) {
		return `Circuit breaker active: ${consecutiveFailures} consecutive failures. Use /review-start to reset.`;
	}
	const cycleCount = dailyStats.date === today ? dailyStats.cycleCount : 0;
	if (cycleCount >= limits.maxCyclesPerDay) {
		return `Daily cycle limit reached (${cycleCount}/${limits.maxCyclesPerDay}).`;
	}
	return null;
}

/** Returns updated daily stats with the cycle count incremented, handling day rollover. */
export function incrementDailyStats(stats: DailyStats, today: string): DailyStats {
	if (stats.date !== today) {
		return { date: today, cycleCount: 1 };
	}
	return { date: stats.date, cycleCount: stats.cycleCount + 1 };
}

// ============================================================================
// File Selection
// ============================================================================

export interface FileSelectionResult {
	file: string | undefined;
	updatedReviewed: Record<string, string>;
}

/**
 * Select the next file to review from allFiles, skipping already-reviewed ones.
 * When all files are reviewed, resets the oldest half and picks from the rest.
 */
export function selectNextFile(
	allFiles: string[],
	repoReviewed: Record<string, string>,
): FileSelectionResult {
	if (allFiles.length === 0) {
		return { file: undefined, updatedReviewed: { ...repoReviewed } };
	}

	let reviewed = { ...repoReviewed };
	let candidates = allFiles.filter((f) => !reviewed[f]);

	if (candidates.length === 0) {
		// Reset oldest half
		const sorted = Object.entries(reviewed).sort(
			([, a], [, b]) => new Date(a).getTime() - new Date(b).getTime(),
		);
		const resetCount = Math.max(1, Math.floor(sorted.length / 2));
		reviewed = { ...reviewed };
		for (let i = 0; i < resetCount; i++) {
			delete reviewed[sorted[i][0]];
		}
		candidates = allFiles.filter((f) => !reviewed[f]);
	}

	const file = candidates[Math.floor(Math.random() * candidates.length)];
	return { file, updatedReviewed: reviewed };
}

// ============================================================================
// Findings Cache
// ============================================================================

export function mergeFindingsIntoCache(
	cachePath: string,
	newFindings: Finding[],
	maxSize: number = 10,
): Finding[] {
	const cache = readJson<Finding[]>(cachePath, []);
	cache.push(...newFindings);

	const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2 };
	cache.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

	const trimmed = cache.slice(0, maxSize);
	atomicWriteJson(cachePath, trimmed);
	return trimmed;
}

// ============================================================================
// Housekeeping
// ============================================================================

export function cleanupOldSessions(sessionsPath: string, retentionDays: number, allowedDeleteRoots?: string[]): number {
	try {
		const sessions = readJson<SessionRecord[]>(sessionsPath, []);
		const cutoff = Date.now() - retentionDays * 86400_000;
		const kept: SessionRecord[] = [];
		let deletedCount = 0;

		for (const record of sessions) {
			if (new Date(record.timestamp).getTime() < cutoff) {
				if (record.sessionFile) {
					if (allowedDeleteRoots) {
						try {
							assertPathAllowed(record.sessionFile, allowedDeleteRoots);
						} catch {
							// Path outside allowed roots — skip deletion, still remove record
							deletedCount++;
							continue;
						}
					}
					try {
						unlinkSync(record.sessionFile);
					} catch {
						// File may already be deleted
					}
				}
				deletedCount++;
			} else {
				kept.push(record);
			}
		}

		if (kept.length !== sessions.length) {
			atomicWriteJson(sessionsPath, kept);
		}
		return deletedCount;
	} catch {
		return 0;
	}
}

export function trimReviewedFiles(
	reviewedFilesPath: string,
	repo: string,
	maxPerRepo: number,
): number {
	try {
		const reviewed = readJson<ReviewedFiles>(reviewedFilesPath, {});
		const repoReviewed = reviewed[repo];
		if (!repoReviewed) return 0;

		const entries = Object.entries(repoReviewed);
		if (entries.length <= maxPerRepo) return 0;

		// Sort by date, keep newest half
		entries.sort(([, a], [, b]) => new Date(b).getTime() - new Date(a).getTime());
		const keepCount = Math.floor(maxPerRepo / 2);
		const removedCount = entries.length - keepCount;
		reviewed[repo] = Object.fromEntries(entries.slice(0, keepCount));
		atomicWriteJson(reviewedFilesPath, reviewed);
		return removedCount;
	} catch {
		return 0;
	}
}

// ============================================================================
// GitHub Issue Operations (host-side, used by orchestrator)
// ============================================================================

/** Build the standardized issue title for a finding (or group of findings). */
export function buildIssueTitle(findings: Finding | Finding[]): string {
	const arr = Array.isArray(findings) ? findings : [findings];
	const primary = arr[0];
	if (arr.length === 1) {
		return `[ai-review] ${primary.category}: ${primary.title} (${primary.file}:${primary.line})`;
	}
	return `[ai-review] ${primary.category}: ${primary.title} (+${arr.length - 1} related) (${primary.file})`;
}

/** Format a single finding as a markdown section. */
function formatFindingBody(finding: Finding, index?: number, verified?: boolean): string {
	const verifiedLabel = verified === true ? " ✅ verified" : verified === false ? " (related, unverified)" : "";
	const header = index != null ? `## Finding ${index + 1}${verifiedLabel}` : "## Issue";
	return `${header}

**File:** \`${finding.file}\`
**Line:** ${finding.line}-${finding.endLine}
**Severity:** ${finding.severity}
**Category:** ${finding.category}

### Description

${finding.description}

### Code

\`\`\`
${finding.codeSnippet}
\`\`\`

### Suggested Fix

${finding.suggestion}`;
}

/**
 * Check if a duplicate issue already exists for a finding.
 * Runs `gh issue list` on the host machine.
 */
export function checkDuplicateIssue(repo: string, finding: Finding): boolean {
	if (!validateRepo(repo)) return false;

	try {
		const output = execFileSync(
			"gh",
			["issue", "list", "-R", repo, "-l", "ai-code-review", "--state", "all", "--limit", "50", "--json", "title"],
			{ encoding: "utf-8", timeout: 30_000 },
		);
		const issues = JSON.parse(output) as Array<{ title: string }>;

		const expectedTitle = buildIssueTitle(finding);
		return issues.some(
			(issue) => issue.title === expectedTitle || (
				issue.title.includes(finding.file) &&
				issue.title.includes(finding.title)
			),
		);
	} catch {
		// If gh fails, assume no duplicate (will create the issue)
		return false;
	}
}

const labelEnsuredForRepo = new Set<string>();

/**
 * Create a GitHub issue for one or more related findings.
 * Runs `gh issue create` on the host machine.
 * Returns the issue URL, or undefined on failure.
 */
export function createGitHubIssue(repo: string, findings: Finding | Finding[]): string | undefined {
	if (!validateRepo(repo)) return undefined;
	const arr = Array.isArray(findings) ? findings : [findings];
	if (arr.length === 0) return undefined;

	const title = buildIssueTitle(arr);
	const sections = arr.length === 1
		? formatFindingBody(arr[0])
		: arr.map((f, i) => formatFindingBody(f, i, i === 0)).join("\n\n---\n\n");
	const body = `${sections}

---
*This issue was automatically generated by AI code review.*`;

	if (!labelEnsuredForRepo.has(repo)) {
		try {
			execFileSync("gh", ["label", "create", "ai-code-review", "--description", "Automated AI code review findings", "--color", "d4c5f9", "-R", repo], {
				stdio: "pipe",
				timeout: 15_000,
			});
		} catch {
			// Label may already exist
		}
		labelEnsuredForRepo.add(repo);
	}

	try {
		const output = execFileSync(
			"gh",
			["issue", "create", "-R", repo, "--title", title, "--label", "ai-code-review", "--body", body],
			{ encoding: "utf-8", timeout: 30_000 },
		);
		return output.trim();
	} catch {
		return undefined;
	}
}

/** Structural identity key for a finding. */
export function findingKey(f: Finding): string {
	return `${f.file}:${f.line}:${f.title}`;
}

/** Find findings in a cache that are related to the given finding (same file + category). */
export function findRelatedFindings(cache: Finding[], finding: Finding): Finding[] {
	const key = findingKey(finding);
	return cache.filter(
		(f) => findingKey(f) !== key && f.file === finding.file && f.category === finding.category,
	);
}
