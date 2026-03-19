import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { startCredentialProxy, stopCredentialProxy } from "./credential-proxy.js";

// Store original env
const originalEnv = { ...process.env };

beforeEach(() => {
	process.env.ANTHROPIC_API_KEY = "test-api-key-12345";
	delete process.env.ANTHROPIC_BASE_URL;
});

afterEach(() => {
	process.env = { ...originalEnv };
	vi.restoreAllMocks();
});

describe("startCredentialProxy", () => {
	it("throws if ANTHROPIC_API_KEY is not set", async () => {
		delete process.env.ANTHROPIC_API_KEY;
		// startCredentialProxy throws synchronously when API key is missing
		expect(() => startCredentialProxy(0, "127.0.0.1")).toThrow("ANTHROPIC_API_KEY is required");
	});

	it("starts and stops without error", async () => {
		const server = await startCredentialProxy(0, "127.0.0.1");
		const addr = server.address();
		expect(addr).toBeTruthy();
		expect(typeof addr === "object" && addr !== null ? addr.port : 0).toBeGreaterThan(0);
		await stopCredentialProxy(server);
	});

	it("injects API key into forwarded requests", async () => {
		const receivedHeaders: Record<string, string | string[] | undefined> = {};
		const upstream = http.createServer((req, res) => {
			Object.assign(receivedHeaders, req.headers);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});

		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const upstreamAddr = upstream.address() as { port: number };

		process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamAddr.port}`;

		const proxy = await startCredentialProxy(0, "127.0.0.1");
		const proxyAddr = proxy.address() as { port: number };

		const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port: proxyAddr.port,
					path: "/v1/messages",
					method: "POST",
					headers: {
						"x-api-key": "placeholder",
						"content-type": "application/json",
					},
				},
				(res) => {
					let body = "";
					res.on("data", (chunk: Buffer) => (body += chunk.toString()));
					res.on("end", () => resolve({ statusCode: res.statusCode!, body }));
				},
			);
			req.on("error", reject);
			req.write(JSON.stringify({ model: "test" }));
			req.end();
		});

		expect(response.statusCode).toBe(200);
		expect(receivedHeaders["x-api-key"]).toBe("test-api-key-12345");

		await stopCredentialProxy(proxy);
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	});

	it("returns 502 on upstream error", async () => {
		process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";

		const proxy = await startCredentialProxy(0, "127.0.0.1");
		const proxyAddr = proxy.address() as { port: number };

		const response = await new Promise<{ statusCode: number }>((resolve, reject) => {
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port: proxyAddr.port,
					path: "/v1/messages",
					method: "POST",
					headers: { "x-api-key": "placeholder" },
				},
				(res) => {
					res.on("data", () => {});
					res.on("end", () => resolve({ statusCode: res.statusCode! }));
				},
			);
			req.on("error", reject);
			req.end();
		});

		expect(response.statusCode).toBe(502);

		await stopCredentialProxy(proxy);
	});

	it("replaces placeholder API key with real key", async () => {
		const receivedHeaders: Record<string, string | string[] | undefined> = {};
		const upstream = http.createServer((req, res) => {
			Object.assign(receivedHeaders, req.headers);
			res.writeHead(200);
			res.end("ok");
		});

		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const upstreamAddr = upstream.address() as { port: number };
		process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamAddr.port}`;

		const proxy = await startCredentialProxy(0, "127.0.0.1");
		const proxyAddr = proxy.address() as { port: number };

		await new Promise<void>((resolve, reject) => {
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port: proxyAddr.port,
					path: "/test",
					method: "POST",
					headers: {
						"x-api-key": "placeholder-should-be-replaced",
						"content-type": "application/json",
					},
				},
				(res) => {
					res.on("data", () => {});
					res.on("end", () => resolve());
				},
			);
			req.on("error", reject);
			req.write("{}");
			req.end();
		});

		// The placeholder should have been replaced with the real key
		expect(receivedHeaders["x-api-key"]).toBe("test-api-key-12345");
		expect(receivedHeaders["x-api-key"]).not.toBe("placeholder-should-be-replaced");

		await stopCredentialProxy(proxy);
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	});
});
