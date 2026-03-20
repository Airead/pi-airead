import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	buildContainerArgs,
	CONTAINER_HOST_GATEWAY,
	CONTAINER_IMAGE,
	currentRuntime,
	detectHostDns,
	detectProxyBindHost,
	findEnvFiles,
	hostGatewayArgs,
	piCliPathInContainer,
	PROVIDER_API_KEY_ENV,
	readonlyMountArgs,
	resolveApiKeyEnvVar,
	runtimeBin,
	writableMountArgs,
} from "./container-runtime.js";

// ============================================================================
// Test Helpers
// ============================================================================

let testDir: string;
let originalRuntime: string | undefined;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "container-runtime-test-"));
	originalRuntime = process.env.CONTAINER_RUNTIME;
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
	// Restore original env
	if (originalRuntime === undefined) {
		delete process.env.CONTAINER_RUNTIME;
	} else {
		process.env.CONTAINER_RUNTIME = originalRuntime;
	}
	vi.restoreAllMocks();
});

// ============================================================================
// currentRuntime
// ============================================================================

describe("currentRuntime", () => {
	it("returns 'docker' when CONTAINER_RUNTIME=docker", () => {
		process.env.CONTAINER_RUNTIME = "docker";
		expect(currentRuntime()).toBe("docker");
	});

	it("returns 'apple-container' when CONTAINER_RUNTIME=apple-container", () => {
		process.env.CONTAINER_RUNTIME = "apple-container";
		expect(currentRuntime()).toBe("apple-container");
	});

	it("auto-detects when CONTAINER_RUNTIME is not set", () => {
		delete process.env.CONTAINER_RUNTIME;
		const rt = currentRuntime();
		// On macOS with Apple Container CLI installed → apple-container
		// Otherwise → docker
		expect(["docker", "apple-container"]).toContain(rt);
	});

	it("falls back to auto-detect for unknown values", () => {
		process.env.CONTAINER_RUNTIME = "podman";
		const rt = currentRuntime();
		expect(["docker", "apple-container"]).toContain(rt);
	});
});

// ============================================================================
// runtimeBin
// ============================================================================

describe("runtimeBin", () => {
	it("returns 'docker' for docker runtime", () => {
		process.env.CONTAINER_RUNTIME = "docker";
		expect(runtimeBin()).toBe("docker");
	});

	it("returns 'container' for apple-container runtime", () => {
		process.env.CONTAINER_RUNTIME = "apple-container";
		expect(runtimeBin()).toBe("container");
	});
});

// ============================================================================
// detectProxyBindHost
// ============================================================================

describe("detectHostDns", () => {
	it("returns a valid IP address", () => {
		const dns = detectHostDns();
		expect(dns).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
	});
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
		process.env.CONTAINER_RUNTIME = "docker";
		const args = hostGatewayArgs();
		expect(Array.isArray(args)).toBe(true);
	});

	it("contains --add-host on Linux or is empty on macOS (docker)", () => {
		process.env.CONTAINER_RUNTIME = "docker";
		const args = hostGatewayArgs();
		// On macOS (test environment), should be empty
		// On Linux, should contain --add-host
		for (const arg of args) {
			expect(arg).toContain("host.docker.internal");
		}
	});

	it("returns empty array for apple-container (no host gateway args needed)", () => {
		process.env.CONTAINER_RUNTIME = "apple-container";
		const args = hostGatewayArgs();
		expect(args).toEqual([]);
	});
});

// ============================================================================
// Mount helpers
// ============================================================================

describe("readonlyMountArgs", () => {
	it("returns -v syntax for docker", () => {
		process.env.CONTAINER_RUNTIME = "docker";
		const args = readonlyMountArgs("/host/path", "/container/path");
		expect(args).toEqual(["-v", "/host/path:/container/path:ro"]);
	});

	it("returns --mount syntax for apple-container", () => {
		process.env.CONTAINER_RUNTIME = "apple-container";
		const args = readonlyMountArgs("/host/path", "/container/path");
		expect(args).toEqual([
			"--mount",
			"type=bind,source=/host/path,target=/container/path,readonly",
		]);
	});
});

describe("writableMountArgs", () => {
	it("returns correct mount args for docker", () => {
		process.env.CONTAINER_RUNTIME = "docker";
		const args = writableMountArgs("/host/path", "/container/path");
		expect(args).toEqual(["-v", "/host/path:/container/path"]);
	});

	it("returns correct mount args for apple-container", () => {
		process.env.CONTAINER_RUNTIME = "apple-container";
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
// buildContainerArgs — Docker
// ============================================================================

describe("buildContainerArgs (docker)", () => {
	beforeEach(() => {
		process.env.CONTAINER_RUNTIME = "docker";
	});

	it("builds correct docker run args with anthropic proxy (default)", () => {
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

		// Docker should set explicit user
		const userIdx = args.indexOf("--user");
		expect(userIdx).toBeGreaterThan(-1);
		expect(args[userIdx + 1]).toBe("1000:1000");

		// Check repo is mounted read-only
		const repoMountIdx = args.findIndex((a) => a.includes("/host/repo:/workspace/repo:ro"));
		expect(repoMountIdx).toBeGreaterThan(-1);

		// Check state is mounted writable (no :ro suffix)
		const stateMountIdx = args.findIndex((a) => a === "/host/state:/workspace/state");
		expect(stateMountIdx).toBeGreaterThan(-1);

		// Check credential proxy env vars (default = anthropic)
		const baseUrlArg = args.find((a) => a.startsWith("ANTHROPIC_BASE_URL="));
		expect(baseUrlArg).toBeDefined();
		expect(baseUrlArg).toContain(CONTAINER_HOST_GATEWAY);
		expect(args).toContain("ANTHROPIC_API_KEY=placeholder");
		expect(args).toContain("GIT_CONFIG_NOSYSTEM=1");
	});

	it("builds correct docker run args with explicit anthropic provider", () => {
		const args = buildContainerArgs({
			containerName: "test",
			repoDir: "/host/repo",
			stateDir: "/host/state",
			skillDirs: [],
			piCommand: ["echo"],
			providerConfig: { provider: "anthropic" },
		});

		// Anthropic should use proxy env vars
		expect(args).toContain("ANTHROPIC_API_KEY=placeholder");
		expect(args.find((a) => a.startsWith("ANTHROPIC_BASE_URL="))).toBeDefined();
	});

	it("omits anthropic env vars for non-anthropic provider", () => {
		const args = buildContainerArgs({
			containerName: "test",
			repoDir: "/host/repo",
			stateDir: "/host/state",
			skillDirs: [],
			piCommand: ["node", "cli.js", "--mode", "rpc", "--provider", "zai", "--api-key", "test-key"],
			providerConfig: { provider: "zai", model: "glm-5", apiKey: "test-key" },
		});

		// Should NOT have anthropic proxy env vars
		expect(args).not.toContain("ANTHROPIC_API_KEY=placeholder");
		expect(args.find((a) => a.startsWith("ANTHROPIC_BASE_URL="))).toBeUndefined();
		// Should still have GIT_CONFIG_NOSYSTEM
		expect(args).toContain("GIT_CONFIG_NOSYSTEM=1");
		// piCommand should contain provider/model/api-key args
		expect(args).toContain("--provider");
		expect(args).toContain("zai");
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

	it("does not include NODE_OPTIONS or --dns for docker", () => {
		const args = buildContainerArgs({
			containerName: "test",
			repoDir: "/host/repo",
			stateDir: "/host/state",
			skillDirs: [],
			piCommand: ["echo"],
		});

		expect(args.find((a) => a.includes("NODE_OPTIONS"))).toBeUndefined();
		expect(args).not.toContain("--dns");
	});
});

// ============================================================================
// buildContainerArgs — Apple Container
// ============================================================================

describe("buildContainerArgs (apple-container)", () => {
	beforeEach(() => {
		process.env.CONTAINER_RUNTIME = "apple-container";
	});

	it("omits --pids-limit for apple-container", () => {
		const args = buildContainerArgs({
			containerName: "test",
			repoDir: "/host/repo",
			stateDir: "/host/state",
			skillDirs: [],
			piCommand: ["echo"],
		});

		expect(args.find((a) => a.includes("pids-limit"))).toBeUndefined();
		// But should still have memory and cpu limits
		expect(args).toContain("--memory=2g");
		expect(args).toContain("--cpus=2");
	});

	it("does not set --user (runs as root for entrypoint .env shadowing)", () => {
		const args = buildContainerArgs({
			containerName: "test",
			repoDir: "/host/repo",
			stateDir: "/host/state",
			skillDirs: [],
			piCommand: ["echo"],
		});

		expect(args).not.toContain("--user");
	});

	it("does not shadow .env files via mount (entrypoint handles it)", () => {
		const repoDir = join(testDir, "repo");
		mkdirSync(repoDir);
		writeFileSync(join(repoDir, ".env"), "SECRET=leaked");

		const args = buildContainerArgs({
			containerName: "test",
			repoDir,
			stateDir: "/host/state",
			skillDirs: [],
			piCommand: ["echo"],
		});

		const devNullMounts = args.filter((a) => a.includes("/dev/null"));
		expect(devNullMounts.length).toBe(0);
	});

	it("includes NODE_OPTIONS for IPv4 DNS preference", () => {
		const args = buildContainerArgs({
			containerName: "test",
			repoDir: "/host/repo",
			stateDir: "/host/state",
			skillDirs: [],
			piCommand: ["echo"],
		});

		expect(args).toContain("NODE_OPTIONS=--dns-result-order=ipv4first");
	});

	it("includes --dns with host DNS server", () => {
		const args = buildContainerArgs({
			containerName: "test",
			repoDir: "/host/repo",
			stateDir: "/host/state",
			skillDirs: [],
			piCommand: ["echo"],
		});

		const dnsIdx = args.indexOf("--dns");
		expect(dnsIdx).toBeGreaterThan(-1);
		expect(args[dnsIdx + 1]).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
	});

	it("uses --mount syntax for readonly mounts", () => {
		const args = buildContainerArgs({
			containerName: "test",
			repoDir: "/host/repo",
			stateDir: "/host/state",
			skillDirs: [],
			piCommand: ["echo"],
		});

		// Repo mount should use --mount syntax
		const mountIdx = args.findIndex((a) =>
			a.includes("type=bind,source=/host/repo,target=/workspace/repo,readonly"),
		);
		expect(mountIdx).toBeGreaterThan(-1);
	});
});

// ============================================================================
// resolveApiKeyEnvVar
// ============================================================================

describe("resolveApiKeyEnvVar", () => {
	it("returns known provider env vars", () => {
		expect(resolveApiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
		expect(resolveApiKeyEnvVar("zai")).toBe("ZAI_API_KEY");
		expect(resolveApiKeyEnvVar("openai")).toBe("OPENAI_API_KEY");
		expect(resolveApiKeyEnvVar("google")).toBe("GEMINI_API_KEY");
		expect(resolveApiKeyEnvVar("huggingface")).toBe("HF_TOKEN");
	});

	it("falls back to PROVIDER_API_KEY for unknown providers", () => {
		expect(resolveApiKeyEnvVar("custom")).toBe("CUSTOM_API_KEY");
		expect(resolveApiKeyEnvVar("my-provider")).toBe("MY_PROVIDER_API_KEY");
	});
});

// ============================================================================
// PROVIDER_API_KEY_ENV
// ============================================================================

describe("PROVIDER_API_KEY_ENV", () => {
	it("contains entries for common providers", () => {
		expect(PROVIDER_API_KEY_ENV).toHaveProperty("anthropic");
		expect(PROVIDER_API_KEY_ENV).toHaveProperty("zai");
		expect(PROVIDER_API_KEY_ENV).toHaveProperty("openai");
		expect(PROVIDER_API_KEY_ENV).toHaveProperty("google");
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
