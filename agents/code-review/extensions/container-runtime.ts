/**
 * Container runtime abstraction for code-review agent.
 * Supports Docker and Apple Container runtimes.
 * All runtime-specific logic lives here so the rest of the codebase is runtime-agnostic.
 */
import { execFileSync } from "node:child_process";
import { CREDENTIAL_PROXY_PORT } from "./credential-proxy.js";
import { existsSync, readdirSync } from "node:fs";
import { networkInterfaces, platform } from "node:os";
import { basename, join } from "node:path";

// ============================================================================
// Runtime Detection
// ============================================================================

export type ContainerRuntime = "docker" | "apple-container";

/**
 * Return the active container runtime.
 * Priority: CONTAINER_RUNTIME env var > auto-detect (macOS + `container` CLI → apple-container) > docker.
 */
export function currentRuntime(): ContainerRuntime {
	const env = process.env.CONTAINER_RUNTIME;
	if (env === "apple-container") return "apple-container";
	if (env === "docker") return "docker";
	// Auto-detect: prefer Apple Container on macOS when available
	if (platform() === "darwin") {
		try {
			execFileSync("container", ["--version"], { stdio: "pipe", timeout: 5_000 });
			return "apple-container";
		} catch {
			// Apple Container CLI not found — fall back to Docker
		}
	}
	return "docker";
}

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

/** The container runtime binary name (derived from active runtime). */
export function runtimeBin(): string {
	return currentRuntime() === "apple-container" ? "container" : "docker";
}

/**
 * Detect the host's primary DNS server (macOS only).
 * Falls back to 8.8.8.8 if detection fails.
 */
export function detectHostDns(): string {
	if (platform() === "darwin") {
		try {
			const output = execFileSync("scutil", ["--dns"], {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 5_000,
			});
			// Find first nameserver from the primary resolver
			const match = (output as string).match(/nameserver\[\d+\]\s*:\s*(\d+\.\d+\.\d+\.\d+)/);
			if (match) return match[1];
		} catch { /* fall through */ }
	}
	return "8.8.8.8";
}

/** Docker image name for the code review agent. */
export const CONTAINER_IMAGE = "code-review-agent";

/** Hostname containers use to reach the host machine (same for both runtimes on macOS). */
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
 * macOS (Docker Desktop or Apple Container): 127.0.0.1
 * WSL (Docker Desktop): 127.0.0.1
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
	// Apple Container on macOS resolves host.docker.internal natively — no extra args needed.
	if (currentRuntime() === "apple-container") return [];
	if (platform() === "linux") {
		return ["--add-host=host.docker.internal:host-gateway"];
	}
	return [];
}

/**
 * Returns CLI args for a readonly bind mount.
 * Apple Container (VirtioFS) does not support file-level bind mounts,
 * so we use --mount syntax for directory mounts and skip file mounts.
 */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
	if (currentRuntime() === "apple-container") {
		return ["--mount", `type=bind,source=${hostPath},target=${containerPath},readonly`];
	}
	return ["-v", `${hostPath}:${containerPath}:ro`];
}

/** Returns CLI args for a writable bind mount. */
export function writableMountArgs(hostPath: string, containerPath: string): string[] {
	return ["-v", `${hostPath}:${containerPath}`];
}

/** Ensure the container runtime is running. Throws with helpful message if not. */
export function ensureRuntimeRunning(): void {
	const bin = runtimeBin();
	const rt = currentRuntime();
	try {
		if (rt === "apple-container") {
			execFileSync(bin, ["system", "status"], { stdio: "pipe", timeout: 10_000 });
		} else {
			execFileSync(bin, ["info"], { stdio: "pipe", timeout: 10_000 });
		}
	} catch {
		const name = rt === "apple-container" ? "Apple Container" : "Docker";
		throw new Error(
			`${name} is required but not running. Please install and start ${name}, then retry.`,
		);
	}
}

/**
 * Ensure the container image exists, building it if needed.
 *
 * Apple Container's buildkit has DNS issues — build with Docker, export as
 * OCI tarball, and import into Apple Container as a workaround.
 */
export function ensureImageBuilt(dockerfilePath: string): void {
	const bin = runtimeBin();
	const rt = currentRuntime();
	try {
		execFileSync(bin, ["image", "inspect", CONTAINER_IMAGE], {
			stdio: "pipe",
			timeout: 10_000,
		});
	} catch {
		if (rt === "apple-container") {
			console.log(`[container] Building image via Docker (Apple Container buildkit DNS workaround)`);
			execFileSync("docker", ["build", "-t", CONTAINER_IMAGE, dockerfilePath], {
				stdio: "inherit",
				timeout: 300_000,
			});
			console.log(`[container] Exporting and importing image into Apple Container...`);
			const ociTar = join(dockerfilePath, `../${CONTAINER_IMAGE}.tar`);
			try {
				execFileSync("docker", ["save", "-o", ociTar, CONTAINER_IMAGE], {
					stdio: "inherit",
					timeout: 120_000,
				});
				execFileSync("container", ["image", "load", "-i", ociTar], {
					stdio: "inherit",
					timeout: 120_000,
				});
			} finally {
				try { execFileSync("rm", ["-f", ociTar], { stdio: "pipe" }); } catch { /* ignore */ }
			}
		} else {
			console.log(`[container] Building image: ${CONTAINER_IMAGE}`);
			execFileSync(bin, ["build", "-t", CONTAINER_IMAGE, dockerfilePath], {
				stdio: "inherit",
				timeout: 300_000,
			});
		}
	}
}

/** Kill orphaned code-review containers from previous runs. */
export function cleanupOrphans(prefix: string = "code-review-"): void {
	const bin = runtimeBin();
	try {
		let orphans: string[];
		if (currentRuntime() === "apple-container") {
			// Apple Container: `container ls --format json` returns JSON array
			const output = execFileSync(bin, ["ls", "--format", "json"], {
				stdio: ["pipe", "pipe", "pipe"],
				encoding: "utf-8",
			});
			const containers: Array<{ name?: string; names?: string }> = JSON.parse(output || "[]");
			orphans = containers
				.map((c) => c.name || c.names || "")
				.filter((n) => n.startsWith(prefix));
		} else {
			const output = execFileSync(
				bin,
				["ps", "--filter", `name=${prefix}`, "--format", "{{.Names}}"],
				{ stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
			);
			orphans = (output as string).trim().split("\n").filter(Boolean);
		}
		for (const name of orphans) {
			stopContainer(name);
		}
		if (orphans.length > 0) {
			console.log(`[container] Stopped ${orphans.length} orphaned container(s)`);
		}
	} catch {
		// Failed to list — runtime may not be running yet
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
 * Build container run args for a container-isolated sub-agent.
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
	const rt = currentRuntime();

	const args: string[] = [
		"run",
		"-i",
		"--rm",
		"--name",
		containerName,
		// Resource limits
		`--memory=${CONTAINER_RESOURCE_LIMITS.memory}`,
		`--cpus=${CONTAINER_RESOURCE_LIMITS.cpus}`,
	];

	// Apple Container does not support --pids-limit
	if (rt !== "apple-container") {
		args.push(`--pids-limit=${CONTAINER_RESOURCE_LIMITS.pidsLimit}`);
	}

	// Apple Container: default DNS (192.168.64.1) may not work — use public DNS
	if (rt === "apple-container") {
		args.push("--dns", detectHostDns());
	}

	// Docker: run as node user (Dockerfile no longer sets USER).
	// Apple Container: run as root so entrypoint can shadow .env via mount --bind.
	if (rt !== "apple-container") {
		args.push("--user", "1000:1000");
	}

	args.push(
		// Read-only repo
		...readonlyMountArgs(repoDir, CONTAINER_PATHS.repo),
		// Writable state
		...writableMountArgs(stateDir, CONTAINER_PATHS.state),
		// Read-only skills
		...skillDirs.flatMap((s) => readonlyMountArgs(s, CONTAINER_PATHS.skill(basename(s)))),
		// Writable pi home (persists sessions to host)
		...(sessionsDir ? writableMountArgs(sessionsDir, CONTAINER_PATHS.piHome) : []),
	);

	if (isAnthropicProxy) {
		// Anthropic: route through credential proxy (no real keys in container)
		args.push("-e", `ANTHROPIC_BASE_URL=http://${gateway}:${CREDENTIAL_PROXY_PORT}`);
		args.push("-e", "ANTHROPIC_API_KEY=placeholder");
	}
	// Non-anthropic: real API key is passed via --api-key in piCommand (not env vars).
	// Container needs internet access to reach the provider API directly.

	// Disable git hooks
	args.push("-e", "GIT_CONFIG_NOSYSTEM=1");

	// Apple Container NAT is IPv4 only — force Node.js to prefer IPv4 DNS results.
	if (rt === "apple-container") {
		args.push("-e", "NODE_OPTIONS=--dns-result-order=ipv4first");
	}

	// Shadow .env files to prevent credential leakage.
	// Docker: use file-level bind mount from /dev/null (VirtioFS supports this).
	// Apple Container: skip here — entrypoint.sh handles it via mount --bind.
	if (rt !== "apple-container") {
		args.push(
			...findEnvFiles(repoDir).flatMap((f) => [
				"--mount",
				`type=bind,source=/dev/null,target=${CONTAINER_PATHS.repo}/${f},readonly`,
			]),
		);
	}

	args.push(
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
	const args = ["stop"];
	// Apple Container `container stop` does not support -t flag
	if (currentRuntime() !== "apple-container") {
		args.push("-t", String(timeoutSec));
	}
	args.push(name);
	try {
		execFileSync(runtimeBin(), args, {
			stdio: "pipe",
			timeout: (timeoutSec + 5) * 1000,
		});
	} catch {
		// Container may have already exited
	}
}
