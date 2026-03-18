import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
	status: "idle" | "cloning" | "reviewing" | "verifying";
	file?: string;
	repo?: string;
	startedAt?: string;
}

export interface ReviewedFiles {
	[repo: string]: { [file: string]: string };
}

export interface VerifyResult {
	status: "submitted" | "rejected";
	issueUrl?: string;
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

export function cleanupOldSessions(sessionsPath: string, retentionDays: number): number {
	try {
		const sessions = readJson<SessionRecord[]>(sessionsPath, []);
		const cutoff = Date.now() - retentionDays * 86400_000;
		const kept: SessionRecord[] = [];
		let deletedCount = 0;

		for (const record of sessions) {
			if (new Date(record.timestamp).getTime() < cutoff) {
				if (record.sessionFile) {
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
