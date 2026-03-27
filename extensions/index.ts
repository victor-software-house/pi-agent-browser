/**
 * Pi extension: browser automation via agent-browser CLI.
 *
 * Tool: browser (model-facing, command-string interface)
 * Commands: /browser:doctor, /browser:examples
 *
 * Runtime rules:
 * - All tool calls are serialized via a promise-chain queue (browser state is shared)
 * - Per-Pi-session browser isolation via --session flag
 * - Screenshots returned as ImageContent (base64) for vision models
 * - Output truncated; full output saved to temp file
 * - Browser session closed on Pi session shutdown
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_NAME = "browser";

const TOOL_DESCRIPTION = `Browser automation via agent-browser CLI.

Workflow: open URL -> snapshot -i (get @refs like @e1) -> interact with @refs -> re-snapshot after page changes.

Commands (pass without the 'agent-browser' prefix):
  open <url>              Navigate to URL
  snapshot -i             Interactive elements with @refs (always re-snapshot after navigation or DOM changes)
  click <@ref>            Click element
  fill <@ref> <text>      Clear field and type
  type <@ref> <text>      Type without clearing
  select <@ref> <value>   Select dropdown option
  press <key>             Press key (Enter, Tab, Escape, etc.)
  scroll <dir> [px]       Scroll (up/down/left/right)
  get text|url|title [@ref]  Get page information
  wait <@ref|ms>          Wait for element or milliseconds
  wait --load networkidle Wait for network activity to settle
  screenshot [path]       Take screenshot (returned as inline image)
  screenshot --full       Full-page screenshot
  close                   Close browser

Any valid agent-browser subcommand works. Chain with && for multi-step sequences when intermediate output is not needed.`;

const PROMPT_SNIPPET =
	"Browser automation via agent-browser CLI. Use for web interaction: navigating pages, filling forms, clicking, screenshots, data extraction.";

const PROMPT_GUIDELINES = [
	"Workflow: open URL -> snapshot -i -> interact using @refs -> re-snapshot after DOM changes.",
	"Always re-snapshot after navigation, clicks that change the page, or form submissions.",
	"For screenshots, the image is returned inline so you can describe what you see.",
	"Use 'wait --load networkidle' after opening URLs that load dynamically.",
	"Use 'close' when done to free resources. The browser is also auto-closed when the Pi session ends.",
	"Do NOT run agent-browser commands via the bash tool. Use this browser tool instead.",
];

const BrowserParams = Type.Object({
	command: Type.String({
		description: "agent-browser subcommand (without the 'agent-browser' prefix). E.g. 'open https://example.com'",
	}),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Timeout in milliseconds. Default 30000. Increase for slow pages or large screenshots.",
		}),
	),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTempFile(content: string, label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-browser-${label}-`));
	const file = join(dir, "output.txt");
	writeFileSync(file, content);
	return file;
}

function isScreenshotCommand(command: string): boolean {
	const first = command.trim().split(/\s+/)[0];
	return first === "screenshot";
}

function readScreenshotAsBase64(filePath: string): { data: string; mimeType: string } | null {
	try {
		const buf = readFileSync(filePath);
		const ext = extname(filePath).toLowerCase();
		const mimeMap: Record<string, string> = {
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".webp": "image/webp",
		};
		const mimeType = mimeMap[ext] ?? "image/png";
		return { data: buf.toString("base64"), mimeType };
	} catch {
		return null;
	}
}

function parseRefCount(output: string): number {
	const matches = output.match(/@e\d+/g);
	return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Serialization queue
// ---------------------------------------------------------------------------

/** Serialize all browser tool calls within a Pi session. */
function createQueue(): { enqueue: <T>(fn: () => Promise<T>) => Promise<T> } {
	let chain: Promise<void> = Promise.resolve();
	return {
		enqueue<T>(fn: () => Promise<T>): Promise<T> {
			const next = chain.then(fn, fn);
			// Keep the chain moving regardless of resolve/reject
			chain = next.then(
				() => {},
				() => {},
			);
			return next;
		},
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function browserExtension(pi: ExtensionAPI): void {
	const queue = createQueue();
	let sessionFlag: string | null = null;
	let browserUsed = false;

	function getSessionFlag(ctx: ExtensionContext): string {
		if (sessionFlag) return sessionFlag;
		const id = ctx.sessionManager.getSessionId();
		const short = id.slice(0, 12);
		sessionFlag = `--session pi-${short}`;
		return sessionFlag;
	}

	async function execBrowser(
		command: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<{ stdout: string; stderr: string; code: number }> {
		const sf = getSessionFlag(ctx);
		const fullCommand = `agent-browser ${sf} ${command}`;
		const opts: { timeout: number; signal?: AbortSignal } = { timeout: timeoutMs };
		if (signal) opts.signal = signal;
		const result = await pi.exec("bash", ["-c", fullCommand], opts);
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	}

	// --- Cleanup on shutdown ---
	pi.on("session_shutdown", async () => {
		if (!browserUsed || !sessionFlag) return;
		try {
			pi.exec("bash", ["-c", `agent-browser ${sessionFlag} close`], { timeout: 5000 }).catch(() => {});
		} catch {
			// Best-effort cleanup
		}
	});

	// --- Operator commands ---

	pi.registerCommand("browser:doctor", {
		description: "Check agent-browser installation and browser status",
		handler: async (_args, ctx) => {
			const which = await pi.exec("which", ["agent-browser"], { timeout: 5000 });
			if (which.code !== 0) {
				ctx.ui.notify(
					"agent-browser: NOT FOUND in PATH\nInstall: npm i -g agent-browser && agent-browser install",
					"error",
				);
				return;
			}
			const path = which.stdout.trim();
			const version = await pi.exec("agent-browser", ["--version"], { timeout: 5000 });
			const versionStr = version.code === 0 ? version.stdout.trim() : "unknown";

			const lines = [`agent-browser: ${path}`, `version: ${versionStr}`];

			// Check if Chrome is installed
			const install = await pi.exec("bash", ["-c", "agent-browser install --check 2>&1 || echo 'check-failed'"], {
				timeout: 10000,
			});
			if (install.stdout.includes("check-failed") || install.code !== 0) {
				lines.push("Chrome: run 'agent-browser install' to download");
			} else {
				lines.push("Chrome: OK");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("browser:examples", {
		description: "Show common browser automation workflows",
		handler: async (_args, ctx) => {
			const examples = `Common workflows:

Browse and read:
  browser open https://example.com
  browser snapshot -i
  browser get text @e1
  browser close

Fill a form:
  browser open https://example.com/login
  browser snapshot -i
  browser fill @e1 "user@example.com"
  browser fill @e2 "password"
  browser click @e3
  browser wait --load networkidle
  browser snapshot -i

Take a screenshot:
  browser open https://example.com
  browser wait --load networkidle
  browser screenshot

Connect to running Chrome:
  browser --auto-connect snapshot -i

Dark mode:
  browser --color-scheme dark open https://example.com`;
			ctx.ui.notify(examples, "info");
		},
	});

	// --- The browser tool ---

	pi.registerTool({
		name: TOOL_NAME,
		label: "Browser",
		description: TOOL_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: BrowserParams,

		renderCall(args: { command?: string }, theme) {
			const cmd = args.command ?? "";
			const label = theme.fg("toolTitle", theme.bold("browser "));
			const cmdText = theme.fg("accent", cmd);
			return new Text(`${label}${cmdText}`, 0, 0);
		},

		renderResult(
			result: {
				content?: Array<{ type: string; text?: string }>;
				details?: { action?: string; truncated?: boolean; refCount?: number; screenshotPath?: string; error?: boolean };
				isError?: boolean;
			},
			{ expanded, isPartial },
			theme,
		) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Running..."), 0, 0);
			}

			const details = result.details ?? {};

			// Error
			if (result.isError || details.error) {
				const errorText = result.content?.[0]?.text ?? "Error";
				return new Text(theme.fg("error", errorText), 0, 0);
			}

			const action = details.action ?? "";

			// Screenshot
			if (action === "screenshot") {
				const path = details.screenshotPath ?? "temp";
				return new Text(theme.fg("success", `Screenshot: ${path}`), 0, 0);
			}

			// Snapshot -- show element count
			if (action === "snapshot") {
				const count = details.refCount ?? 0;
				let text = theme.fg("success", `${count} interactive element${count === 1 ? "" : "s"}`);
				if (details.truncated) {
					text += theme.fg("warning", " (truncated)");
				}
				if (expanded) {
					const content = result.content?.[0]?.text ?? "";
					text += `\n${theme.fg("dim", content)}`;
				}
				return new Text(text, 0, 0);
			}

			// Default
			const content = result.content?.[0]?.text ?? "";
			if (expanded) {
				return new Text(theme.fg("dim", content), 0, 0);
			}
			const firstLine = content.split("\n")[0] ?? "(no output)";
			const ellipsis = content.includes("\n") ? "..." : "";
			return new Text(theme.fg("dim", firstLine + ellipsis), 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return queue.enqueue(async () => {
				const command = params.command.trim();
				const timeout = params.timeoutMs ?? 30000;

				if (!command) {
					return {
						content: [{ type: "text" as const, text: "Error: empty command." }],
						details: { error: true },
						isError: true,
					};
				}

				// Check binary exists
				const which = await pi.exec("which", ["agent-browser"], { timeout: 5000 });
				if (which.code !== 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: "agent-browser is not installed. Install with: npm i -g agent-browser && agent-browser install",
							},
						],
						details: { error: true },
						isError: true,
					};
				}

				browserUsed = true;

				// --- Screenshot handling ---
				if (isScreenshotCommand(command)) {
					const screenshotDir = mkdtempSync(join(tmpdir(), "pi-browser-screenshot-"));
					const screenshotPath = join(screenshotDir, "screenshot.png");
					// Inject the path if not already specified
					const hasPath = command
						.trim()
						.split(/\s+/)
						.some((arg) => arg.endsWith(".png") || arg.endsWith(".jpg"));
					const finalCommand = hasPath ? command : `${command} ${screenshotPath}`;

					const result = await execBrowser(finalCommand, ctx, signal, timeout);

					if (result.code !== 0) {
						const errText = result.stderr || result.stdout || `exit code ${result.code}`;
						return {
							content: [{ type: "text" as const, text: `Screenshot failed: ${errText}` }],
							details: { action: "screenshot", error: true },
							isError: true,
						};
					}

					// Determine actual path -- agent-browser may print it
					let actualPath = screenshotPath;
					const printedPath = result.stdout.trim();
					if (printedPath && (printedPath.endsWith(".png") || printedPath.endsWith(".jpg"))) {
						actualPath = printedPath;
					}

					const imageData = readScreenshotAsBase64(actualPath);
					if (imageData) {
						const content: (TextContent | ImageContent)[] = [
							{ type: "image", data: imageData.data, mimeType: imageData.mimeType },
							{ type: "text", text: `Screenshot saved: ${actualPath}` },
						];
						return {
							content,
							details: { action: "screenshot", screenshotPath: actualPath },
						};
					}

					return {
						content: [{ type: "text" as const, text: `Screenshot saved: ${actualPath}` }],
						details: { action: "screenshot", screenshotPath: actualPath },
					};
				}

				// --- Normal command ---
				const result = await execBrowser(command, ctx, signal, timeout);

				if (result.code !== 0) {
					const errText = result.stderr || result.stdout || `exit code ${result.code}`;
					const truncation = truncateHead(errText, {
						maxLines: DEFAULT_MAX_LINES,
						maxBytes: DEFAULT_MAX_BYTES,
					});
					return {
						content: [{ type: "text" as const, text: truncation.content }],
						details: { error: true, truncated: truncation.truncated },
						isError: true,
					};
				}

				const output = result.stdout;
				const action = command.trim().split(/\s+/)[0] ?? "";

				// Truncate output
				const truncation = truncateHead(output, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

				let fullOutputPath: string | undefined;
				if (truncation.truncated) {
					fullOutputPath = writeTempFile(output, action);
				}

				const text = truncation.truncated
					? `${truncation.content}\n\n[Output truncated. Full output: ${fullOutputPath}]`
					: truncation.content;

				const refCount = action === "snapshot" ? parseRefCount(output) : undefined;
				const details = {
					action,
					truncated: truncation.truncated,
					...(refCount !== undefined ? { refCount } : {}),
				};

				return {
					content: [{ type: "text" as const, text }],
					details,
				};
			});
		},
	});
}
