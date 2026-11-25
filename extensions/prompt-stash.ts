import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

const MAX_STASH = 20;
const OPTCHAT_EVENT = "optchat:compaction";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type OptchatBannerState =
	| { kind: "idle" }
	| { kind: "compacting"; text: string }
	| { kind: "done"; text: string };

function oneLine(s: string, max = 80): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1)}…`;
}

export default function promptStashExtension(pi: ExtensionAPI) {
	const stack: string[] = [];
	let unsubInput: (() => void) | undefined;
	let requestRender: (() => void) | undefined;
	let optchatState: OptchatBannerState = { kind: "idle" };
	let spinnerFrame = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;

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
					const full = ` ${uiTheme.fg("accent", "⧉")} ${uiTheme.fg("muted", `${count} stashed`)} ${uiTheme.fg("dim", "· alt+s")} `;
					if (visibleWidth(full) <= maxWidth) return full;
					const compact = ` ${uiTheme.fg("accent", "⧉")} ${uiTheme.fg("muted", String(count))} `;
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
						// Plain top border (with optional scroll overflow indicator)
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
					// Reserve 2 columns on the left of the text area for the native prompt glyph (">" or spinner)
					const innerWidth = Math.max(1, width - 2);
					const lines = super.render(innerWidth);
					if (lines.length < 3) return lines;

					// Replace top & bottom borders with full-width borders
					const uiTheme = ctx.ui.theme;
					const visibleCount = (this as any).renderedVisibleLineCount ?? 1;
					const scrollOff = (this as any).scrollOffset ?? 0;
					const totalLines = lines.length;
					const bottomBorderIdx = 1 + visibleCount;

					// Rebuild top border at full width
					lines[0] = this.renderTopBorder(width, scrollOff);

					// Choose the prompt gutter glyph: live spinner when working/loading, clean ">" when idle
					let glyph: string;
					if (this.activeIndicator?.renderSpinnerInBorder) {
						const rawSpinner = this.activeIndicator.renderSpinnerInBorder(1);
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
						// Compute linesBelow if possible, otherwise extend the border cleanly
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
		if (stack[stack.length - 1] !== text) {
			stack.push(text);
			if (stack.length > MAX_STASH) stack.shift();
		}
		triggerRender();
		return true;
	}

	function popStash(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (stack.length === 0) {
			ctx.ui.notify("Stash is empty", "info");
			return;
		}
		const current = ctx.ui.getEditorText();
		const popped = stack.pop()!;
		if (current.trim()) {
			stack.push(current);
		}
		ctx.ui.setEditorText(popped);
		triggerRender();
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
		if (ctx.hasUI) ctx.ui.setWidget("prompt-stash", undefined);
		bindCtrlC(ctx);
		mountEditor(ctx);
	});

	pi.on("session_shutdown", () => {
		unsubInput?.();
		unsubInput = undefined;
		syncSpinner(false);
		requestRender = undefined;
	});

	pi.registerShortcut("alt+s", {
		description: "Pop stashed prompt (or stash current draft)",
		handler: (ctx) => {
			if (!ctx.hasUI) return;
			const current = ctx.ui.getEditorText();
			if (stack.length > 0 && !current.trim()) {
				popStash(ctx);
			} else if (current.trim()) {
				pushStash(current);
				ctx.ui.setEditorText("");
			} else {
				ctx.ui.notify("Nothing to stash or pop", "info");
			}
		},
	});

	pi.registerCommand("stash", {
		description: "Inspect, pop, or clear stashed prompts",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "pop") {
				popStash(ctx);
				return;
			}
			if (sub === "clear") {
				stack.length = 0;
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
			if (stack.length === 0) {
				ctx.ui.notify("Prompt stash is empty (Ctrl+C or Alt+S stashes your draft)", "info");
				return;
			}
			const reversed = [...stack].reverse();
			const options = [
				...reversed.map((item, idx) => `${idx + 1}. ${oneLine(item, 80)}`),
				"Clear all stashed prompts",
			];
			const choice = await ctx.ui.select("Stashed prompts (select to restore)", options);
			if (!choice) return;
			if (choice === "Clear all stashed prompts") {
				stack.length = 0;
				triggerRender();
				return;
			}
			const idx = options.indexOf(choice);
			if (idx >= 0 && idx < reversed.length) {
				const origIdx = stack.length - 1 - idx;
				const [picked] = stack.splice(origIdx, 1);
				const current = ctx.ui.getEditorText();
				if (current.trim()) stack.push(current);
				ctx.ui.setEditorText(picked);
				triggerRender();
			}
		},
	});
}
