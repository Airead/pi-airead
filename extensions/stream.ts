/**
 * Stream Extension
 *
 * Streams thinking, tool calls, and text replies to the terminal via stderr.
 * All output goes to stderr so it never conflicts with the built-in stdout
 * output (e.g. `-p` text mode or `--mode stream`).
 *
 * Output (all stderr):
 * - text_delta: blue (streaming preview, visually distinct from final stdout)
 * - thinking_delta: dim italic
 * - tool labels: cyan
 * - tool errors: red
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ANSI escape helpers (avoid chalk dependency)
const ansi = {
	dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
	italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
	blue: (s: string) => `\x1b[94m${s}\x1b[39m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
	red: (s: string) => `\x1b[31m${s}\x1b[39m`,
	reset: "\x1b[0m",
};

/**
 * Format a tool label for display based on tool name and arguments.
 */
function formatToolLabel(toolName: string, args: Record<string, any>): string {
	switch (toolName) {
		case "bash":
			return `$ ${truncate(args.command ?? "", 120)}`;
		case "read":
		case "write":
		case "edit":
			return args.filePath ?? args.file_path ?? toolName;
		case "grep":
			return `${args.pattern ?? ""} ${args.path ?? ""}`.trim();
		case "find":
		case "glob":
			return args.pattern ?? args.glob ?? toolName;
		case "ls":
			return args.path ?? ".";
		default:
			return toolName;
	}
}

function truncate(s: string, max: number): string {
	// Take first line only
	const firstLine = s.split("\n")[0] ?? s;
	if (firstLine.length <= max) return firstLine;
	return firstLine.slice(0, max - 1) + "…";
}

export default function streamExtension(pi: ExtensionAPI) {
	pi.registerFlag("stream", {
		type: "boolean",
		description: "Stream thinking, tool calls, and text to terminal",
	});

	let inThinking = false;

	pi.on("message_update", async (event) => {
		if (!pi.getFlag("stream")) return;

		const e = event.assistantMessageEvent;

		switch (e.type) {
			case "thinking_start":
				inThinking = true;
				break;

			case "thinking_delta":
				process.stderr.write(ansi.dim(ansi.italic(e.delta)));
				break;

			case "thinking_end":
				if (inThinking) {
					process.stderr.write("\n");
					inThinking = false;
				}
				break;

			case "text_delta":
				process.stderr.write(ansi.blue(e.delta));
				break;

			case "text_end":
				process.stderr.write("\n");
				break;
		}
	});

	pi.on("tool_execution_start", async (event) => {
		if (!pi.getFlag("stream")) return;

		const label = formatToolLabel(event.toolName, event.args ?? {});
		process.stderr.write(ansi.cyan(`[${label}]`) + "\n");
	});

	pi.on("tool_execution_end", async (event) => {
		if (!pi.getFlag("stream")) return;

		if (event.isError) {
			const errMsg = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
			process.stderr.write(ansi.red(`[error] ${truncate(errMsg, 200)}`) + "\n");
		}
	});
}
