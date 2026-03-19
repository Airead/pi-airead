/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real API key so containers never see actual credentials.
 *
 * Only API key mode is supported (no OAuth).
 */
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type RequestOptions } from "node:http";

export const CREDENTIAL_PROXY_PORT = 3001;

/** Maximum request body size (10 MB) to prevent memory abuse from containers. */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

export function startCredentialProxy(
	port: number = CREDENTIAL_PROXY_PORT,
	host: string = "127.0.0.1",
): Promise<Server> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error("ANTHROPIC_API_KEY is required for credential proxy");
	}

	const upstreamUrl = new URL(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
	const isHttps = upstreamUrl.protocol === "https:";
	const makeRequest = isHttps ? httpsRequest : httpRequest;

	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			let totalLength = 0;
			let rejected = false;
			req.on("data", (c: Buffer) => {
				totalLength += c.length;
				if (totalLength > MAX_BODY_SIZE) {
					rejected = true;
					req.destroy();
					if (!res.headersSent) {
						res.writeHead(413);
						res.end("Request body too large");
					}
					return;
				}
				chunks.push(c);
			});
			req.on("end", () => {
				if (rejected) return;
				const body = Buffer.concat(chunks);
				const headers: Record<string, string | number | string[] | undefined> = {
					...(req.headers as Record<string, string>),
					host: upstreamUrl.host,
					"content-length": body.length,
				};

				// Strip hop-by-hop headers
				delete headers["connection"];
				delete headers["keep-alive"];
				delete headers["transfer-encoding"];

				// Inject real API key, replacing any placeholder
				delete headers["x-api-key"];
				headers["x-api-key"] = apiKey;

				const upstream = makeRequest(
					{
						hostname: upstreamUrl.hostname,
						port: upstreamUrl.port || (isHttps ? 443 : 80),
						path: req.url,
						method: req.method,
						headers,
						timeout: 120_000,
					} as RequestOptions,
					(upRes) => {
						res.writeHead(upRes.statusCode!, upRes.headers);
						upRes.pipe(res);
					},
				);

				upstream.on("timeout", () => {
					upstream.destroy(new Error("Upstream request timed out"));
				});

				upstream.on("error", (err) => {
					console.error("[credential-proxy] Upstream error:", err.message, "URL:", req.url);
					if (!res.headersSent) {
						res.writeHead(502);
						res.end("Bad Gateway");
					}
				});

				// Abort upstream request if downstream client disconnects
				res.on("close", () => {
					if (!res.writableFinished) upstream.destroy();
				});

				upstream.write(body);
				upstream.end();
			});
		});

		server.listen(port, host, () => {
			console.log(`[credential-proxy] Started on ${host}:${port}`);
			resolve(server);
		});

		server.on("error", reject);
	});
}

export function stopCredentialProxy(server: Server): Promise<void> {
	return new Promise((resolve) => {
		// Force-close lingering keep-alive connections after a grace period
		const forceTimeout = setTimeout(() => {
			if (typeof server.closeAllConnections === "function") {
				server.closeAllConnections();
			}
			resolve();
		}, 3000);
		server.close(() => {
			clearTimeout(forceTimeout);
			console.log("[credential-proxy] Stopped");
			resolve();
		});
	});
}
