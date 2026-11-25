import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const MAX_STASH = 20;
const OPTCHAT_EVENT = "optchat:compaction";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type OptchatBannerState =
	| { kind: "idle" }
	| { kind: "compacting"; text: string }
	| { kind: "done"; text: string };

interface StashEntry {
	text: string;
	createdAt: number;
}

function stashDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "prompt-stash");
}

function stashPathForSession(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "default";
	return path.join(stashDir(), `${safe}.json`);
}

function loadSessionStash(sessionId: string): StashEntry[] {
	try {
		const file = stashPathForSession(sessionId);
		if (!existsSync(file)) return [];
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(raw)) return [];
		const out: StashEntry[] = [];
		for (const item of raw) {
			if (item && typeof item.text === "string" && item.text.trim()) {
				out.push({
					text: item.text,
					createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
				});
			}
		}
		return out.slice(-MAX_STASH);
	} catch {
		return [];
	}
}

function saveSessionStash(sessionId: string | undefined, stack: StashEntry[]): void {
	if (!sessionId) return;
	try {
		const file = stashPathForSession(sessionId);
		if (stack.length === 0) {
			if (existsSync(file)) unlinkSync(file);
			return;
		}
		mkdirSync(stashDir(), { recursive: true });
		writeFileSync(file, JSON.stringify(stack, null, 2), "utf8");
	} catch {
		// ignore persistence errors
	}
}

function oneLine(s: string, max = 80): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1)}…`;
}

function relativeTime(ts: number): string {
	const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (secs < 10) return "now";
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	return `${Math.floor(hrs / 24)}d`;
}

export default function promptStashExtension(pi: ExtensionAPI) {
	let stack: StashEntry[] = [];
	let currentSessionId: string | undefined;
	let unsubInput: (() => void) | undefined;
	let requestRender: (() => void) | undefined;
	let optchatState: OptchatBannerState = { kind: "idle" };
	let spinnerFrame = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let pickerOpen = false;

	function persist() {
		saveSessionStash(currentSessionId, stack);
	}

	function triggerRender() {
		requestRender?.();
	}

	function syncSpinner(active: boolean) {
		if (active && !spinnerTimer) {
			spinnerTimer = setInterval(() => {
				spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
				triggerRender();
			}, 90);
			spinnerTimer.unref?.();
		} else if (!active && spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	}

	// Listen for OptChat compaction state so we can embed it natively in the prompt box border
	pi.events.on(OPTCHAT_EVENT, (payload: unknown) => {
		const next = (payload as OptchatBannerState | undefined) ?? { kind: "idle" };
		optchatState = next;
		syncSpinner(next.kind === "compacting");
		triggerRender();
	});

	function mountEditor(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			requestRender = () => tui.requestRender();

			class NativePromptEditor extends CustomEditor {
				private activeIndicator: {
					kind?: string;
					renderSpinnerInBorder?: (width: number) => string;
					renderInBorder?: (width: number) => string;
				} | undefined;

				override setWorkingStatusIndicator(indicator: any): void {
					this.activeIndicator = indicator;
					super.setWorkingStatusIndicator(indicator);
				}

				private buildRightBadge(maxWidth: number): string {
					const uiTheme = ctx.ui.theme;
					const count = stack.length;
					if (count === 0) return "";
					const full = ` ${uiTheme.fg("accent", "≡")} ${uiTheme.fg("muted", `${count} stashed`)} ${uiTheme.fg("dim", "· alt+s")} `;
					if (visibleWidth(full) <= maxWidth) return full;
					const compact = ` ${uiTheme.fg("accent", "≡")} ${uiTheme.fg("muted", String(count))} `;
					if (visibleWidth(compact) <= maxWidth) return compact;
					return "";
				}

				private buildLeftStatus(maxWidth: number): string {
					const uiTheme = ctx.ui.theme;
					// For retry/compaction/branchSummary (non-working indicators), keep Pi's helpful status text in border
					if (this.activeIndicator && this.activeIndicator.kind && this.activeIndicator.kind !== "working") {
						const s = this.activeIndicator.renderInBorder?.(maxWidth) ?? "";
						if (visibleWidth(s) > 0) return ` ${s} `;
					}
					// Otherwise show OptChat compaction status cleanly embedded in the top border
					if (optchatState.kind === "compacting") {
						const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
						const full = ` ${uiTheme.fg("warning", frame)} ${uiTheme.fg("dim", optchatState.text)} `;
						if (visibleWidth(full) <= maxWidth) return full;
						const short = ` ${uiTheme.fg("warning", frame)} ${uiTheme.fg("dim", "compacting")} `;
						if (visibleWidth(short) <= maxWidth) return short;
					} else if (optchatState.kind === "done") {
						const full = ` ${uiTheme.fg("success", "✓")} ${uiTheme.fg("dim", optchatState.text)} `;
						if (visibleWidth(full) <= maxWidth) return full;
					}
					return "";
				}

				override renderTopBorder(width: number, hiddenLineCount: number): string {
					if (width <= 0) return "";

					const overflow = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : "";
					const overflowW = visibleWidth(overflow);

					// Right badge (stash count)
					const rightCapW = 2;
					const leftCapW = 2;
					const rightBadge = this.buildRightBadge(Math.max(0, width - leftCapW - rightCapW - 12));
					const rightBadgeW = visibleWidth(rightBadge);

					// Left badge (OptChat compaction or retry/compaction status — never "Working...")
					const maxLeftW = Math.max(0, width - leftCapW - rightCapW - rightBadgeW - (overflowW ? overflowW + 2 : 0) - 2);
					const leftBadge = this.buildLeftStatus(maxLeftW);
					const leftBadgeW = visibleWidth(leftBadge);

					if (leftBadgeW === 0 && rightBadgeW === 0) {
						if (overflowW > 0 && overflowW + 4 <= width) {
							const side = Math.floor((width - overflowW) / 2);
							const rem = width - side - overflowW;
							return this.borderColor(`${"─".repeat(side)}${overflow}${"─".repeat(rem)}`);
						}
						return this.borderColor("─".repeat(width));
					}

					const leftPart = leftBadgeW > 0 ? this.borderColor("──") + leftBadge : "";
					const rightPart = rightBadgeW > 0 ? rightBadge + this.borderColor("──") : "";
					const used = (leftBadgeW > 0 ? leftCapW + leftBadgeW : 0) + (rightBadgeW > 0 ? rightBadgeW + rightCapW : 0);
					const middleW = Math.max(0, width - used);

					let middle: string;
					if (overflowW > 0 && overflowW + 2 <= middleW) {
						const l = Math.floor((middleW - overflowW) / 2);
						const r = middleW - l - overflowW;
						middle = this.borderColor(`${"─".repeat(l)}${overflow}${"─".repeat(r)}`);
					} else {
						middle = this.borderColor("─".repeat(middleW));
					}

					return leftPart + middle + rightPart;
				}

				override render(width: number): string[] {
					const uiTheme = ctx.ui.theme;
					const hasLoadingSpinner = Boolean(this.activeIndicator?.renderSpinnerInBorder);
					// When idle and typing a shell command (`!` / `!!`), omit the `>` gutter so the prompt is just `!`
					const isBashPrompt = !hasLoadingSpinner && this.getText().trimStart().startsWith("!");

					if (isBashPrompt) {
						const lines = super.render(width);
						if (lines.length < 3) return lines;
						const scrollOff = (this as any).scrollOffset ?? 0;
						lines[0] = this.renderTopBorder(width, scrollOff);
						return lines;
					}

					// Reserve 2 columns on the left of the text area for the native prompt glyph (">" or spinner)
					const innerWidth = Math.max(1, width - 2);
					const lines = super.render(innerWidth);
					if (lines.length < 3) return lines;

					const visibleCount = (this as any).renderedVisibleLineCount ?? 1;
					const scrollOff = (this as any).scrollOffset ?? 0;
					const totalLines = lines.length;
					const bottomBorderIdx = 1 + visibleCount;

					// Rebuild top border at full width
					lines[0] = this.renderTopBorder(width, scrollOff);

					// Choose the prompt gutter glyph: live spinner when working/loading, clean ">" when idle
					let glyph: string;
					if (hasLoadingSpinner) {
						const rawSpinner = this.activeIndicator!.renderSpinnerInBorder!(1);
						glyph = visibleWidth(rawSpinner) > 0 ? rawSpinner : uiTheme.fg("accent", "⠋");
					} else {
						glyph = uiTheme.fg("accent", ">");
					}

					// Prefix prompt lines: glyph on first visible line, 2-space indent on continuation lines
					for (let i = 1; i < bottomBorderIdx && i < totalLines; i++) {
						const prefix = i === 1 ? `${glyph} ` : "  ";
						lines[i] = prefix + lines[i];
					}

					// Rebuild bottom border at full width
					if (bottomBorderIdx < totalLines) {
						const bottomW = visibleWidth(lines[bottomBorderIdx]);
						if (bottomW < width) {
							lines[bottomBorderIdx] = lines[bottomBorderIdx] + this.borderColor("─".repeat(width - bottomW));
						}
					}

					// Indent autocomplete dropdown lines by 2 spaces so they align with the text
					for (let i = bottomBorderIdx + 1; i < totalLines; i++) {
						lines[i] = "  " + lines[i];
					}

					return lines;
				}
			}

			return new NativePromptEditor(tui, editorTheme, keybindings, {
				embedWorkingStatus: true,
			});
		});
	}

	function pushStash(text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed) return false;
		if (stack[stack.length - 1]?.text !== text) {
			stack.push({ text, createdAt: Date.now() });
			if (stack.length > MAX_STASH) stack.shift();
		}
		persist();
		triggerRender();
		return true;
	}

	function restoreAt(ctx: ExtensionContext, stackIdx: number) {
		if (stackIdx < 0 || stackIdx >= stack.length) return;
		const [picked] = stack.splice(stackIdx, 1);
		const current = ctx.ui.getEditorText();
		if (current.trim()) {
			stack.push({ text: current, createdAt: Date.now() });
			if (stack.length > MAX_STASH) stack.shift();
		}
		persist();
		ctx.ui.setEditorText(picked.text);
		triggerRender();
	}

	function popStash(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (stack.length === 0) {
			ctx.ui.notify("Stash is empty", "info");
			return;
		}
		restoreAt(ctx, stack.length - 1);
	}

	async function openStashPicker(ctx: ExtensionContext) {
		if (!ctx.hasUI || pickerOpen) return;
		if (stack.length === 0) {
			ctx.ui.notify("Prompt stash is empty (Ctrl+C or Alt+S stashes your draft)", "info");
			return;
		}
		pickerOpen = true;
		let pickedStackIdx: number | undefined;
		try {
			// NOTE: Pi's ctx.ui.custom() snapshots the editor text before opening and
			// restores that snapshot when done() closes the dialog. So we must return
			// the selected index from custom() and call restoreAt() AFTER it resolves.
			pickedStackIdx = await ctx.ui.custom<number | undefined>((tui, theme, _kb, done) => {
				let selected = 0; // index into newest-first list
				let cachedLines: string[] | undefined;

				const invalidate = () => {
					cachedLines = undefined;
				};
				const refresh = () => {
					invalidate();
					tui.requestRender();
				};

				const clampSelected = () => {
					if (stack.length === 0) {
						selected = 0;
					} else if (selected >= stack.length) {
						selected = stack.length - 1;
					} else if (selected < 0) {
						selected = 0;
					}
				};

				const toStackIdx = (displayIdx: number) => stack.length - 1 - displayIdx;

				const handleInput = (data: string) => {
					if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, "alt+s")) {
						done(undefined);
						return;
					}
					if (stack.length === 0) {
						done(undefined);
						return;
					}
					if (matchesKey(data, Key.up) || data === "k") {
						selected = (selected - 1 + stack.length) % stack.length;
						refresh();
						return;
					}
					if (matchesKey(data, Key.down) || data === "j") {
						selected = (selected + 1) % stack.length;
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter) || data === "\r" || data === "\n" || data === " ") {
						done(toStackIdx(selected));
						return;
					}
					// Delete selected entry (d / x / Backspace / Delete)
					if (data === "d" || data === "x" || matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
						const idx = toStackIdx(selected);
						stack.splice(idx, 1);
						persist();
						clampSelected();
						triggerRender();
						if (stack.length === 0) {
							done(undefined);
							return;
						}
						refresh();
						return;
					}
					// Clear all (C)
					if (data === "C") {
						stack.length = 0;
						persist();
						triggerRender();
						done(undefined);
						return;
					}
					// Quick-pick 1-9
					if (data >= "1" && data <= "9") {
						const num = Number(data) - 1;
						if (num < stack.length) {
							done(toStackIdx(num));
							return;
						}
					}
				};

				const render = (width: number): string[] => {
					if (cachedLines) return cachedLines;
					const rule = theme.fg("borderMuted", "─".repeat(width));
					const lines: string[] = [rule];
					const add = (s = "") => lines.push(truncateToWidth(s, width));

					const countLabel = `${stack.length} ${stack.length === 1 ? "draft" : "drafts"}`;
					add(`  ${theme.fg("accent", "≡")} ${theme.fg("text", theme.bold("Stashed prompts"))}  ${theme.fg("dim", countLabel)}`);
					add();

					const newestFirst = [...stack].reverse();
					const maxVisible = 8;
					const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), newestFirst.length - maxVisible));
					const end = Math.min(newestFirst.length, start + maxVisible);

					if (start > 0) {
						add(`    ${theme.fg("dim", `↑ ${start} more`)}`);
					}

					for (let i = start; i < end; i++) {
						const entry = newestFirst[i];
						const isSel = i === selected;
						const num = i < 9 ? `${i + 1}` : " ";
						const age = relativeTime(entry.createdAt);
						const lineCount = entry.text.split("\n").length;
						const meta = lineCount > 1 ? `${lineCount}L · ${age}` : age;
						const metaStr = theme.fg("dim", meta);
						const prefixW = 6; // "  › 1 "
						const metaW = visibleWidth(meta) + 2;
						const previewMax = Math.max(16, width - prefixW - metaW - 2);
						const preview = oneLine(entry.text, previewMax);

						const marker = isSel ? theme.fg("accent", "›") : " ";
						const numStr = isSel ? theme.fg("accent", num) : theme.fg("dim", num);
						const textStr = isSel ? theme.fg("text", preview) : theme.fg("muted", preview);
						const left = `  ${marker} ${numStr} ${textStr}`;
						const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(metaStr) - 2);
						add(`${left}${" ".repeat(pad)}${metaStr}`);
					}

					if (end < newestFirst.length) {
						add(`    ${theme.fg("dim", `↓ ${newestFirst.length - end} more`)}`);
					}

					// Multi-line preview of the currently highlighted stash entry
					const active = newestFirst[selected];
					if (active) {
						add();
						const previewLines = wrapTextWithAnsi(active.text.trim(), Math.max(20, width - 6));
						const shown = previewLines.slice(0, 4);
						for (const pl of shown) {
							add(`  ${theme.fg("borderMuted", "│")} ${theme.fg("muted", pl)}`);
						}
						if (previewLines.length > 4) {
							add(`  ${theme.fg("borderMuted", "│")} ${theme.fg("dim", `… +${previewLines.length - 4} more lines`)}`);
						}
					}

					add();
					add(
						`  ${theme.fg(
							"dim",
							"↑/↓ or j/k move  ·  enter/1-9 restore  ·  d delete  ·  C clear all  ·  esc close",
						)}`,
					);
					lines.push(rule);
					cachedLines = lines;
					return lines;
				};

				return {
					render,
					invalidate,
					handleInput,
				};
			});
		} finally {
			pickerOpen = false;
		}

		if (pickedStackIdx !== undefined) {
			restoreAt(ctx, pickedStackIdx);
		} else {
			triggerRender();
		}
	}

	function bindCtrlC(ctx: ExtensionContext) {
		unsubInput?.();
		unsubInput = undefined;
		if (!ctx.hasUI) return;
		unsubInput = ctx.ui.onTerminalInput((data) => {
			if (data === "\x03" || matchesKey(data, "ctrl+c")) {
				const text = ctx.ui.getEditorText();
				if (text && text.trim().length > 0) {
					pushStash(text);
				}
			}
			return undefined;
		});
	}

	pi.on("session_start", (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		stack = loadSessionStash(currentSessionId);
		if (ctx.hasUI) ctx.ui.setWidget("prompt-stash", undefined);
		bindCtrlC(ctx);
		mountEditor(ctx);
		triggerRender();
	});

	pi.on("session_shutdown", () => {
		persist();
		unsubInput?.();
		unsubInput = undefined;
		syncSpinner(false);
		requestRender = undefined;
	});

	pi.registerShortcut("alt+s", {
		description: "Stash current draft, or pick from stashed prompts",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const current = ctx.ui.getEditorText();
			if (current.trim()) {
				pushStash(current);
				ctx.ui.setEditorText("");
				return;
			}
			if (stack.length === 0) {
				ctx.ui.notify("Nothing to stash or restore", "info");
				return;
			}
			if (stack.length === 1) {
				popStash(ctx);
				return;
			}
			await openStashPicker(ctx);
		},
	});

	pi.registerCommand("stash", {
		description: "Open stash picker, or: /stash pop | push | clear",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "pop") {
				popStash(ctx);
				return;
			}
			if (sub === "clear") {
				stack.length = 0;
				persist();
				triggerRender();
				ctx.ui.notify("Prompt stash cleared", "info");
				return;
			}
			if (sub === "push" || sub === "save") {
				const current = ctx.ui.getEditorText();
				if (pushStash(current)) {
					ctx.ui.setEditorText("");
				} else {
					ctx.ui.notify("Editor is empty", "info");
				}
				return;
			}
			await openStashPicker(ctx);
		},
	});
}
