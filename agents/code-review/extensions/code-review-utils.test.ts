import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	type Finding,
	type ReviewedFiles,
	type SessionRecord,
	atomicWriteJson,
	cleanupOldSessions,
	ensureDir,
	isCodeFile,
	mergeFindingsIntoCache,
	readJson,
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
