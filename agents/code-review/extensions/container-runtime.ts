/**
 * Container runtime abstraction for code-review agent.
 * All Docker-specific logic lives here.
 */
import { execFileSync } from "node:child_process";
import { CREDENTIAL_PROXY_PORT } from "./credential-proxy.js";
import { existsSync, readdirSync } from "node:fs";
import { networkInterfaces, platform } from "node:os";
import { basename, join } from "node:path";

// ============================================================================
// Provider Configuration
// ============================================================================

/** Provider-specific configuration for container environment. */
export interface ProviderConfig {
	/** Provider name (e.g., "anthropic", "zai", "openai") */
	provider: string;
	/** Model ID (e.g., "glm-5", "claude-opus-4-6") */
	model?: string;
	/** API key to pass to sub-agents (for non-anthropic providers) */
	apiKey?: string;
}

/**
 * Map of known providers to their API key environment variable names.
 * NOTE: launch.sh has a parallel mapping in resolve_api_key_env() — keep in sync.
 */
export const PROVIDER_API_KEY_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	zai: "ZAI_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	xai: "XAI_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	huggingface: "HF_TOKEN",
	kimi: "KIMI_API_KEY",
};

/** Resolve the API key env var name for a given provider. */
export function resolveApiKeyEnvVar(provider: string): string {
	return PROVIDER_API_KEY_ENV[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = "docker";

/** Docker image name for the code review agent. */
export const CONTAINER_IMAGE = "code-review-agent";

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = "host.docker.internal";

/** Container resource limits. */
export const CONTAINER_RESOURCE_LIMITS = {
	memory: "2g",
	cpus: "2",
	pidsLimit: "256",
} as const;

/** Container-side workspace paths (must match Dockerfile layout and mount points). */
export const CONTAINER_PATHS = {
	repo: "/workspace/repo",
	state: "/workspace/state",
	skillsRoot: "/workspace/skills",
	skill: (name: string) => `/workspace/skills/${name}`,
	stateFile: (name: string) => `/workspace/state/${name}`,
	/** Pi config dir inside container (node user home). Sessions are persisted here. */
	piHome: "/home/node/.pi",
} as const;

/**
 * Address the credential proxy binds to.
 * macOS/WSL: 127.0.0.1 (Docker Desktop VM routes host.docker.internal to loopback)
 * Linux: docker0 bridge IP, falling back to 0.0.0.0
 */
export function detectProxyBindHost(): string {
	if (platform() === "darwin") return "127.0.0.1";

	// WSL uses Docker Desktop — loopback is correct
	if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) return "127.0.0.1";

	// Bare-metal Linux: bind to docker0 bridge IP
	const ifaces = networkInterfaces();
	const docker0 = ifaces["docker0"];
	if (docker0) {
		const ipv4 = docker0.find((a) => a.family === "IPv4");
		if (ipv4) return ipv4.address;
	}
	return "0.0.0.0";
}

/** CLI args needed for the container to resolve the host gateway on Linux. */
export function hostGatewayArgs(): string[] {
	if (platform() === "linux") {
		return ["--add-host=host.docker.internal:host-gateway"];
	}
	return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
	return ["-v", `${hostPath}:${containerPath}:ro`];
}

/** Returns CLI args for a writable bind mount. */
export function writableMountArgs(hostPath: string, containerPath: string): string[] {
	return ["-v", `${hostPath}:${containerPath}`];
}

/** Ensure the container runtime is running. Throws with helpful message if not. */
export function ensureRuntimeRunning(): void {
	try {
		execFileSync(CONTAINER_RUNTIME_BIN, ["info"], {
			stdio: "pipe",
			timeout: 10_000,
		});
	} catch {
		throw new Error(
			"Docker is required but not running. Please install and start Docker, then retry.",
		);
	}
}

/** Ensure the container image exists, building it if needed. */
export function ensureImageBuilt(dockerfilePath: string): void {
	try {
		execFileSync(CONTAINER_RUNTIME_BIN, ["image", "inspect", CONTAINER_IMAGE], {
			stdio: "pipe",
			timeout: 10_000,
		});
	} catch {
		console.log(`[container] Building image: ${CONTAINER_IMAGE}`);
		execFileSync(CONTAINER_RUNTIME_BIN, ["build", "-t", CONTAINER_IMAGE, dockerfilePath], {
			stdio: "inherit",
			timeout: 300_000,
		});
	}
}

/** Kill orphaned code-review containers from previous runs. */
export function cleanupOrphans(prefix: string = "code-review-"): void {
	try {
		const output = execFileSync(
			CONTAINER_RUNTIME_BIN,
			["ps", "--filter", `name=${prefix}`, "--format", "{{.Names}}"],
			{ stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
		);
		const orphans = (output as string).trim().split("\n").filter(Boolean);
		for (const name of orphans) {
			stopContainer(name);
		}
		if (orphans.length > 0) {
			console.log(`[container] Stopped ${orphans.length} orphaned container(s)`);
		}
	} catch {
		// Failed to list — Docker may not be running yet
	}
}

/**
 * Find .env files in a directory (non-recursive, top-level only).
 * These will be shadowed with /dev/null in the container.
 */
export function findEnvFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter(
			(f) => f === ".env" || f.startsWith(".env.") || f.endsWith(".env"),
		);
	} catch {
		return [];
	}
}

/**
 * Build docker run args for a container-isolated sub-agent.
 *
 * For anthropic provider: uses credential proxy (container gets placeholder key + proxy URL).
 * For other providers: passes real API key via --api-key in piCommand (container accesses provider directly).
 */
export function buildContainerArgs(options: {
	containerName: string;
	repoDir: string;
	stateDir: string;
	sessionsDir?: string;
	skillDirs: string[];
	piCommand: string[];
	providerConfig?: ProviderConfig;
}): string[] {
	const { containerName, repoDir, stateDir, sessionsDir, skillDirs, piCommand, providerConfig } = options;
	const gateway = CONTAINER_HOST_GATEWAY;
	const isAnthropicProxy = !providerConfig || providerConfig.provider === "anthropic";

	const args: string[] = [
		"run",
		"-i",
		"--rm",
		"--name",
		containerName,
		// Resource limits
		`--memory=${CONTAINER_RESOURCE_LIMITS.memory}`,
		`--cpus=${CONTAINER_RESOURCE_LIMITS.cpus}`,
		`--pids-limit=${CONTAINER_RESOURCE_LIMITS.pidsLimit}`,
		// Read-only repo
		...readonlyMountArgs(repoDir, CONTAINER_PATHS.repo),
		// Writable state
		...writableMountArgs(stateDir, CONTAINER_PATHS.state),
		// Read-only skills
		...skillDirs.flatMap((s) => readonlyMountArgs(s, CONTAINER_PATHS.skill(basename(s)))),
		// Writable pi home (persists sessions to host)
		...(sessionsDir ? writableMountArgs(sessionsDir, CONTAINER_PATHS.piHome) : []),
	];

	if (isAnthropicProxy) {
		// Anthropic: route through credential proxy (no real keys in container)
		args.push("-e", `ANTHROPIC_BASE_URL=http://${gateway}:${CREDENTIAL_PROXY_PORT}`);
		args.push("-e", "ANTHROPIC_API_KEY=placeholder");
	}
	// Non-anthropic: real API key is passed via --api-key in piCommand (not env vars).
	// Container needs internet access to reach the provider API directly.

	args.push(
		// Disable git hooks
		"-e",
		"GIT_CONFIG_NOSYSTEM=1",
		// Shadow .env files
		...findEnvFiles(repoDir).flatMap((f) => [
			"--mount",
			`type=bind,source=/dev/null,target=${CONTAINER_PATHS.repo}/${f},readonly`,
		]),
		// Platform-specific host gateway
		...hostGatewayArgs(),
		// Image
		CONTAINER_IMAGE,
		// Command
		...piCommand,
	);

	return args;
}

/**
 * Resolve the pi CLI path inside the container.
 * The globally installed pi binary is at a known location.
 */
export function piCliPathInContainer(): string {
	// npm global installs to /usr/local/lib/node_modules/ for node:22-slim
	return "/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js";
}

/**
 * Stop a container by name with a grace period.
 */
export function stopContainer(name: string, timeoutSec: number = 3): void {
	try {
		execFileSync(CONTAINER_RUNTIME_BIN, ["stop", "-t", String(timeoutSec), name], {
			stdio: "pipe",
			timeout: (timeoutSec + 5) * 1000,
		});
	} catch {
		// Container may have already exited
	}
}
