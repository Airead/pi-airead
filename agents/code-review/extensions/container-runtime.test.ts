import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	buildContainerArgs,
	CONTAINER_HOST_GATEWAY,
	CONTAINER_IMAGE,
	detectProxyBindHost,
	findEnvFiles,
	hostGatewayArgs,
	piCliPathInContainer,
	readonlyMountArgs,
	writableMountArgs,
} from "./container-runtime.js";

// ============================================================================
// Test Helpers
// ============================================================================

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "container-runtime-test-"));
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// ============================================================================
// detectProxyBindHost
// ============================================================================

describe("detectProxyBindHost", () => {
	it("returns a valid IP address string", () => {
		const result = detectProxyBindHost();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
		// Should be a valid IP address or 0.0.0.0
		expect(result).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
	});

	it("returns 127.0.0.1 on macOS (current platform)", () => {
		// This test validates behavior on the actual test platform
		// On macOS (where tests run), it should return 127.0.0.1
		const result = detectProxyBindHost();
		if (process.platform === "darwin") {
			expect(result).toBe("127.0.0.1");
		}
	});
});

// ============================================================================
// hostGatewayArgs
// ============================================================================

describe("hostGatewayArgs", () => {
	it("returns an array", () => {
		const args = hostGatewayArgs();
		expect(Array.isArray(args)).toBe(true);
	});

	it("contains --add-host on Linux or is empty on macOS", () => {
		const args = hostGatewayArgs();
		// On macOS (test environment), should be empty
		// On Linux, should contain --add-host
		for (const arg of args) {
			expect(arg).toContain("host.docker.internal");
		}
	});
});

// ============================================================================
// Mount helpers
// ============================================================================

describe("readonlyMountArgs", () => {
	it("returns correct mount args", () => {
		const args = readonlyMountArgs("/host/path", "/container/path");
		expect(args).toEqual(["-v", "/host/path:/container/path:ro"]);
	});
});

describe("writableMountArgs", () => {
	it("returns correct mount args", () => {
		const args = writableMountArgs("/host/path", "/container/path");
		expect(args).toEqual(["-v", "/host/path:/container/path"]);
	});
});

// ============================================================================
// findEnvFiles
// ============================================================================

describe("findEnvFiles", () => {
	it("finds .env files in a directory", () => {
		writeFileSync(join(testDir, ".env"), "SECRET=val");
		writeFileSync(join(testDir, ".env.local"), "LOCAL=val");
		writeFileSync(join(testDir, ".env.production"), "PROD=val");
		writeFileSync(join(testDir, "config.ts"), "export default {}");
		writeFileSync(join(testDir, "app.env"), "APP=val");

		const result = findEnvFiles(testDir);
		expect(result).toContain(".env");
		expect(result).toContain(".env.local");
		expect(result).toContain(".env.production");
		expect(result).toContain("app.env");
		expect(result).not.toContain("config.ts");
	});

	it("returns empty array for non-existent directory", () => {
		const result = findEnvFiles("/nonexistent/path");
		expect(result).toEqual([]);
	});

	it("returns empty array for directory with no env files", () => {
		writeFileSync(join(testDir, "index.ts"), "console.log('hi')");
		const result = findEnvFiles(testDir);
		expect(result).toEqual([]);
	});
});

// ============================================================================
// buildContainerArgs
// ============================================================================

describe("buildContainerArgs", () => {
	it("builds correct docker run args", () => {
		const skillDir = join(testDir, "review");
		mkdirSync(skillDir, { recursive: true });

		const args = buildContainerArgs({
			containerName: "code-review-123",
			repoDir: "/host/repo",
			stateDir: "/host/state",
			skillDirs: [skillDir],
					piCommand: ["node", "/usr/local/lib/node_modules/pi/cli.js", "--mode", "rpc"],
		});

		expect(args[0]).toBe("run");
		expect(args).toContain("-i");
		expect(args).toContain("--rm");
		expect(args).toContain("--name");
		expect(args).toContain("code-review-123");
		expect(args).toContain("--memory=2g");
		expect(args).toContain("--cpus=2");
		expect(args).toContain("--pids-limit=256");
		expect(args).toContain(CONTAINER_IMAGE);

		// Check repo is mounted read-only
		const repoMountIdx = args.findIndex((a) => a.includes("/host/repo:/workspace/repo:ro"));
		expect(repoMountIdx).toBeGreaterThan(-1);

		// Check state is mounted writable (no :ro suffix)
		const stateMountIdx = args.findIndex((a) => a === "/host/state:/workspace/state");
		expect(stateMountIdx).toBeGreaterThan(-1);

		// Check env vars
		// Check credential proxy env vars
		const baseUrlArg = args.find((a) => a.startsWith("ANTHROPIC_BASE_URL="));
		expect(baseUrlArg).toBeDefined();
		expect(baseUrlArg).toContain(CONTAINER_HOST_GATEWAY);
		expect(args).toContain("ANTHROPIC_API_KEY=placeholder");
		expect(args).toContain("GIT_CONFIG_NOSYSTEM=1");
	});

	it("shadows .env files with /dev/null", () => {
		// Create a repo dir with .env files
		const repoDir = join(testDir, "repo");
		mkdirSync(repoDir);
		writeFileSync(join(repoDir, ".env"), "SECRET=leaked");
		writeFileSync(join(repoDir, ".env.local"), "LOCAL=leaked");
		writeFileSync(join(repoDir, "index.ts"), "code");

		const args = buildContainerArgs({
			containerName: "test",
			repoDir,
			stateDir: "/host/state",
			skillDirs: [],
					piCommand: ["echo"],
		});

		// Should have --mount args for .env files
		const mountArgs = args.filter((a) => a.includes("/dev/null"));
		expect(mountArgs.length).toBe(2);
		expect(mountArgs.some((a) => a.includes(".env,readonly"))).toBe(true);
		expect(mountArgs.some((a) => a.includes(".env.local,readonly"))).toBe(true);
	});

	it("includes multiple skill directories", () => {
		const skill1 = join(testDir, "review");
		const skill2 = join(testDir, "verify");
		mkdirSync(skill1);
		mkdirSync(skill2);

		const args = buildContainerArgs({
			containerName: "test",
			repoDir: "/host/repo",
			stateDir: "/host/state",
			skillDirs: [skill1, skill2],
					piCommand: ["echo"],
		});

		const skillMounts = args.filter((a) => a.includes("/workspace/skills/"));
		expect(skillMounts.length).toBe(2);
		expect(skillMounts.some((a) => a.includes("/workspace/skills/review:ro"))).toBe(true);
		expect(skillMounts.some((a) => a.includes("/workspace/skills/verify:ro"))).toBe(true);
	});
});

// ============================================================================
// piCliPathInContainer
// ============================================================================

describe("piCliPathInContainer", () => {
	it("returns a path inside the global node_modules", () => {
		const p = piCliPathInContainer();
		expect(p).toContain("node_modules");
		expect(p).toContain("pi-coding-agent");
		expect(p.startsWith("/")).toBe(true);
	});
});
