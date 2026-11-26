/**
 * OptChat Memory Timeline Viewer (`optchat-viewer.ts`)
 *
 * Clean, terminal-native, read-only TUI timeline of the current session's
 * OptChat memory compaction tree.
 *
 * Open:
 * - Click `mem …` on the right side of the footer (works with both the Devin
 *   footer and the fallback OptChat footer)
 * - `/mem` command
 *
 * Navigate (mouse + keyboard):
 * - Click anywhere on the proportional timeline bar to jump across the session
 * - Click any timeline row to inspect it; click its left/right child halves
 *   (or press `1` / `2` / `Enter` / `→`) to drill down to original messages
 * - Click breadcrumbs (or `←` / `Backspace` / `Esc`) to step back out
 * - Wheel / `↑↓` / `j`/`k` / `PgUp`/`PgDn` / `g`/`G` to scroll
 * - `r` to refresh live from disk, `q` or `Esc` to close
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const OPTCHAT_HOME = process.env.OPTCHAT_HOME || path.join(os.homedir(), ".optchat");
const PROFILES_DIR = path.join(OPTCHAT_HOME, "profiles");
const BINDING_TYPE = "optchat.profile";
const DEFAULT_VIEW_BUDGET = 128_000;

interface ViewPart {
  l: number;
  i: number;
}

interface MainEntry {
  i: number;
  kind: string;
  date?: string;
  text: string;
}

interface TreeNode {
  l: number;
  i: number;
  text: string;
  size: number;
}

interface LoadedMemory {
  profile: string;
  dir: string;
  budget: number;
  viewBytes: number;
  rawBytes: number;
  parts: ViewPart[];
  merging: boolean;
  mainById: Map<number, MainEntry>;
  treeByKey: Map<string, TreeNode>;
  totalMessages: number;
  firstDate?: string;
  lastDate?: string;
}

interface TimelineRow {
  part: ViewPart;
  startId: number;
  span: number;
  endId: number; // inclusive
  text: string;
  size: number;
  kind?: string;
  date?: string;
  pending: boolean;
}

// Terminal-native palette tuned to clean-dark.json:
// L0 (raw/recent) -> green, L1 -> cyan, L2 -> blue, L3 -> lavender,
// L4 -> purple, L5 -> amber, L6 -> orange, L7+ -> coral.
interface LevelStyle {
  label: string;
  fg: string;
  softBg: string;
  rail: string;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const LEVEL_STYLES: LevelStyle[] = [
  { label: "L0", fg: "\x1b[38;2;126;200;138m", softBg: "\x1b[48;2;26;41;31m", rail: "│" }, // 1 msg
  { label: "L1", fg: "\x1b[38;2;110;200;200m", softBg: "\x1b[48;2;24;39;42m", rail: "│" }, // 2 msgs
  { label: "L2", fg: "\x1b[38;2;110;168;254m", softBg: "\x1b[48;2;25;35;52m", rail: "┃" }, // 4 msgs
  { label: "L3", fg: "\x1b[38;2;143;155;242m", softBg: "\x1b[48;2;31;33;52m", rail: "┃" }, // 8 msgs
  { label: "L4", fg: "\x1b[38;2;185;147;232m", softBg: "\x1b[48;2;40;31;52m", rail: "┃" }, // 16 msgs
  { label: "L5", fg: "\x1b[38;2;230;195;106m", softBg: "\x1b[48;2;48;41;26m", rail: "█" }, // 32 msgs
  { label: "L6", fg: "\x1b[38;2;224;154;100m", softBg: "\x1b[48;2;49;35;25m", rail: "█" }, // 64 msgs
  { label: "L7", fg: "\x1b[38;2;232;112;112m", softBg: "\x1b[48;2;50;27;29m", rail: "█" }, // 128+ msgs
];

function styleForLevel(l: number): LevelStyle {
  return LEVEL_STYLES[Math.max(0, Math.min(l, LEVEL_STYLES.length - 1))];
}

function treeKey(l: number, i: number): string {
  return `${l}:${i}`;
}

function partStart(p: ViewPart): number {
  return p.i * Math.pow(2, p.l);
}

function partSpan(p: ViewPart): number {
  return Math.pow(2, p.l);
}

function padRight(str: string, width: number): string {
  const vis = visibleWidth(str);
  if (vis >= width) return truncateToWidth(str, width, "");
  return str + " ".repeat(width - vis);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function formatDuration(firstIso?: string, lastIso?: string): string {
  if (!firstIso || !lastIso) return "";
  const ms = new Date(lastIso).getTime() - new Date(firstIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatClock(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function resolveProfileName(ctx: ExtensionContext): string | null {
  try {
    const entries = ctx.sessionManager.getEntries() as Array<{
      type?: string;
      customType?: string;
      data?: { profile?: string };
    }>;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === BINDING_TYPE && typeof e.data?.profile === "string") {
        return e.data.profile;
      }
    }
  } catch { /* ignore */ }

  if (process.env.OPTCHAT_PROFILE) return process.env.OPTCHAT_PROFILE;

  try {
    const sid = ctx.sessionManager.getSessionId();
    if (sid) {
      const candidate = `s-${sid}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
      if (fs.existsSync(path.join(PROFILES_DIR, candidate))) return candidate;
    }
  } catch { /* ignore */ }

  return null;
}

function activeMemoryDir(profileDir: string): string {
  const pointer = path.join(profileDir, "active-memory.json");
  try {
    if (fs.existsSync(pointer)) {
      const data = JSON.parse(fs.readFileSync(pointer, "utf8"));
      if (typeof data?.path === "string" && data.path.length > 0 && fs.existsSync(data.path)) {
        return data.path;
      }
    }
  } catch { /* ignore */ }
  return profileDir;
}

function readJsonlDir<T>(dirPath: string): T[] {
  const out: T[] = [];
  if (!fs.existsSync(dirPath)) return out;
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl")).sort();
  for (const file of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(dirPath, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch { /* skip partial trailing line */ }
    }
  }
  return out;
}

function loadOptchatMemory(profile: string): LoadedMemory | null {
  const profileDir = path.join(PROFILES_DIR, profile);
  if (!fs.existsSync(profileDir)) return null;
  const memDir = activeMemoryDir(profileDir);

  let budget = DEFAULT_VIEW_BUDGET;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(profileDir, "config.json"), "utf8"));
    if (typeof cfg?.viewBudget === "number" && cfg.viewBudget > 0) budget = cfg.viewBudget;
  } catch { /* ignore */ }

  let rawParts: Array<[number, number]> = [];
  let merging = false;
  try {
    const view = JSON.parse(fs.readFileSync(path.join(memDir, "view.json"), "utf8"));
    if (Array.isArray(view?.parts)) rawParts = view.parts;
    merging = Boolean(view?.merging);
  } catch { /* ignore */ }

  const mainEntries = readJsonlDir<MainEntry>(path.join(memDir, "main"));
  const treeNodes = readJsonlDir<TreeNode>(path.join(memDir, "tree"));

  const mainById = new Map<number, MainEntry>();
  let maxMainId = -1;
  let rawBytes = 0;
  let firstDate: string | undefined;
  let lastDate: string | undefined;

  for (const e of mainEntries) {
    if (typeof e.i === "number") {
      mainById.set(e.i, e);
      if (e.i > maxMainId) maxMainId = e.i;
      rawBytes += Buffer.byteLength(e.text ?? "", "utf8");
      if (!firstDate && e.date) firstDate = e.date;
      if (e.date) lastDate = e.date;
    }
  }

  const treeByKey = new Map<string, TreeNode>();
  for (const n of treeNodes) {
    if (typeof n.l === "number" && typeof n.i === "number") {
      treeByKey.set(treeKey(n.l, n.i), n);
    }
  }

  const parts: ViewPart[] = rawParts
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map(([l, i]) => ({ l: Number(l), i: Number(i) }));

  // Append any newest messages not yet in view.json
  let maxCovered = -1;
  for (const p of parts) {
    const end = partStart(p) + partSpan(p) - 1;
    if (end > maxCovered) maxCovered = end;
  }
  for (let id = maxCovered + 1; id <= maxMainId; id++) {
    if (mainById.has(id)) parts.push({ l: 0, i: id });
  }

  let viewBytes = 0;
  for (const p of parts) {
    const node = treeByKey.get(treeKey(p.l, p.i));
    if (node) {
      viewBytes += node.size || Buffer.byteLength(node.text, "utf8");
    } else if (p.l === 0) {
      const m = mainById.get(p.i);
      if (m) viewBytes += Math.min(512, Buffer.byteLength(m.text ?? "", "utf8"));
    }
  }

  return {
    profile,
    dir: memDir,
    budget,
    viewBytes,
    rawBytes,
    parts,
    merging,
    mainById,
    treeByKey,
    totalMessages: mainById.size,
    firstDate,
    lastDate,
  };
}

function buildRow(mem: LoadedMemory, part: ViewPart): TimelineRow {
  const startId = partStart(part);
  const span = partSpan(part);
  const endId = startId + span - 1;
  const node = mem.treeByKey.get(treeKey(part.l, part.i));
  const firstMain = mem.mainById.get(startId);

  if (node) {
    return {
      part,
      startId,
      span,
      endId,
      text: node.text,
      size: node.size || Buffer.byteLength(node.text, "utf8"),
      kind: part.l === 0 ? firstMain?.kind : undefined,
      date: firstMain?.date,
      pending: false,
    };
  }

  if (part.l === 0 && firstMain) {
    return {
      part,
      startId,
      span,
      endId,
      text: `${firstMain.kind}: ${firstMain.text}`,
      size: Buffer.byteLength(firstMain.text ?? "", "utf8"),
      kind: firstMain.kind,
      date: firstMain.date,
      pending: true,
    };
  }

  return {
    part,
    startId,
    span,
    endId,
    text: "(not summarized yet)",
    size: 0,
    date: firstMain?.date,
    pending: true,
  };
}

/** Interactive read-only timeline overlay component. */
class OptchatViewerOverlay implements Component {
  private mem: LoadedMemory;
  private theme: Theme;
  private onClose: () => void;
  private requestRender: () => void;

  private rows: TimelineRow[] = [];
  private selectedIdx = 0;
  private scrollOffset = 0;
  private detailScroll = 0;
  private mode: "timeline" | "detail" = "timeline";
  private focusStack: ViewPart[] = [];

  // Hit-test geometry from last render()
  private rowYStart = 0;
  private rowCountRendered = 0;
  private detailChildHits: Array<{ yStart: number; yEnd: number; part: ViewPart }> = [];
  private breadcrumbHits: Array<{ y: number; xStart: number; xEnd: number; depth: number }> = [];
  private timelineBarY = -1;
  private timelineBarXStart = 0;
  private timelineBarWidth = 0;
  private timelineColToRow: number[] = [];
  private closeBtnHit: { y: number; xStart: number; xEnd: number } | null = null;

  constructor(mem: LoadedMemory, theme: Theme, requestRender: () => void, onClose: () => void) {
    this.mem = mem;
    this.theme = theme;
    this.requestRender = requestRender;
    this.onClose = onClose;
    this.rebuildRows();
    this.selectedIdx = Math.max(0, this.rows.length - 1);
  }

  private rebuildRows(): void {
    this.rows = this.mem.parts.map((p) => buildRow(this.mem, p));
  }

  private refresh(): void {
    const fresh = loadOptchatMemory(this.mem.profile);
    if (!fresh) return;
    this.mem = fresh;
    this.rebuildRows();
    if (this.selectedIdx >= this.rows.length) {
      this.selectedIdx = Math.max(0, this.rows.length - 1);
    }
  }

  private currentDetailPart(): ViewPart | null {
    if (this.focusStack.length > 0) return this.focusStack[this.focusStack.length - 1];
    const row = this.rows[this.selectedIdx];
    return row ? row.part : null;
  }

  private openDetailForRow(idx: number): void {
    const row = this.rows[idx];
    if (!row) return;
    this.selectedIdx = idx;
    this.focusStack = [row.part];
    this.detailScroll = 0;
    this.mode = "detail";
  }

  private drillInto(part: ViewPart): void {
    this.focusStack.push(part);
    this.detailScroll = 0;
  }

  private stepBack(): void {
    if (this.mode === "detail") {
      if (this.focusStack.length > 1) {
        this.focusStack.pop();
        this.detailScroll = 0;
      } else {
        this.focusStack = [];
        this.detailScroll = 0;
        this.mode = "timeline";
      }
    } else {
      this.onClose();
    }
  }

  handleInput(data: string): void {
    if (data === "q" || data === "Q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.mode === "detail") {
        this.stepBack();
        this.requestRender();
        return;
      }
      this.onClose();
      return;
    }

    if (data === "r" || data === "R") {
      this.refresh();
      this.requestRender();
      return;
    }

    if (this.mode === "timeline") {
      if (matchesKey(data, Key.up) || data === "k") {
        this.selectedIdx = Math.max(0, this.selectedIdx - 1);
      } else if (matchesKey(data, Key.down) || data === "j") {
        this.selectedIdx = Math.min(Math.max(0, this.rows.length - 1), this.selectedIdx + 1);
      } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
        this.selectedIdx = Math.max(0, this.selectedIdx - 12);
      } else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
        this.selectedIdx = Math.min(Math.max(0, this.rows.length - 1), this.selectedIdx + 12);
      } else if (data === "g" || matchesKey(data, Key.home)) {
        this.selectedIdx = 0;
      } else if (data === "G" || matchesKey(data, Key.end)) {
        this.selectedIdx = Math.max(0, this.rows.length - 1);
      } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || data === "l") {
        this.openDetailForRow(this.selectedIdx);
      }
      this.requestRender();
      return;
    }

    // Detail mode
    const cur = this.currentDetailPart();
    if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace) || data === "h") {
      this.stepBack();
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.detailScroll = Math.max(0, this.detailScroll - 1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.detailScroll += 1;
    } else if (matchesKey(data, Key.pageUp)) {
      this.detailScroll = Math.max(0, this.detailScroll - 10);
    } else if (matchesKey(data, Key.pageDown)) {
      this.detailScroll += 10;
    } else if ((data === "1" || matchesKey(data, Key.enter) || matchesKey(data, Key.right)) && cur && cur.l > 0) {
      this.drillInto({ l: cur.l - 1, i: cur.i * 2 });
    } else if (data === "2" && cur && cur.l > 0) {
      this.drillInto({ l: cur.l - 1, i: cur.i * 2 + 1 });
    } else if (data === "[") {
      if (this.selectedIdx > 0) this.openDetailForRow(this.selectedIdx - 1);
    } else if (data === "]") {
      if (this.selectedIdx < this.rows.length - 1) this.openDetailForRow(this.selectedIdx + 1);
    }
    this.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && typeof event.wheelDelta === "number") {
      const step = event.wheelDelta > 0 ? 3 : -3;
      if (this.mode === "timeline") {
        this.selectedIdx = Math.max(0, Math.min(this.rows.length - 1, this.selectedIdx + step));
      } else {
        this.detailScroll = Math.max(0, this.detailScroll + step);
      }
      this.requestRender();
      return { handled: true, render: true };
    }

    if (event.type === "press" && event.button === "left") {
      return { handled: true, focus: true };
    }
    if (event.type !== "click" || event.button !== "left") {
      return { handled: true };
    }

    const { x, y } = event;

    // Close button
    if (this.closeBtnHit && y === this.closeBtnHit.y && x >= this.closeBtnHit.xStart && x <= this.closeBtnHit.xEnd) {
      this.onClose();
      return { handled: true };
    }

    // Breadcrumb clicks (includes "← timeline")
    for (const bc of this.breadcrumbHits) {
      if (y === bc.y && x >= bc.xStart && x <= bc.xEnd) {
        if (bc.depth === 0) {
          this.focusStack = [];
          this.detailScroll = 0;
          this.mode = "timeline";
        } else {
          this.focusStack = this.focusStack.slice(0, bc.depth);
          this.detailScroll = 0;
        }
        this.requestRender();
        return { handled: true, render: true };
      }
    }

    if (this.mode === "timeline") {
      // Click anywhere on the proportional timeline bar to jump
      if (
        y === this.timelineBarY &&
        x >= this.timelineBarXStart &&
        x < this.timelineBarXStart + this.timelineBarWidth &&
        this.timelineColToRow.length > 0
      ) {
        const col = Math.min(this.timelineColToRow.length - 1, x - this.timelineBarXStart);
        this.selectedIdx = this.timelineColToRow[col];
        this.requestRender();
        return { handled: true, render: true };
      }

      // Click any timeline row to inspect it
      if (y >= this.rowYStart && y < this.rowYStart + this.rowCountRendered) {
        const idx = this.scrollOffset + (y - this.rowYStart);
        if (idx >= 0 && idx < this.rows.length) {
          this.openDetailForRow(idx);
          this.requestRender();
          return { handled: true, render: true };
        }
      }
      return { handled: true };
    }

    // Detail mode: click either child half card to zoom in
    for (const hit of this.detailChildHits) {
      if (y >= hit.yStart && y <= hit.yEnd) {
        this.drillInto(hit.part);
        this.requestRender();
        return { handled: true, render: true };
      }
    }

    return { handled: true };
  }

  invalidate(): void {
    // Recomputed per frame
  }

  render(width: number): string[] {
    const theme = this.theme;
    const innerW = Math.max(36, width - 4); // "│ " + content + " │"
    const termRows = process.stdout.rows || 36;
    const maxBodyLines = Math.max(10, Math.min(22, Math.floor(termRows * 0.56) - 4));

    this.detailChildHits = [];
    this.breadcrumbHits = [];
    this.timelineBarY = -1;
    this.timelineColToRow = [];
    this.closeBtnHit = null;

    const PANEL_BG = "\x1b[48;2;20;21;26m";
    const border = (s: string) => theme.fg("border", s);
    const subtle = (s: string) => theme.fg("borderMuted", s);
    // Re-apply panel background after any inner ANSI reset so the drawer stays solid end-to-end.
    const withBg = (s: string) => PANEL_BG + s.replace(/\x1b\[0m/g, `\x1b[0m${PANEL_BG}`);
    const frame = (content: string) =>
      `${withBg(`${border("┃")} ${padRight(content, innerW)} ${border("┃")}`)}${RESET}`;
    const divider = () =>
      `${withBg(`${border("┠")}${subtle("─".repeat(innerW + 2))}${border("┨")}`)}${RESET}`;

    const lines: string[] = [];

    // Top border: heavy top edge with title left, [×] close right
    const title = " OptChat Timeline ";
    const closeTag = " × ";
    const fillW = Math.max(1, innerW + 2 - visibleWidth(title) - visibleWidth(closeTag));
    lines.push(
      `${withBg(
        border("┏━") +
          theme.fg("text", theme.bold(title)) +
          border("━".repeat(Math.max(0, fillW - 1))) +
          theme.fg("muted", closeTag) +
          border("┓"),
      )}${RESET}`,
    );
    this.closeBtnHit = { y: 0, xStart: Math.max(0, width - closeTag.length - 1), xEnd: width - 1 };

    if (this.mode === "timeline") {
      this.renderTimeline(lines, frame, divider, innerW, maxBodyLines);
    } else {
      this.renderDetail(lines, frame, divider, innerW, maxBodyLines);
    }

    // Bottom border with quiet hint
    const hint =
      this.mode === "timeline"
        ? " click block to inspect · wheel/↑↓ scroll · r refresh · esc close "
        : " click half or 1/2 zoom in · ←/esc back · [ ] prev/next · q close ";
    const truncHint = truncateToWidth(hint, innerW + 2, "…");
    const leftPad = Math.max(0, Math.floor((innerW + 2 - visibleWidth(truncHint)) / 2));
    const rightPad = Math.max(0, innerW + 2 - visibleWidth(truncHint) - leftPad);
    lines.push(
      `${withBg(
        border("┗" + "━".repeat(leftPad)) +
          theme.fg("dim", truncHint) +
          border("━".repeat(rightPad) + "┛"),
      )}${RESET}`,
    );

    return lines;
  }

  private renderTimeline(
    lines: string[],
    frame: (s: string) => string,
    divider: () => string,
    innerW: number,
    maxBodyLines: number,
  ): void {
    const theme = this.theme;

    // 1. Session size & compaction summary bar
    const pct = Math.min(999, Math.round((this.mem.viewBytes / this.mem.budget) * 100));
    const pctColor = pct >= 90 ? "error" : pct >= 70 ? "warning" : "success";
    const ratio = this.mem.viewBytes > 0 ? this.mem.rawBytes / this.mem.viewBytes : 1;
    const ratioStr = ratio >= 1.5 ? `${ratio.toFixed(0)}× compressed` : "uncompacted";
    const dur = formatDuration(this.mem.firstDate, this.mem.lastDate);

    const leftSummary =
      theme.fg("text", `${this.mem.totalMessages} msgs`) +
      theme.fg("dim", ` (${formatBytes(this.mem.rawBytes)} raw)`) +
      theme.fg("dim", "  →  ") +
      theme.fg(pctColor, `${formatBytes(this.mem.viewBytes)}/${formatBytes(this.mem.budget)} (${pct}%)`) +
      theme.fg("dim", ` · ${ratioStr}`);
    const rightSummary = theme.fg("dim", `${this.rows.length} blocks${dur ? ` · ${dur}` : ""}`);
    const sumGap = Math.max(1, innerW - visibleWidth(leftSummary) - visibleWidth(rightSummary));
    lines.push(frame(truncateToWidth(leftSummary, innerW - visibleWidth(rightSummary) - 1, "…") + " ".repeat(sumGap) + rightSummary));

    // 2. Proportional timeline strip (weighted by message span so you see how much of the session each level covers!)
    const startClock = formatClock(this.mem.firstDate) || "start";
    const endClock = formatClock(this.mem.lastDate) || "now";
    const labelL = `${startClock} `;
    const labelR = ` ${endClock}`;
    const barW = Math.max(16, innerW - labelL.length - labelR.length);

    this.timelineBarY = lines.length;
    this.timelineBarXStart = 2 + labelL.length; // "│ " + labelL
    this.timelineBarWidth = barW;

    const totalSpan = this.rows.reduce((acc, r) => acc + r.span, 0) || 1;
    // Precompute cumulative message boundaries per row
    const cumEnd: number[] = [];
    let running = 0;
    for (const r of this.rows) {
      running += r.span;
      cumEnd.push(running);
    }

    let barStr = "";
    this.timelineColToRow = [];
    if (this.rows.length > 0) {
      let rowPtr = 0;
      for (let col = 0; col < barW; col++) {
        const targetMsg = ((col + 0.5) / barW) * totalSpan;
        while (rowPtr < this.rows.length - 1 && cumEnd[rowPtr] < targetMsg) {
          rowPtr++;
        }
        this.timelineColToRow.push(rowPtr);
        const st = styleForLevel(this.rows[rowPtr].part.l);
        const isSel = rowPtr === this.selectedIdx;
        barStr += isSel ? `${st.fg}${BOLD}█${RESET}` : `${st.fg}━${RESET}`;
      }
    } else {
      barStr = theme.fg("dim", "─".repeat(barW));
    }
    lines.push(frame(theme.fg("dim", labelL) + barStr + theme.fg("dim", labelR)));

    // 3. Compact level legend (only levels present in current view)
    const countsByLevel = new Map<number, number>();
    for (const r of this.rows) {
      countsByLevel.set(r.part.l, (countsByLevel.get(r.part.l) ?? 0) + 1);
    }
    const levels = Array.from(countsByLevel.keys()).sort((a, b) => b - a);
    const legend = levels
      .map((l) => {
        const st = styleForLevel(l);
        const span = Math.pow(2, l);
        const cnt = countsByLevel.get(l) ?? 0;
        return `${st.fg}● ${st.label}${RESET}${theme.fg("dim", ` ×${span} (${cnt})`)}`;
      })
      .join("   ");
    lines.push(frame(truncateToWidth(legend || theme.fg("dim", "empty"), innerW, "…")));
    lines.push(divider());

    // 4. Scrollable timeline rows
    const listHeight = Math.max(6, maxBodyLines - 5);
    if (this.selectedIdx < this.scrollOffset) {
      this.scrollOffset = this.selectedIdx;
    } else if (this.selectedIdx >= this.scrollOffset + listHeight) {
      this.scrollOffset = this.selectedIdx - listHeight + 1;
    }
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.rows.length - listHeight)));

    this.rowYStart = lines.length;
    const endIdx = Math.min(this.rows.length, this.scrollOffset + listHeight);
    this.rowCountRendered = endIdx - this.scrollOffset;

    if (this.rows.length === 0) {
      lines.push(frame(theme.fg("dim", "No messages in OptChat memory yet.")));
    } else {
      for (let idx = this.scrollOffset; idx < endIdx; idx++) {
        const row = this.rows[idx];
        const st = styleForLevel(row.part.l);
        const isSel = idx === this.selectedIdx;

        const rail = isSel ? `${st.fg}${BOLD}▸${RESET}` : `${st.fg}${st.rail}${RESET}`;
        const badge = `${st.softBg}${st.fg}${BOLD} ${st.label} ${RESET}`;
        const rangeStr = row.span > 1 ? `#${row.startId}+${row.span}` : `#${row.startId}`;
        const rangeCol = padRight(theme.fg(isSel ? "text" : "muted", rangeStr), 9);
        const clock = formatClock(row.date);
        const clockCol = clock ? theme.fg("dim", clock) + " " : "";
        const prefixW = 2 + 4 + 1 + 9 + (clock ? 6 : 0);
        const previewW = Math.max(12, innerW - prefixW);
        const preview = truncateToWidth(oneLine(row.text), previewW, "…");
        const previewStyled = row.pending
          ? theme.fg("dim", preview)
          : isSel
            ? theme.fg("text", preview)
            : theme.fg("muted", preview);

        const content = `${rail} ${badge} ${rangeCol}${clockCol}${previewStyled}`;
        lines.push(frame(isSel ? theme.bg("selectedBg", padRight(content, innerW)) : content));
      }
    }

    for (let k = this.rowCountRendered; k < listHeight; k++) {
      lines.push(frame(""));
    }

    // 5. Quiet status line for currently highlighted row
    const sel = this.rows[this.selectedIdx];
    const selLeft = sel
      ? `msgs #${sel.startId}–#${sel.endId} (${sel.span} msg${sel.span === 1 ? "" : "s"}, ${formatBytes(sel.size)})`
      : "";
    const selRight = this.rows.length > 0 ? `${this.selectedIdx + 1}/${this.rows.length}` : "";
    const footGap = Math.max(1, innerW - visibleWidth(selLeft) - visibleWidth(selRight));
    lines.push(frame(theme.fg("dim", selLeft) + " ".repeat(footGap) + theme.fg("dim", selRight)));
  }

  private renderDetail(
    lines: string[],
    frame: (s: string) => string,
    divider: () => string,
    innerW: number,
    maxBodyLines: number,
  ): void {
    const theme = this.theme;
    const part = this.currentDetailPart();
    if (!part) {
      lines.push(frame(theme.fg("dim", "Nothing selected.")));
      return;
    }

    const row = buildRow(this.mem, part);
    const st = styleForLevel(part.l);

    // 1. Clickable breadcrumb bar
    const backLabel = "← timeline";
    const bcY = lines.length;
    let bcStr = theme.fg("accent", backLabel);
    let cursorX = 2;
    this.breadcrumbHits.push({ y: bcY, xStart: cursorX, xEnd: cursorX + backLabel.length - 1, depth: 0 });
    cursorX += backLabel.length;

    for (let d = 0; d < this.focusStack.length; d++) {
      const p = this.focusStack[d];
      const sep = " › ";
      const seg = p.l > 0 ? `L${p.l} #${partStart(p)}+${partSpan(p)}` : `L0 #${partStart(p)}`;
      const ps = styleForLevel(p.l);
      const isLast = d === this.focusStack.length - 1;
      bcStr += theme.fg("dim", sep) + (isLast ? `${ps.fg}${BOLD}${seg}${RESET}` : `${ps.fg}${seg}${RESET}`);
      cursorX += sep.length;
      this.breadcrumbHits.push({ y: bcY, xStart: cursorX, xEnd: cursorX + seg.length - 1, depth: d + 1 });
      cursorX += seg.length;
    }
    lines.push(frame(truncateToWidth(bcStr, innerW, "…")));

    // 2. Metadata header
    const pill = `${st.softBg}${st.fg}${BOLD} ${st.label} ${RESET}`;
    const spanText =
      row.span > 1
        ? `messages #${row.startId}–#${row.endId} (${row.span} msgs)`
        : `message #${row.startId}${row.kind ? ` · ${row.kind}` : ""}`;
    const clock = row.date ? ` · ${formatClock(row.date)}` : "";
    lines.push(frame(truncateToWidth(`${pill} ${theme.fg("text", spanText)}${theme.fg("dim", `${clock} · ${formatBytes(row.size)}`)}`, innerW, "…")));
    lines.push(divider());

    // 3. Body text
    const bodyLines: string[] = [];
    if (part.l === 0) {
      const main = this.mem.mainById.get(part.i);
      const rawText = main ? main.text : row.text;
      const summaryNode = this.mem.treeByKey.get(treeKey(0, part.i));
      if (summaryNode && main && summaryNode.text !== `${main.kind}: ${main.text}`) {
        bodyLines.push(theme.fg("dim", "Summary:"));
        for (const wl of wrapTextWithAnsi(theme.fg("text", summaryNode.text), innerW - 2)) {
          bodyLines.push("  " + wl);
        }
        bodyLines.push("");
        bodyLines.push(theme.fg("dim", `Original (${main.kind}):`));
      }
      const capped = rawText.length > 8000 ? rawText.slice(0, 8000) + "\n… [truncated]" : rawText;
      for (const para of capped.split("\n")) {
        if (!para) {
          bodyLines.push("");
        } else {
          for (const wl of wrapTextWithAnsi(theme.fg("muted", para), innerW - 2)) {
            bodyLines.push("  " + wl);
          }
        }
      }
    } else {
      for (const para of row.text.split("\n")) {
        for (const wl of wrapTextWithAnsi(theme.fg("text", para), innerW - 2)) {
          bodyLines.push("  " + wl);
        }
      }
    }

    const hasChildren = part.l > 0;
    const childReserve = hasChildren ? 7 : 0;
    const bodyHeight = Math.max(4, maxBodyLines - 3 - childReserve);
    const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
    if (this.detailScroll > maxScroll) this.detailScroll = maxScroll;

    const visible = bodyLines.slice(this.detailScroll, this.detailScroll + bodyHeight);
    for (const l of visible) lines.push(frame(l));
    for (let k = visible.length; k < bodyHeight; k++) lines.push(frame(""));

    // 4. Clickable two child halves when viewing a compacted node
    if (hasChildren) {
      lines.push(divider());
      lines.push(frame(theme.fg("dim", "Halves (click to drill in, or press 1 / 2):")));
      const children: ViewPart[] = [
        { l: part.l - 1, i: part.i * 2 },
        { l: part.l - 1, i: part.i * 2 + 1 },
      ];
      children.forEach((child, idx) => {
        const cRow = buildRow(this.mem, child);
        const cs = styleForLevel(child.l);
        const yStart = lines.length;
        const cBadge = `${cs.softBg}${cs.fg}${BOLD} ${cs.label} ${RESET}`;
        const cRange = cRow.span > 1 ? `#${cRow.startId}+${cRow.span}` : `#${cRow.startId}`;
        const cClock = formatClock(cRow.date);
        const header = `${cs.fg}[${idx + 1}]${RESET} ${cBadge} ${theme.fg("text", cRange)}${theme.fg("dim", `${cClock ? ` · ${cClock}` : ""} · ${formatBytes(cRow.size)}`)}`;
        const preview = truncateToWidth(oneLine(cRow.text), innerW - 4, "…");
        lines.push(frame(header));
        lines.push(frame(`    ${theme.fg("muted", preview)}`));
        this.detailChildHits.push({ yStart, yEnd: lines.length - 1, part: child });
      });
    } else if (bodyLines.length > bodyHeight) {
      const pctScroll = Math.round(((this.detailScroll + visible.length) / bodyLines.length) * 100);
      lines.push(frame(theme.fg("dim", `lines ${this.detailScroll + 1}–${this.detailScroll + visible.length}/${bodyLines.length} (${pctScroll}%)`)));
    }
  }
}

export default function (pi: ExtensionAPI) {
  let viewerOpen = false;
  let lastCtx: ExtensionContext | null = null;
  let unsubTerminalInput: (() => void) | null = null;

  const openViewer = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI || viewerOpen) return;
    const profile = resolveProfileName(ctx);
    if (!profile) {
      ctx.ui.notify("No OptChat profile found for this session", "warning");
      return;
    }
    const mem = loadOptchatMemory(profile);
    if (!mem) {
      ctx.ui.notify(`OptChat memory not found for ${profile}`, "warning");
      return;
    }

    viewerOpen = true;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) =>
          new OptchatViewerOverlay(mem, theme, () => tui.requestRender(), () => done()),
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "96%",
            minWidth: 64,
            maxHeight: "60%",
            margin: { left: 1, right: 1, bottom: 2, top: 2 },
          },
        },
      );
    } finally {
      viewerOpen = false;
    }
  };

  // Detect left-click on the right-aligned `mem …` region in the bottom footer row.
  // Works with both pi-better-devin-auth's footer and optchat-session's fallback footer.
  const attachFooterClickListener = (ctx: ExtensionContext) => {
    unsubTerminalInput?.();
    unsubTerminalInput = null;
    if (!ctx.hasUI) return;

    let pressOnMem = false;
    const isInMemFooterZone = (x0: number, y0: number): boolean => {
      const rows = process.stdout.rows || 0;
      const cols = process.stdout.columns || 0;
      if (rows <= 0 || cols <= 0) return false;
      const onFooterRow = y0 >= rows - 2 && y0 <= rows - 1;
      const onRightSide = x0 >= Math.floor(cols * 0.52);
      return onFooterRow && onRightSide;
    };

    unsubTerminalInput = ctx.ui.onTerminalInput((data: string) => {
      if (viewerOpen) return undefined;
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
      if (!match) return undefined;

      const button = Number.parseInt(match[1], 10);
      const x0 = Number.parseInt(match[2], 10) - 1;
      const y0 = Number.parseInt(match[3], 10) - 1;
      const isRelease = match[4] === "m";

      if (!isRelease && button === 0) {
        if (isInMemFooterZone(x0, y0)) {
          pressOnMem = true;
          return { consume: true };
        }
        pressOnMem = false;
        return undefined;
      }

      if (isRelease && (button === 0 || button === 3) && pressOnMem) {
        pressOnMem = false;
        if (isInMemFooterZone(x0, y0) && lastCtx) {
          void openViewer(lastCtx);
        }
        return { consume: true };
      }

      return undefined;
    });
  };

  pi.registerCommand("mem", {
    description: "Open the read-only OptChat memory compaction timeline viewer",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      await openViewer(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    attachFooterClickListener(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    lastCtx = ctx;
    attachFooterClickListener(ctx);
  });

  pi.on("session_shutdown", async () => {
    unsubTerminalInput?.();
    unsubTerminalInput = null;
  });
}
