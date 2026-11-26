import type {
	ExtensionAPI,
	ToolRenderResultOptions,
	ToolRenderer,
	ToolResultRendererContext,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Single-line-per-entry text component that truncates each line to the actual
 * rendered width (instead of hard-wrapping onto multiple lines on narrow screens).
 */
class SingleLineList implements Component {
	private lines: string[];
	private ellipsis: string;
	private cache?: { width: number; rendered: string[] };

	constructor(lines: string[], ellipsis = "…") {
		this.lines = lines;
		this.ellipsis = ellipsis;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache && this.cache.width === width) return this.cache.rendered;
		const w = Math.max(1, width);
		const rendered = this.lines.map((line) => truncateToWidth(line, w, this.ellipsis));
		this.cache = { width, rendered };
		return rendered;
	}
}

type NestedCall = {
	name: string;
	args?: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	cost?: number;
	error?: string;
};

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function formatDuration(ms?: number): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function shortHome(s: string): string {
	const home = process.env.HOME;
	if (!home) return s;
	return s.split(home).join("~");
}

function oneLine(s: string, max = 96): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1)}…`;
}

function statusIcon(status: NestedCall["status"], theme: any): string {
	switch (status) {
		case "running":
			return theme.fg("warning", "◐");
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
	}
}

function summarizeArgs(toolName: string, args: any, max = 88): string {
	if (!args || typeof args !== "object") return "";
	if (typeof args.path === "string") {
		const p = shortHome(args.path);
		if (typeof args.offset === "number") {
			const end = typeof args.limit === "number" ? `-${args.offset + args.limit - 1}` : "+";
			return oneLine(`${p}:${args.offset}${end}`, max);
		}
		return oneLine(p, max);
	}
	if (typeof args.command === "string") return oneLine(shortHome(args.command), max);
	if (typeof args.query === "string") return oneLine(args.query, max);
	if (typeof args.url === "string") return oneLine(args.url, max);
	if (Array.isArray(args.questions)) {
		const n = args.questions.length;
		const first = args.questions[0]?.question ? oneLine(String(args.questions[0].question), 64) : "";
		return `${n} question${n === 1 ? "" : "s"}${first ? ` · ${first}` : ""}`;
	}
	if (typeof args.name === "string") return oneLine(args.name, 64);
	if (typeof args.message === "string") return oneLine(args.message, 64);
	if (typeof args.text === "string") return oneLine(args.text, 64);
	const keys = Object.keys(args).filter((k) => args[k] !== undefined);
	if (keys.length === 0) return "";
	const firstVal = args[keys[0]];
	if (typeof firstVal === "string") return oneLine(`${keys[0]}=${shortHome(firstVal)}`, max);
	return `(${keys.slice(0, 3).join(", ")})`;
}

function formatNestedArgs(toolName: string, rawArgs: string | undefined, max: number): string {
	if (!rawArgs) return "";
	const trimmed = rawArgs.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			const summary = summarizeArgs(toolName, parsed, max);
			if (summary) return summary;
		} catch {
			// Partial/truncated JSON from pi's nested call summary — extract common fields cleanly
			const cmdMatch = trimmed.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)/);
			if (cmdMatch) {
				const cleaned = cmdMatch[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
				return oneLine(shortHome(cleaned), max);
			}
			const pathMatch = trimmed.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)/);
			if (pathMatch) return oneLine(shortHome(pathMatch[1]), max);
		}
	}
	return oneLine(shortHome(trimmed), max);
}

function extractText(result: any): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	const parts: string[] = [];
	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		if (i === 0 && SCRIPT_HEADER.test(block.text)) continue;
		parts.push(block.text);
	}
	return parts.join("\n").trim();
}

function formatExecutorCall(
	call: NestedCall,
	theme: any,
	live: boolean,
): { label: string; detail: string } | null {
	if (!call.name.startsWith("mcp__executor__")) return null;
	const op = call.name.slice("mcp__executor__".length);
	const raw = (call.args ?? "").trim();

	// Unescape a JSON string snippet (possibly truncated)
	const unescapeJson = (s: string) =>
		s.replace(/\\n/g, "\n").replace(/\\t/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");

	if (op === "execute") {
		const codeMatch = raw.match(/"code"\s*:\s*"((?:[^"\\]|\\.)*)/);
		const code = codeMatch ? unescapeJson(codeMatch[1]) : raw;

		// Extract all `tools.<namespace>.<method>` calls in order (deduped)
		const toolPaths: string[] = [];
		for (const m of code.matchAll(/\btools\.([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\s*\(/g)) {
			if (!toolPaths.includes(m[1])) toolPaths.push(m[1]);
		}

		// Extract helpful scalar params (action, query, artifactId, session_id, status, path, title, app)
		const hints: string[] = [];
		const addHint = (key: string, re: RegExp) => {
			const m = code.match(re);
			if (m && m[1]) {
				const v = m[1].trim();
				if (v && !hints.includes(v)) hints.push(key ? `${key}=${v}` : v);
			}
		};
		addHint("", /\baction\s*:\s*["'`]([^"'`]{1,32})["'`]/);
		addHint("", /\bquery\s*:\s*["'`]([^"'`]{1,48})["'`]/);
		addHint("", /\bapp\s*:\s*["'`]([^"'`]{1,32})["'`]/);
		addHint("", /\btitle\s*:\s*["'`]([^"'`]{1,40})["'`]/);

		if (toolPaths.length > 0) {
			const primary = toolPaths.length === 1 ? toolPaths[0] : `${toolPaths[0]} +${toolPaths.length - 1}`;
			return {
				label: `executor ${primary}`,
				detail: oneLine(hints.join(" · "), live ? 72 : 64),
			};
		}
		return {
			label: "executor execute",
			detail: oneLine(code, live ? 84 : 72),
		};
	}

	if (op === "search") {
		const q = raw.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)/);
		return {
			label: "executor search",
			detail: q ? oneLine(unescapeJson(q[1]), live ? 84 : 72) : formatNestedArgs(call.name, call.args, 72),
		};
	}

	if (op === "describe") {
		const paths: string[] = [];
		for (const m of raw.matchAll(/"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)"/g)) {
			paths.push(m[1]);
		}
		return {
			label: "executor describe",
			detail: paths.length > 0 ? oneLine(paths.join(", "), live ? 84 : 72) : formatNestedArgs(call.name, call.args, 72),
		};
	}

	if (op === "skills") {
		const q = raw.match(/"(?:query|name|app)"\s*:\s*"((?:[^"\\]|\\.)*)/);
		return {
			label: "executor skills",
			detail: q ? oneLine(unescapeJson(q[1]), 64) : "",
		};
	}

	if (op === "call") {
		const p = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)/);
		return {
			label: p ? `executor ${unescapeJson(p[1])}` : "executor call",
			detail: "",
		};
	}

	return {
		label: `executor ${op}`,
		detail: formatNestedArgs(call.name, call.args, live ? 84 : 72),
	};
}

function formatNestedCallLine(
	call: NestedCall,
	theme: any,
	live: boolean,
	repeatCount = 1,
	totalDurationMs?: number,
): string {
	const icon = statusIcon(call.status, theme);
	const exec = formatExecutorCall(call, theme, live);
	const displayName = exec ? exec.label : call.name;
	const cleanArgs = exec ? exec.detail : formatNestedArgs(call.name, call.args, live ? 96 : 84);

	const name = theme.fg(call.status === "error" ? "error" : "toolTitle", displayName);
	const argText = cleanArgs ? ` ${theme.fg("muted", cleanArgs)}` : "";
	const countBadge = repeatCount > 1 ? ` ${theme.fg("accent", `×${repeatCount}`)}` : "";
	const durVal = totalDurationMs ?? call.durationMs;
	const dur = durVal !== undefined ? ` ${theme.fg("dim", formatDuration(durVal))}` : "";
	const cost = call.cost ? ` ${theme.fg("dim", formatCost(call.cost))}` : "";
	let line = `  ${icon} ${name}${argText}${countBadge}${dur}${cost}`;
	if (call.status === "error" && call.error) {
		line += `\n      ${theme.fg("error", oneLine(call.error, 120))}`;
	}
	return line;
}

function formatNestedCalls(calls: NestedCall[], theme: any, live: boolean): string[] {
	const lines: string[] = [];
	let i = 0;
	while (i < calls.length) {
		const cur = calls[i];
		const exec = formatExecutorCall(cur, theme, live);
		const key = `${cur.status}|${exec ? `${exec.label}|${exec.detail}` : `${cur.name}|${formatNestedArgs(cur.name, cur.args, live ? 96 : 84)}`}`;
		let j = i + 1;
		let totalDur = cur.durationMs ?? 0;
		let hasDur = cur.durationMs !== undefined;
		// Only collapse consecutive identical finished ok calls (never collapse running or error calls)
		if (cur.status === "ok") {
			while (j < calls.length) {
				const next = calls[j];
				if (next.status !== "ok") break;
				const nextExec = formatExecutorCall(next, theme, live);
				const nextKey = `${next.status}|${nextExec ? `${nextExec.label}|${nextExec.detail}` : `${next.name}|${formatNestedArgs(next.name, next.args, live ? 96 : 84)}`}`;
				if (nextKey !== key) break;
				if (next.durationMs !== undefined) {
					totalDur += next.durationMs;
					hasDur = true;
				}
				j++;
			}
		}
		const count = j - i;
		lines.push(formatNestedCallLine(cur, theme, live, count, count > 1 && hasDur ? totalDur : undefined));
		i = j;
	}
	return lines;
}

function expandedBgFn(theme: any, isError: boolean, isPending: boolean): (text: string) => string {
	const color = isPending ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";
	return (text: string) => theme.bg(color, text);
}

function wrapExpanded(child: any, theme: any, isError: boolean, isPending: boolean): Box {
	const box = new Box(1, 0, expandedBgFn(theme, isError, isPending));
	box.addChild(child);
	return box;
}

function renderExpandedFallbackCall(toolName: string, args: any, theme: any, context: any, fallback?: ToolRenderer): Box {
	const isPending = Boolean(context.isPartial || !context.argsComplete);
	if (fallback?.renderCall) {
		const inner = fallback.renderCall(args, theme, { ...context, lastComponent: undefined });
		return wrapExpanded(inner, theme, Boolean(context.isError), isPending);
	}
	const argSummary = summarizeArgs(toolName, args, 200);
	const header = new Text(
		`${theme.fg("accent", "▾")} ${theme.fg("toolTitle", theme.bold(toolName))}${argSummary ? ` ${theme.fg("muted", argSummary)}` : ""}`,
		0,
		0,
	);
	return wrapExpanded(header, theme, Boolean(context.isError), isPending);
}

function renderExpandedFallbackResult(
	result: any,
	options: ToolRenderResultOptions,
	theme: any,
	context: ToolResultRendererContext,
	fallback?: ToolRenderer,
): Box {
	const isPending = Boolean(options.isPartial);
	if (fallback?.renderResult) {
		const inner = fallback.renderResult(result, options, theme, { ...context, lastComponent: undefined });
		return wrapExpanded(inner, theme, Boolean(context.isError), isPending);
	}
	const output = extractText(result);
	const body = output
		? theme.fg(context.isError ? "error" : "toolOutput", output)
		: theme.fg("dim", "(no output)");
	return wrapExpanded(new Text(body, 0, 0), theme, Boolean(context.isError), isPending);
}

function buildCodemodeRenderer(fallback: ToolRenderer | undefined): ToolRenderer {
	return {
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (context.expanded) {
				return renderExpandedFallbackCall("codemode", args, theme, context, fallback);
			}
			const component =
				context.lastComponent instanceof Container && !(context.lastComponent instanceof Box)
					? context.lastComponent
					: new Container();
			component.clear();

			// Never dump raw JS code in collapsed mode — only show a tiny status while streaming args
			// before nested tool calls appear. Ctrl+O / click still expands the full script.
			if (!context.argsComplete) {
				component.addChild(
					new SingleLineList(
						[`  ${theme.fg("warning", "◐")} ${theme.fg("muted", "preparing tools…")}`],
						theme.fg("dim", "…"),
					),
				);
			} else if (context.isPartial && !context.state?.hasNestedCalls) {
				component.addChild(
					new SingleLineList(
						[`  ${theme.fg("warning", "◐")} ${theme.fg("muted", "running…")}`],
						theme.fg("dim", "…"),
					),
				);
			}
			return component;
		},

		renderResult(result: any, options: ToolRenderResultOptions, theme: any, context: ToolResultRendererContext) {
			if (options.expanded) {
				return renderExpandedFallbackResult(result, options, theme, context, fallback);
			}
			const component =
				context.lastComponent instanceof Container && !(context.lastComponent instanceof Box)
					? context.lastComponent
					: new Container();
			component.clear();

			const calls: NestedCall[] = Array.isArray(result?.details?.calls) ? result.details.calls : [];
			if (context.state && calls.length > 0) {
				context.state.hasNestedCalls = true;
			}
			const output = options.isPartial ? "" : extractText(result);
			const outLines = output ? output.split("\n") : [];
			const ell = theme.fg("dim", "…");

			if (options.isPartial) {
				if (calls.length > 0) {
					const lines = formatNestedCalls(calls, theme, true).flatMap((l) => l.split("\n"));
					component.addChild(new SingleLineList(lines, ell));
				}
				return component;
			}

			if (calls.length > 0) {
				const lines = formatNestedCalls(calls, theme, false).flatMap((l) => l.split("\n"));
				if (context.isError && output) {
					for (const l of outLines.slice(-3)) {
						lines.push(`    ${theme.fg("error", oneLine(l, 120))}`);
					}
				}
				component.addChild(new SingleLineList(lines, ell));
				return component;
			}

			const icon = context.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const summary = context.isError
				? theme.fg("error", oneLine(output || "script failed", 100))
				: outLines.length === 0
					? theme.fg("dim", "done")
					: outLines.length === 1
						? theme.fg("muted", oneLine(outLines[0], 96))
						: theme.fg("dim", `${outLines.length} lines`);
			component.addChild(
				new SingleLineList([`  ${icon} ${theme.fg("toolTitle", "codemode")} ${summary}`], ell),
			);
			return component;
		},
	};
}

function buildAskQuestionsRenderer(fallback: ToolRenderer | undefined): ToolRenderer {
	return {
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (context.expanded) {
				return renderExpandedFallbackCall("ask_questions", args, theme, context, fallback);
			}
			const component =
				context.lastComponent instanceof Container && !(context.lastComponent instanceof Box)
					? context.lastComponent
					: new Container();
			component.clear();
			const isRunning = context.isPartial || !context.argsComplete;
			if (!isRunning) return component;
			const summary = summarizeArgs("ask_questions", args);
			component.addChild(
				new SingleLineList(
					[`  ${theme.fg("accent", "?")} ${theme.fg("toolTitle", theme.bold("questions"))} ${theme.fg("muted", summary)}`],
					theme.fg("dim", "…"),
				),
			);
			return component;
		},
		renderResult(result: any, options: ToolRenderResultOptions, theme: any, context: ToolResultRendererContext) {
			if (options.expanded) {
				return renderExpandedFallbackResult(result, options, theme, context, fallback);
			}
			const component =
				context.lastComponent instanceof Container && !(context.lastComponent instanceof Box)
					? context.lastComponent
					: new Container();
			component.clear();
			const details = result?.details as
				| {
						status?: string;
						answers?: Array<{ header: string; question: string; answer: string }>;
				  }
				| undefined;
			if (!details) return component;
			const ell = theme.fg("dim", "…");
			if (details.status === "cancelled") {
				component.addChild(
					new SingleLineList([`  ${theme.fg("warning", "⊘")} ${theme.fg("muted", "questions cancelled")}`], ell),
				);
				return component;
			}
			if (details.status === "unavailable") {
				component.addChild(
					new SingleLineList([`  ${theme.fg("warning", "!")} ${theme.fg("muted", "questions UI unavailable")}`], ell),
				);
				return component;
			}
			const answers = details.answers ?? [];
			if (answers.length === 0) return component;
			const lines = answers.map(
				(a) =>
					`  ${theme.fg("success", "✓")} ${theme.fg("muted", `${a.header}:`)} ${theme.fg("text", a.answer)}`,
			);
			component.addChild(new SingleLineList(lines, ell));
			return component;
		},
	};
}

function buildGenericCompactRenderer(toolName: string, fallback: ToolRenderer | undefined): ToolRenderer {
	return {
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (context.expanded) {
				return renderExpandedFallbackCall(toolName, args, theme, context, fallback);
			}
			const component =
				context.lastComponent instanceof Container && !(context.lastComponent instanceof Box)
					? context.lastComponent
					: new Container();
			component.clear();
			const isRunning = context.isPartial || !context.argsComplete;
			if (!isRunning) return component;
			const argSummary = summarizeArgs(toolName, args);
			component.addChild(
				new SingleLineList(
					[
						`  ${theme.fg("warning", "◐")} ${theme.fg("toolTitle", toolName)}${argSummary ? ` ${theme.fg("muted", argSummary)}` : ""}`,
					],
					theme.fg("dim", "…"),
				),
			);
			return component;
		},
		renderResult(result: any, options: ToolRenderResultOptions, theme: any, context: ToolResultRendererContext) {
			if (options.expanded) {
				return renderExpandedFallbackResult(result, options, theme, context, fallback);
			}
			const component =
				context.lastComponent instanceof Container && !(context.lastComponent instanceof Box)
					? context.lastComponent
					: new Container();
			component.clear();

			const output = extractText(result);
			const outLines = output ? output.split("\n") : [];
			const ell = theme.fg("dim", "…");

			if (options.isPartial) {
				if (outLines.length > 0) {
					const tail = outLines
						.slice(-3)
						.map((l) => `    ${theme.fg("dim", oneLine(l, 200))}`);
					component.addChild(new SingleLineList(tail, ell));
				}
				return component;
			}

			const icon = context.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const argSummary = summarizeArgs(toolName, context.args);
			let meta = "";
			if (context.isError && output) {
				meta = ` ${theme.fg("error", oneLine(output, 100))}`;
			} else if (outLines.length === 1 && outLines[0].length <= 64 && !argSummary) {
				meta = ` ${theme.fg("muted", outLines[0])}`;
			}
			component.addChild(
				new SingleLineList(
					[
						`  ${icon} ${theme.fg(context.isError ? "error" : "toolTitle", toolName)}${argSummary ? ` ${theme.fg("muted", argSummary)}` : ""}${meta}`,
					],
					ell,
				),
			);
			return component;
		},
	};
}

function trimWordStart(s: string, max: number): string {
	if (s.length <= max) return s;
	const tail = s.slice(-(max - 1));
	const sp = tail.indexOf(" ");
	return sp > 0 && sp < 24 ? tail.slice(sp + 1).trimStart() : tail.trimStart();
}

function trimWordEnd(s: string, max: number): string {
	if (s.length <= max) return s;
	const head = s.slice(0, max - 1);
	const sp = head.lastIndexOf(" ");
	return sp > max * 0.7 ? head.slice(0, sp).trimEnd() : head.trimEnd();
}

function previewThinking(markdown: string, isStreaming: boolean, availableWidth?: number): string {
	const cleaned = markdown
		.replace(/```[\s\S]*?```/g, "[code]")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "";
	const narrow = typeof availableWidth === "number" && availableWidth > 0 && availableWidth < 70;
	if (isStreaming) {
		// While streaming, show a rolling tail scaled to screen width (~2.5-3 lines on mobile)
		const max = narrow ? Math.max(90, Math.min(180, Math.floor(availableWidth * 2.8))) : 420;
		if (cleaned.length <= max) return `· ${cleaned}`;
		return `· …${trimWordStart(cleaned, max)}`;
	}
	// Once finished, keep a readable ~2-3 line preview broken cleanly at word boundaries
	const max = narrow ? Math.max(80, Math.min(140, Math.floor(availableWidth * 2.2))) : 320;
	if (cleaned.length <= max) return `· ${cleaned}`;
	return `· ${trimWordEnd(cleaned, max)}…`;
}

export default function compactUiExtension(pi: ExtensionAPI) {
	// 1. Truncated preview of all thoughts (live tail while streaming, compact summary when done).
	// Ctrl+T still toggles full hide/show if desired.
	const applyThinkingLabel = (ctx: { hasUI: boolean; ui: { setHiddenThinkingLabel: (label?: string) => void } }) => {
		if (!ctx.hasUI) return;
		ctx.ui.setHiddenThinkingLabel("· thought");
	};
	pi.on("session_start", (_event, ctx) => applyThinkingLabel(ctx));

	pi.registerMarkdownTransformer((markdown, info) => {
		if (info.messageType === "assistant-thinking") {
			return previewThinking(markdown, info.isStreaming, info.availableWidth);
		}
		if (info.messageType === "user") {
			if (!markdown || markdown.startsWith("› ")) return markdown;
			return `› ${markdown}`;
		}
		return markdown;
	});

	// 2. Open while running, auto-close on completion for all tools (ctrl+o / click / /tools still expands).
	pi.registerToolRenderer((toolName, next) => {
		const fallback = next();
		if (toolName === "codemode") return buildCodemodeRenderer(fallback);
		if (toolName === "ask_questions") return buildAskQuestionsRenderer(fallback);
		return buildGenericCompactRenderer(toolName, fallback);
	});

	// 3. /clear alias for /new (start a fresh session).
	pi.registerCommand("clear", {
		description: "Start a new session (alias for /new)",
		handler: async (_args, ctx) => {
			const res = await ctx.newSession();
			if (!res.cancelled && ctx.hasUI) {
				ctx.ui.notify("New session started", "info");
			}
		},
	});

	// 4. /tools slash command alternative for Ctrl+O (toggle expanded tool outputs — mobile-friendly).
	pi.registerCommand("tools", {
		description: "Toggle expanded tool outputs (Ctrl+O alternative; optional: on|off)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const arg = args.trim().toLowerCase();
			const next =
				arg === "on" || arg === "expand" || arg === "show"
					? true
					: arg === "off" || arg === "collapse" || arg === "hide"
						? false
						: !ctx.ui.getToolsExpanded();
			ctx.ui.setToolsExpanded(next);
			ctx.ui.notify(`Tool outputs: ${next ? "expanded" : "collapsed"}`, "info");
		},
	});
}
