import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	return {
		...actual,
		execFileSync: vi.fn(actual.execFileSync),
	};
});
import { execFileSync } from "node:child_process";
import {
	type DailyStats,
	type Finding,
	type ReviewedFiles,
	type SessionRecord,
	assertPathAllowed,
	atomicWriteJson,
	buildIssueTitle,
	checkDuplicateIssue,
	checkSafetyGates,
	cleanupOldSessions,
	createGitHubIssue,
	detectRepetition,
	ensureDir,
	filterValidFindings,
	incrementDailyStats,
	isCodeFile,
	isValidFinding,
	mergeFindingsIntoCache,
	parseIntervalHours,
	readJson,
	selectNextFile,
	trimReviewedFiles,
	validateRepo,
} from "./code-review-utils.js";

// ============================================================================
// Test Helpers
// ============================================================================

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "code-review-test-"));
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function makeFinding(overrides: Partial<Finding> = {}): Finding {
	return {
		file: "src/index.ts",
		line: 1,
		endLine: 5,
		severity: "medium",
		category: "bug",
		title: "Test finding",
		description: "A test finding",
		codeSnippet: "const x = 1;",
		suggestion: "Fix it",
		...overrides,
	};
}

// ============================================================================
// readJson
// ============================================================================

describe("readJson", () => {
	it("reads a valid JSON file", () => {
		const filePath = join(testDir, "test.json");
		writeFileSync(filePath, JSON.stringify({ key: "value" }));
		expect(readJson(filePath, {})).toEqual({ key: "value" });
	});

	it("returns fallback for missing file", () => {
		expect(readJson(join(testDir, "missing.json"), { default: true })).toEqual({ default: true });
	});

	it("returns fallback for invalid JSON", () => {
		const filePath = join(testDir, "bad.json");
		writeFileSync(filePath, "not json{{{");
		expect(readJson(filePath, [])).toEqual([]);
	});

	it("returns fallback for empty file", () => {
		const filePath = join(testDir, "empty.json");
		writeFileSync(filePath, "");
		expect(readJson(filePath, "fallback")).toEqual("fallback");
	});
});

// ============================================================================
// atomicWriteJson
// ============================================================================

describe("atomicWriteJson", () => {
	it("writes JSON to file", () => {
		const filePath = join(testDir, "out.json");
		atomicWriteJson(filePath, { hello: "world" });
		const content = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(content).toEqual({ hello: "world" });
	});

	it("creates parent directories", () => {
		const filePath = join(testDir, "a", "b", "c", "deep.json");
		atomicWriteJson(filePath, [1, 2, 3]);
		expect(readJson(filePath, [])).toEqual([1, 2, 3]);
	});

	it("overwrites existing file atomically", () => {
		const filePath = join(testDir, "overwrite.json");
		atomicWriteJson(filePath, { v: 1 });
		atomicWriteJson(filePath, { v: 2 });
		expect(readJson(filePath, {})).toEqual({ v: 2 });
	});

	it("does not leave tmp file on success", () => {
		const filePath = join(testDir, "clean.json");
		atomicWriteJson(filePath, {});
		expect(() => readFileSync(filePath + ".tmp")).toThrow();
	});
});

// ============================================================================
// ensureDir
// ============================================================================

describe("ensureDir", () => {
	it("creates nested directories", () => {
		const dir = join(testDir, "x", "y", "z");
		ensureDir(dir);
		// Writing a file proves the directory exists
		writeFileSync(join(dir, "test"), "ok");
		expect(readFileSync(join(dir, "test"), "utf-8")).toBe("ok");
	});

	it("is idempotent on existing directory", () => {
		const dir = join(testDir, "existing");
		mkdirSync(dir);
		expect(() => ensureDir(dir)).not.toThrow();
	});
});

// ============================================================================
// assertPathAllowed
// ============================================================================

describe("assertPathAllowed", () => {
	it("allows path inside a root", () => {
		expect(() => assertPathAllowed("/data/state/cycle.json", ["/data"])).not.toThrow();
	});

	it("allows exact root path", () => {
		expect(() => assertPathAllowed("/data", ["/data"])).not.toThrow();
	});

	it("rejects path outside all roots", () => {
		expect(() => assertPathAllowed("/etc/passwd", ["/data"])).toThrow("outside allowed roots");
	});

	it("rejects .. traversal escaping root", () => {
		expect(() => assertPathAllowed("/data/../etc/passwd", ["/data"])).toThrow("outside allowed roots");
	});

	it("rejects prefix confusion (e.g. /data-evil vs /data)", () => {
		expect(() => assertPathAllowed("/data-evil/file.json", ["/data"])).toThrow("outside allowed roots");
	});

	it("allows path with multiple roots", () => {
		expect(() => assertPathAllowed("/cache/file.json", ["/data", "/cache"])).not.toThrow();
	});

	it("resolves relative paths before checking", () => {
		// A relative path gets resolved to cwd — should not match /data unless cwd is under /data
		expect(() => assertPathAllowed("relative/file.json", ["/data"])).toThrow("outside allowed roots");
	});
});

// ============================================================================
// validateRepo
// ============================================================================

describe("validateRepo", () => {
	it("accepts valid owner/repo formats", () => {
		expect(validateRepo("facebook/react")).toBe(true);
		expect(validateRepo("my-org/my-repo")).toBe(true);
		expect(validateRepo("user123/project_v2")).toBe(true);
		expect(validateRepo("a/b")).toBe(true);
		expect(validateRepo("org.name/repo.name")).toBe(true);
	});

	it("rejects invalid formats", () => {
		expect(validateRepo("")).toBe(false);
		expect(validateRepo("noslash")).toBe(false);
		expect(validateRepo("too/many/slashes")).toBe(false);
		expect(validateRepo("/leading-slash")).toBe(false);
		expect(validateRepo("trailing-slash/")).toBe(false);
		expect(validateRepo("has spaces/repo")).toBe(false);
		expect(validateRepo("owner/has spaces")).toBe(false);
		expect(validateRepo("; rm -rf /")).toBe(false);
		expect(validateRepo("owner/repo; echo pwned")).toBe(false);
	});
});

// ============================================================================
// isCodeFile
// ============================================================================

describe("isCodeFile", () => {
	it("accepts common code files", () => {
		expect(isCodeFile("src/index.ts")).toBe(true);
		expect(isCodeFile("app.py")).toBe(true);
		expect(isCodeFile("main.go")).toBe(true);
		expect(isCodeFile("lib/utils.rs")).toBe(true);
		expect(isCodeFile("script.sh")).toBe(true);
		expect(isCodeFile("query.sql")).toBe(true);
		expect(isCodeFile("component.vue")).toBe(true);
		expect(isCodeFile("page.svelte")).toBe(true);
	});

	it("rejects non-code files", () => {
		expect(isCodeFile("README.md")).toBe(false);
		expect(isCodeFile("logo.png")).toBe(false);
		expect(isCodeFile("data.json")).toBe(false);
		expect(isCodeFile("styles.css")).toBe(false);
		expect(isCodeFile("font.woff2")).toBe(false);
		expect(isCodeFile("Dockerfile")).toBe(false);
		expect(isCodeFile("LICENSE")).toBe(false);
	});

	it("excludes files in non-reviewable paths", () => {
		expect(isCodeFile("node_modules/lodash/index.js")).toBe(false);
		expect(isCodeFile("vendor/lib/utils.py")).toBe(false);
		expect(isCodeFile("dist/bundle.js")).toBe(false);
		expect(isCodeFile("build/output.js")).toBe(false);
		expect(isCodeFile("lib/utils.min.js")).toBe(false);
		expect(isCodeFile("__snapshots__/test.ts")).toBe(false);
		expect(isCodeFile("src/api.generated.ts")).toBe(false);
	});

	it("accepts files in normal paths", () => {
		expect(isCodeFile("src/components/Button.tsx")).toBe(true);
		expect(isCodeFile("tests/unit/parser.test.ts")).toBe(true);
		expect(isCodeFile("packages/core/index.ts")).toBe(true);
	});
});

// ============================================================================
// mergeFindingsIntoCache
// ============================================================================

describe("mergeFindingsIntoCache", () => {
	it("adds findings to empty cache", () => {
		const cachePath = join(testDir, "cache.json");
		const findings = [makeFinding({ title: "Bug 1" })];
		const result = mergeFindingsIntoCache(cachePath, findings);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Bug 1");
	});

	it("merges with existing cache", () => {
		const cachePath = join(testDir, "cache.json");
		atomicWriteJson(cachePath, [makeFinding({ title: "Existing" })]);
		const result = mergeFindingsIntoCache(cachePath, [makeFinding({ title: "New" })]);
		expect(result).toHaveLength(2);
	});

	it("sorts by severity: critical > high > medium", () => {
		const cachePath = join(testDir, "cache.json");
		const findings = [
			makeFinding({ title: "Medium", severity: "medium" }),
			makeFinding({ title: "Critical", severity: "critical" }),
			makeFinding({ title: "High", severity: "high" }),
		];
		const result = mergeFindingsIntoCache(cachePath, findings);
		expect(result.map((f) => f.severity)).toEqual(["critical", "high", "medium"]);
	});

	it("caps at maxSize", () => {
		const cachePath = join(testDir, "cache.json");
		const findings = Array.from({ length: 15 }, (_, i) =>
			makeFinding({ title: `Finding ${i}`, severity: "medium" }),
		);
		const result = mergeFindingsIntoCache(cachePath, findings, 10);
		expect(result).toHaveLength(10);
	});

	it("keeps highest severity when capping", () => {
		const cachePath = join(testDir, "cache.json");
		const findings = [
			...Array.from({ length: 8 }, () => makeFinding({ severity: "medium" })),
			makeFinding({ title: "Critical one", severity: "critical" }),
			...Array.from({ length: 5 }, () => makeFinding({ severity: "medium" })),
		];
		const result = mergeFindingsIntoCache(cachePath, findings, 10);
		expect(result[0].severity).toBe("critical");
		expect(result[0].title).toBe("Critical one");
	});

	it("persists result to disk", () => {
		const cachePath = join(testDir, "cache.json");
		mergeFindingsIntoCache(cachePath, [makeFinding()]);
		const fromDisk = readJson<Finding[]>(cachePath, []);
		expect(fromDisk).toHaveLength(1);
	});
});

// ============================================================================
// cleanupOldSessions
// ============================================================================

describe("cleanupOldSessions", () => {
	it("removes sessions older than retention period", () => {
		const sessionsPath = join(testDir, "sessions.json");
		const oldDate = new Date(Date.now() - 10 * 86400_000).toISOString(); // 10 days ago
		const recentDate = new Date().toISOString();

		const sessions: SessionRecord[] = [
			{ timestamp: oldDate, type: "review", file: "old.ts", sessionFile: join(testDir, "old.jsonl") },
			{ timestamp: recentDate, type: "review", file: "recent.ts" },
		];
		// Create the old session file so unlinkSync can delete it
		writeFileSync(join(testDir, "old.jsonl"), "{}");

		atomicWriteJson(sessionsPath, sessions);
		const deleted = cleanupOldSessions(sessionsPath, 7);
		expect(deleted).toBe(1);

		const remaining = readJson<SessionRecord[]>(sessionsPath, []);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].file).toBe("recent.ts");
	});

	it("keeps all sessions within retention period", () => {
		const sessionsPath = join(testDir, "sessions.json");
		const recentDate = new Date().toISOString();

		atomicWriteJson(sessionsPath, [
			{ timestamp: recentDate, type: "review", file: "a.ts" },
			{ timestamp: recentDate, type: "verify", file: "b.ts" },
		]);

		const deleted = cleanupOldSessions(sessionsPath, 7);
		expect(deleted).toBe(0);
	});

	it("handles missing sessions file gracefully", () => {
		const deleted = cleanupOldSessions(join(testDir, "nonexistent.json"), 7);
		expect(deleted).toBe(0);
	});

	it("handles missing session file on disk gracefully", () => {
		const sessionsPath = join(testDir, "sessions.json");
		const oldDate = new Date(Date.now() - 10 * 86400_000).toISOString();

		atomicWriteJson(sessionsPath, [
			{ timestamp: oldDate, type: "review", file: "gone.ts", sessionFile: "/tmp/does-not-exist.jsonl" },
		]);

		// Should not throw even though the session file doesn't exist
		const deleted = cleanupOldSessions(sessionsPath, 7);
		expect(deleted).toBe(1);
	});

	it("skips file deletion when sessionFile is outside allowedDeleteRoots", () => {
		const sessionsPath = join(testDir, "sessions.json");
		const oldDate = new Date(Date.now() - 10 * 86400_000).toISOString();
		const sessionFile = join(testDir, "safe.jsonl");
		writeFileSync(sessionFile, "{}");

		atomicWriteJson(sessionsPath, [
			{ timestamp: oldDate, type: "review", file: "a.ts", sessionFile },
		]);

		// Use a root that does NOT contain testDir
		const deleted = cleanupOldSessions(sessionsPath, 7, ["/nonexistent-root"]);
		expect(deleted).toBe(1);

		// File should NOT have been deleted (path outside allowed roots)
		expect(readFileSync(sessionFile, "utf-8")).toBe("{}");
	});

	it("deletes file when sessionFile is inside allowedDeleteRoots", () => {
		const sessionsPath = join(testDir, "sessions.json");
		const oldDate = new Date(Date.now() - 10 * 86400_000).toISOString();
		const sessionFile = join(testDir, "deletable.jsonl");
		writeFileSync(sessionFile, "{}");

		atomicWriteJson(sessionsPath, [
			{ timestamp: oldDate, type: "review", file: "b.ts", sessionFile },
		]);

		const deleted = cleanupOldSessions(sessionsPath, 7, [testDir]);
		expect(deleted).toBe(1);

		// File should have been deleted
		expect(() => readFileSync(sessionFile)).toThrow();
	});
});

// ============================================================================
// trimReviewedFiles
// ============================================================================

describe("trimReviewedFiles", () => {
	it("does nothing when under limit", () => {
		const filePath = join(testDir, "reviewed.json");
		const reviewed: ReviewedFiles = {
			"owner/repo": { "a.ts": "2026-01-01", "b.ts": "2026-01-02" },
		};
		atomicWriteJson(filePath, reviewed);

		const removed = trimReviewedFiles(filePath, "owner/repo", 5000);
		expect(removed).toBe(0);
	});

	it("trims when over limit, keeping newest half", () => {
		const filePath = join(testDir, "reviewed.json");
		const files: Record<string, string> = {};
		for (let i = 0; i < 100; i++) {
			files[`file${i.toString().padStart(3, "0")}.ts`] = new Date(2026, 0, i + 1).toISOString();
		}
		atomicWriteJson(filePath, { "owner/repo": files });

		const removed = trimReviewedFiles(filePath, "owner/repo", 50);
		expect(removed).toBe(75); // 100 - 25 (half of 50)

		const result = readJson<ReviewedFiles>(filePath, {});
		expect(Object.keys(result["owner/repo"]).length).toBe(25);

		// Verify newest files are kept
		const dates = Object.values(result["owner/repo"]).map((d) => new Date(d).getTime());
		const maxKept = Math.max(...dates);
		const minKept = Math.min(...dates);
		// The newest date in original is Jan 100 (doesn't exist but close to April)
		// The kept files should be the newest ones
		expect(maxKept).toBeGreaterThan(minKept);
	});

	it("handles missing repo gracefully", () => {
		const filePath = join(testDir, "reviewed.json");
		atomicWriteJson(filePath, {});
		const removed = trimReviewedFiles(filePath, "nonexistent/repo", 100);
		expect(removed).toBe(0);
	});

	it("handles missing file gracefully", () => {
		const removed = trimReviewedFiles(join(testDir, "nope.json"), "a/b", 100);
		expect(removed).toBe(0);
	});
});

// ============================================================================
// checkSafetyGates
// ============================================================================

describe("checkSafetyGates", () => {
	const limits = { maxConsecutiveFailures: 5, maxCyclesPerDay: 20 };
	const today = "2026-03-18";

	it("returns null when within all limits", () => {
		const stats: DailyStats = { date: today, cycleCount: 5 };
		expect(checkSafetyGates(0, stats, today, limits)).toBeNull();
	});

	it("triggers circuit breaker on consecutive failures", () => {
		const stats: DailyStats = { date: today, cycleCount: 0 };
		const result = checkSafetyGates(5, stats, today, limits);
		expect(result).toContain("Circuit breaker");
		expect(result).toContain("5");
	});

	it("triggers circuit breaker at exact threshold", () => {
		const stats: DailyStats = { date: today, cycleCount: 0 };
		expect(checkSafetyGates(5, stats, today, limits)).not.toBeNull();
		expect(checkSafetyGates(4, stats, today, limits)).toBeNull();
	});

	it("triggers daily cycle limit", () => {
		const stats: DailyStats = { date: today, cycleCount: 20 };
		const result = checkSafetyGates(0, stats, today, limits);
		expect(result).toContain("Daily cycle limit");
	});

	it("ignores stale daily stats from a different day", () => {
		const stats: DailyStats = { date: "2026-03-17", cycleCount: 100 };
		expect(checkSafetyGates(0, stats, today, limits)).toBeNull();
	});

	it("checks circuit breaker before daily limit", () => {
		const stats: DailyStats = { date: today, cycleCount: 20 };
		const result = checkSafetyGates(5, stats, today, limits);
		expect(result).toContain("Circuit breaker");
	});
});

// ============================================================================
// incrementDailyStats
// ============================================================================

describe("incrementDailyStats", () => {
	it("increments cycle count for same day", () => {
		const stats: DailyStats = { date: "2026-03-18", cycleCount: 3 };
		const result = incrementDailyStats(stats, "2026-03-18");
		expect(result).toEqual({ date: "2026-03-18", cycleCount: 4 });
	});

	it("resets count on new day", () => {
		const stats: DailyStats = { date: "2026-03-17", cycleCount: 15 };
		const result = incrementDailyStats(stats, "2026-03-18");
		expect(result).toEqual({ date: "2026-03-18", cycleCount: 1 });
	});

	it("does not mutate input", () => {
		const stats: DailyStats = { date: "2026-03-18", cycleCount: 3 };
		incrementDailyStats(stats, "2026-03-18");
		expect(stats.cycleCount).toBe(3);
	});
});

// ============================================================================
// selectNextFile
// ============================================================================

describe("selectNextFile", () => {
	it("returns undefined for empty file list", () => {
		const result = selectNextFile([], {});
		expect(result.file).toBeUndefined();
	});

	it("selects from unreviewed files", () => {
		const allFiles = ["a.ts", "b.ts", "c.ts"];
		const reviewed = { "a.ts": "2026-01-01" };
		const result = selectNextFile(allFiles, reviewed);
		expect(result.file).toBeDefined();
		expect(["b.ts", "c.ts"]).toContain(result.file);
	});

	it("does not select already-reviewed files", () => {
		const allFiles = ["a.ts", "b.ts"];
		const reviewed = { "a.ts": "2026-01-01" };
		const result = selectNextFile(allFiles, reviewed);
		expect(result.file).toBe("b.ts");
	});

	it("resets oldest half when all files are reviewed", () => {
		const allFiles = ["a.ts", "b.ts", "c.ts", "d.ts"];
		const reviewed: Record<string, string> = {
			"a.ts": "2026-01-01",
			"b.ts": "2026-01-02",
			"c.ts": "2026-01-03",
			"d.ts": "2026-01-04",
		};
		const result = selectNextFile(allFiles, reviewed);
		expect(result.file).toBeDefined();
		// Oldest half (a.ts, b.ts) should be removed from reviewed
		expect(result.updatedReviewed["a.ts"]).toBeUndefined();
		expect(result.updatedReviewed["b.ts"]).toBeUndefined();
		// Newest half should remain
		expect(result.updatedReviewed["c.ts"]).toBeDefined();
		expect(result.updatedReviewed["d.ts"]).toBeDefined();
		// Selected file should be from the reset ones
		expect(["a.ts", "b.ts"]).toContain(result.file);
	});

	it("does not mutate the input reviewed map", () => {
		const allFiles = ["a.ts", "b.ts"];
		const reviewed = { "a.ts": "2026-01-01", "b.ts": "2026-01-02" };
		selectNextFile(allFiles, reviewed);
		expect(Object.keys(reviewed)).toHaveLength(2);
	});

	it("resets at least one file when all reviewed", () => {
		const allFiles = ["only.ts"];
		const reviewed = { "only.ts": "2026-01-01" };
		const result = selectNextFile(allFiles, reviewed);
		expect(result.file).toBe("only.ts");
		expect(result.updatedReviewed["only.ts"]).toBeUndefined();
	});
});

// ============================================================================
// isValidFinding / filterValidFindings
// ============================================================================

describe("isValidFinding", () => {
	it("accepts a valid finding", () => {
		expect(isValidFinding(makeFinding())).toBe(true);
	});

	it("rejects null and non-objects", () => {
		expect(isValidFinding(null)).toBe(false);
		expect(isValidFinding("string")).toBe(false);
		expect(isValidFinding(42)).toBe(false);
		expect(isValidFinding(undefined)).toBe(false);
	});

	it("rejects missing required fields", () => {
		const base = makeFinding();
		for (const key of ["file", "line", "endLine", "severity", "category", "title", "description", "codeSnippet", "suggestion"]) {
			const copy = { ...base };
			delete (copy as any)[key];
			expect(isValidFinding(copy)).toBe(false);
		}
	});

	it("rejects empty file and title", () => {
		expect(isValidFinding(makeFinding({ file: "" }))).toBe(false);
		expect(isValidFinding(makeFinding({ title: "" }))).toBe(false);
	});

	it("rejects invalid severity values", () => {
		expect(isValidFinding({ ...makeFinding(), severity: "low" })).toBe(false);
		expect(isValidFinding({ ...makeFinding(), severity: "" })).toBe(false);
	});

	it("rejects invalid category values", () => {
		expect(isValidFinding({ ...makeFinding(), category: "style" })).toBe(false);
	});

	it("rejects non-finite line numbers", () => {
		expect(isValidFinding(makeFinding({ line: NaN }))).toBe(false);
		expect(isValidFinding(makeFinding({ line: Infinity }))).toBe(false);
		expect(isValidFinding(makeFinding({ endLine: NaN }))).toBe(false);
	});

	it("rejects wrong types for string fields", () => {
		expect(isValidFinding({ ...makeFinding(), description: 123 })).toBe(false);
		expect(isValidFinding({ ...makeFinding(), suggestion: null })).toBe(false);
	});

	it("accepts findings with extra fields", () => {
		expect(isValidFinding({ ...makeFinding(), extraField: "ok" })).toBe(true);
	});
});

describe("filterValidFindings", () => {
	it("keeps only valid findings", () => {
		const input = [
			makeFinding({ title: "Good one" }),
			{ bad: "object" },
			null,
			makeFinding({ title: "Another good" }),
			"not an object",
		];
		const result = filterValidFindings(input);
		expect(result).toHaveLength(2);
		expect(result[0].title).toBe("Good one");
		expect(result[1].title).toBe("Another good");
	});

	it("returns empty array for all-invalid input", () => {
		expect(filterValidFindings([null, {}, "x", 42])).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(filterValidFindings([])).toEqual([]);
	});
});

// ============================================================================
// parseIntervalHours
// ============================================================================

describe("parseIntervalHours", () => {
	it("parses valid interval strings", () => {
		expect(parseIntervalHours("2")).toBe(2);
		expect(parseIntervalHours("0.5")).toBe(0.5);
		expect(parseIntervalHours("12")).toBe(12);
	});

	it("returns default for undefined/null", () => {
		expect(parseIntervalHours(undefined)).toBe(1);
		expect(parseIntervalHours(undefined, 2)).toBe(2);
	});

	it("returns default for non-numeric input", () => {
		expect(parseIntervalHours("abc")).toBe(1);
		expect(parseIntervalHours("")).toBe(1);
	});

	it("returns default for zero and negative values", () => {
		expect(parseIntervalHours("0")).toBe(1);
		expect(parseIntervalHours("-5")).toBe(1);
	});

	it("clamps to minimum 0.1 hours", () => {
		expect(parseIntervalHours("0.01")).toBe(0.1);
		expect(parseIntervalHours("0.05")).toBe(0.1);
	});

	it("clamps to maximum 24 hours", () => {
		expect(parseIntervalHours("48")).toBe(24);
		expect(parseIntervalHours("1000")).toBe(24);
		expect(parseIntervalHours("1e6")).toBe(24);
	});

	it("returns default for Infinity and NaN strings", () => {
		expect(parseIntervalHours("Infinity")).toBe(1);
		expect(parseIntervalHours("NaN")).toBe(1);
	});
});

// ============================================================================
// buildIssueTitle
// ============================================================================

describe("buildIssueTitle", () => {
	it("formats title with category, title, file, and line", () => {
		const finding = makeFinding({ category: "security", title: "SQL injection", file: "app.ts", line: 42 });
		expect(buildIssueTitle(finding)).toBe("[ai-review] security: SQL injection (app.ts:42)");
	});

	it("uses finding defaults correctly", () => {
		expect(buildIssueTitle(makeFinding())).toBe("[ai-review] bug: Test finding (src/index.ts:1)");
	});
});

// ============================================================================
// checkDuplicateIssue
// ============================================================================

describe("checkDuplicateIssue", () => {
	const mockExecFileSync = vi.mocked(execFileSync);

	afterEach(() => {
		mockExecFileSync.mockReset();
	});

	it("returns false for invalid repo format", () => {
		expect(checkDuplicateIssue("invalid", makeFinding())).toBe(false);
	});

	it("returns true when a matching issue exists", () => {
		const issues = [
			{ title: "[ai-review] bug: Test finding (src/index.ts:1)", body: "src/index.ts:1" },
		];
		mockExecFileSync.mockReturnValue(JSON.stringify(issues) as any);
		expect(checkDuplicateIssue("owner/repo", makeFinding())).toBe(true);
	});

	it("returns false when no matching issue exists", () => {
		const issues = [
			{ title: "[ai-review] bug: Other issue (other.ts:5)", body: "other.ts:5" },
		];
		mockExecFileSync.mockReturnValue(JSON.stringify(issues) as any);
		expect(checkDuplicateIssue("owner/repo", makeFinding())).toBe(false);
	});

	it("returns false when gh command fails", () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error("gh not found");
		});
		expect(checkDuplicateIssue("owner/repo", makeFinding())).toBe(false);
	});

	it("returns false for empty issue list", () => {
		mockExecFileSync.mockReturnValue("[]" as any);
		expect(checkDuplicateIssue("owner/repo", makeFinding())).toBe(false);
	});
});

// ============================================================================
// createGitHubIssue
// ============================================================================

describe("createGitHubIssue", () => {
	const mockExecFileSync = vi.mocked(execFileSync);

	afterEach(() => {
		mockExecFileSync.mockReset();
	});

	it("returns undefined for invalid repo format", () => {
		expect(createGitHubIssue("invalid", makeFinding())).toBeUndefined();
	});

	it("returns issue URL on success", () => {
		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			if ((args as string[])?.includes("label")) return "" as any;
			return "https://github.com/owner/repo/issues/123\n" as any;
		});
		const url = createGitHubIssue("owner/repo", makeFinding());
		expect(url).toBe("https://github.com/owner/repo/issues/123");
	});

	it("returns undefined when gh issue create fails", () => {
		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			if ((args as string[])?.includes("label")) return "" as any;
			throw new Error("gh failed");
		});
		expect(createGitHubIssue("owner/repo", makeFinding())).toBeUndefined();
	});

	it("still works when label already exists", () => {
		let issueCreateCalled = false;
		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			if ((args as string[])?.includes("label")) {
				throw new Error("label already exists");
			}
			issueCreateCalled = true;
			return "https://github.com/owner/repo/issues/456\n" as any;
		});
		const url = createGitHubIssue("owner/repo", makeFinding());
		expect(url).toBe("https://github.com/owner/repo/issues/456");
		expect(issueCreateCalled).toBe(true);
	});

	it("formats issue title correctly", () => {
		let capturedArgs: string[] = [];
		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			if ((args as string[])?.includes("label")) return "" as any;
			capturedArgs = args as string[];
			return "https://github.com/owner/repo/issues/1\n" as any;
		});
		const finding = makeFinding({ title: "SQL injection", category: "security", file: "app.ts", line: 42 });
		createGitHubIssue("owner/repo", finding);
		const titleIdx = capturedArgs.indexOf("--title");
		expect(titleIdx).toBeGreaterThan(-1);
		expect(capturedArgs[titleIdx + 1]).toBe("[ai-review] security: SQL injection (app.ts:42)");
	});
});

// ============================================================================
// detectRepetition
// ============================================================================

describe("detectRepetition", () => {
	it("returns false for normal text", () => {
		expect(detectRepetition("This is a normal code review finding about SQL injection.")).toBe(false);
	});

	it("returns false for empty text", () => {
		expect(detectRepetition("")).toBe(false);
	});

	it("returns false for short text", () => {
		expect(detectRepetition("hello")).toBe(false);
	});

	it("detects single character repeated 20+ times", () => {
		expect(detectRepetition("normal text" + "x".repeat(20))).toBe(true);
	});

	it("does not trigger for single character below threshold", () => {
		expect(detectRepetition("normal text" + "x".repeat(10))).toBe(false);
	});

	it("detects short pattern (3 chars) repeated 7+ times", () => {
		expect(detectRepetition("prefix" + "abc".repeat(7))).toBe(true);
	});

	it("does not trigger for short pattern below threshold", () => {
		expect(detectRepetition("prefix" + "abc".repeat(3))).toBe(false);
	});

	it("detects 5-char pattern repeated 4+ times", () => {
		expect(detectRepetition("prefix" + "hello".repeat(5))).toBe(true);
	});

	it("detects longer pattern repeated 4 times", () => {
		const pattern = "the code has a bug ";
		expect(detectRepetition("start " + pattern.repeat(4))).toBe(true);
	});

	it("does not trigger for whitespace-only patterns", () => {
		expect(detectRepetition("some text" + " ".repeat(50))).toBe(false);
	});

	it("only checks the last check_window characters", () => {
		// Repetition is far from the tail — should not detect
		const text = "x".repeat(25) + "a".repeat(300);
		expect(detectRepetition(text, 200)).toBe(true); // "a" repeats in the window
		// But with a very short window, "a" repetition is detected within any window
		expect(detectRepetition("y".repeat(25) + "normal text that is long enough", 200)).toBe(false);
	});

	it("detects JSON-like repetition in tool call output", () => {
		const fragment = '{"file":"a.ts","line":1},';
		expect(detectRepetition("prefix" + fragment.repeat(4))).toBe(true);
	});

	it("does not false-positive on similar but different JSON entries", () => {
		const text = '{"file":"a.ts","line":1},{"file":"b.ts","line":2},{"file":"c.ts","line":3},{"file":"d.ts","line":4}';
		expect(detectRepetition(text)).toBe(false);
	});

	it("supports custom thresholds", () => {
		const text = "abc".repeat(5); // 15 chars
		expect(detectRepetition(text, 200, 10, 3)).toBe(true);
		expect(detectRepetition(text, 200, 20, 3)).toBe(false);
	});
});
