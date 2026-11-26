/**
 * optchat-session — per-session OptChat profile binding + live footer stats.
 *
 * pi-optchat is designed around account-wide profiles ("work", "personal").
 * This extension gives every Pi session its own OptChat profile (`s-<sessionId>`),
 * creates it automatically on disk, binds the session to it, and renders live
 * OptChat memory stats in the Pi footer (and exports helpers for the web UI).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CustomEntry, ExtensionAPI, ExtensionContext, FileEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BINDING_TYPE = "optchat.profile";
const DEFAULT_VIEW_BUDGET = 128_000;
const PROFILE_PREFIX = "s-";

export interface OptchatStats {
  profile: string;
  dir: string;
  messages: number;
  summaryNodes: number;
  viewBytes: number;
  viewBudget: number;
  viewPercent: number;
  pending: number;
  merging: boolean;
  compactorCost: number;
  compactorTokens: number;
  compactorModel: string | null;
}

export function optchatHome(): string {
  return path.resolve(process.env.OPTCHAT_HOME ?? path.join(os.homedir(), ".optchat"));
}

/** Deterministic, valid pi-optchat profile name for a Pi session ID. */
export function sessionProfileName(sessionId: string): string {
  const clean = sessionId.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 60);
  return `${PROFILE_PREFIX}${clean || "chat"}`;
}

export function profileDir(name: string, home = optchatHome()): string {
  return path.join(home, "profiles", name);
}

/** Check whether a session already has an optchat.profile custom entry. */
export function boundProfile(entries: readonly FileEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && (e as CustomEntry).customType === BINDING_TYPE) {
      const data = (e as CustomEntry).data as Record<string, unknown> | undefined;
      if (data && typeof data.name === "string" && data.name) return data.name;
    }
  }
  return undefined;
}

/**
 * Ensure a per-session OptChat profile directory exists on disk with a valid
 * config.json and AGENTS.md matching pi-optchat's createProfile() layout.
 */
export function ensureSessionProfile(name: string, home = optchatHome()): string {
  const dir = profileDir(name, home);
  if (existsSync(path.join(dir, "config.json"))) return dir;

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const configPath = path.join(dir, "config.json");
  if (!existsSync(configPath)) {
    const config = {
      compactor: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", thinking: "off" },
      subagent: { provider: "devin", model: "gemini-4-neon", thinking: "medium" },
      subagentLevels: 1,
      maxAgents: 8,
      groupReports: false,
      previousExchange: true,
      previousExchangeKB: 16,
      memorySearch: true,
      summaryAcceptBytes: 768,
      jobs: 8,
      refreshAt: 0.5,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  }

  const agentsPath = path.join(dir, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    writeFileSync(
      agentsPath,
      `# ${name}\n\nPer-session OptChat memory profile for Pi session ${name.replace(/^s-/, "")}.\n`,
      { mode: 0o600 },
    );
  }
  return dir;
}

function activeMemoryDir(dir: string): string {
  const ptr = path.join(dir, "active-memory.json");
  if (!existsSync(ptr)) return dir;
  try {
    const name = JSON.parse(readFileSync(ptr, "utf8"));
    if (typeof name === "string" && (name === "." || /^memories\/[a-f0-9-]{36}$/.test(name))) {
      const candidate = path.join(dir, name);
      if (existsSync(path.join(candidate, "main"))) return candidate;
    }
  } catch { /* fallback to dir */ }
  return dir;
}

function countJsonlLines(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  try {
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".jsonl")) continue;
      const buf = readFileSync(path.join(dirPath, f));
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) total++;
      if (buf.length > 0 && buf[buf.length - 1] !== 10) total++;
    }
  } catch { /* ignore */ }
  return total;
}

function countTreeNodes(treeDir: string): { total: number; leaves: number; bytesByKey: Map<string, number> } {
  const bytesByKey = new Map<string, number>();
  let leaves = 0;
  if (!existsSync(treeDir)) return { total: 0, leaves: 0, bytesByKey };
  try {
    for (const f of readdirSync(treeDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const lines = readFileSync(path.join(treeDir, f), "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const node = JSON.parse(line);
          if (typeof node.l === "number" && typeof node.i === "number" && typeof node.size === "number") {
            const k = `${node.l}:${node.i}`;
            if (!bytesByKey.has(k) && node.l === 0) leaves++;
            bytesByKey.set(k, node.size);
          }
        } catch { /* skip partial line */ }
      }
    }
  } catch { /* ignore */ }
  return { total: bytesByKey.size, leaves, bytesByKey };
}

function readViewState(memDir: string, bytesByKey: Map<string, number>): { viewBytes: number; merging: boolean } {
  const viewPath = path.join(memDir, "view.json");
  if (!existsSync(viewPath)) return { viewBytes: 0, merging: false };
  try {
    const raw = JSON.parse(readFileSync(viewPath, "utf8"));
    const merging = raw?.merging === true || raw?.compaction?.merging === true;
    const rawParts: unknown[] = Array.isArray(raw?.parts) ? raw.parts : Array.isArray(raw?.chat) ? raw.chat : [];
    if (!rawParts.length) return { viewBytes: 0, merging };
    let total = 15; // "<chat>\n</chat>"
    for (const p of rawParts) {
      const l = Array.isArray(p) ? Number(p[0]) : Number((p as any)?.l);
      const i = Array.isArray(p) ? Number(p[1]) : Number((p as any)?.i);
      if (!Number.isFinite(l) || !Number.isFinite(i)) continue;
      const start = i * 2 ** l;
      const span = 2 ** l;
      const headBytes = Buffer.byteLength(`${start}+${span}|\n`);
      const bodyBytes = bytesByKey.get(`${l}:${i}`) ?? 29;
      total += headBytes + bodyBytes;
    }
    return { viewBytes: total, merging };
  } catch {
    return { viewBytes: 0, merging: false };
  }
}

function readCompactorUsage(dir: string): { cost: number; tokens: number } {
  const usagePath = path.join(dir, "usage.jsonl");
  if (!existsSync(usagePath)) return { cost: 0, tokens: 0 };
  let cost = 0;
  let tokens = 0;
  try {
    const lines = readFileSync(usagePath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.role === "compactor" && entry.usage) {
          cost += Number(entry.usage.cost?.total ?? 0);
          tokens += Number(entry.usage.totalTokens ?? 0);
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return { cost, tokens };
}

/** Read OptChat stats from disk for a profile name (fast, read-only, lock-free). */
export function readOptchatStats(profile: string, home = optchatHome()): OptchatStats | null {
  const dir = profileDir(profile, home);
  if (!existsSync(dir)) return null;

  let compactorModel: string | null = null;
  try {
    const cfg = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
    if (cfg?.compactor?.model) {
      compactorModel = cfg.compactor.provider ? `${cfg.compactor.provider}/${cfg.compactor.model}` : cfg.compactor.model;
    }
  } catch { /* ignore */ }

  const memDir = activeMemoryDir(dir);
  const messages = countJsonlLines(path.join(memDir, "main"));
  const tree = countTreeNodes(path.join(memDir, "tree"));
  const { viewBytes, merging } = readViewState(memDir, tree.bytesByKey);
  const viewBudget = DEFAULT_VIEW_BUDGET;
  const viewPercent = Math.min(100, Math.round((viewBytes / viewBudget) * 1000) / 10);
  const pending = Math.max(0, messages - tree.leaves);
  const { cost: compactorCost, tokens: compactorTokens } = readCompactorUsage(dir);

  return {
    profile,
    dir,
    messages,
    summaryNodes: tree.total,
    viewBytes,
    viewBudget,
    viewPercent,
    pending,
    merging,
    compactorCost,
    compactorTokens,
    compactorModel,
  };
}

/** Resolve stats for a Pi session ID (checks explicit binding if given, else s-<sessionId>). */
export function optchatStatsFor(sessionId: string, boundName?: string): OptchatStats | null {
  const name = boundName || sessionProfileName(sessionId);
  return readOptchatStats(name);
}

export function formatOptchatFooter(s: OptchatStats): string {
  const kb = (s.viewBytes / 1000).toFixed(s.viewBytes >= 10_000 ? 0 : 1);
  const budgetKb = Math.round(s.viewBudget / 1000);
  const parts = [`${kb}/${budgetKb}KB (${Math.round(s.viewPercent)}%)`, `${s.messages}m`, `${s.summaryNodes}n`];
  if (s.compactorCost > 0) {
    parts.push(`$${s.compactorCost < 0.01 ? s.compactorCost.toFixed(4) : s.compactorCost.toFixed(3)}`);
  }
  if (s.pending > 0) parts.push(`${s.pending} compacting`);
  return parts.join(" · ");
}

function formatOptchatFooterStyled(s: OptchatStats, theme: Theme, narrow = false): string {
  const kb = (s.viewBytes / 1000).toFixed(s.viewBytes >= 10_000 ? 0 : 1);
  const budgetKb = Math.round(s.viewBudget / 1000);
  const pct = Math.round(s.viewPercent);
  const sep = theme.fg("dim", " · ");
  const memColor = pct >= 90 ? "error" : pct >= 70 ? "warning" : "accent";

  const parts: string[] = [
    theme.fg("muted", "mem ") + theme.fg(memColor, `${kb}/${budgetKb}KB`) + theme.fg("dim", ` (${pct}%)`),
    theme.fg("muted", `${s.messages}m`) + theme.fg("dim", "/") + theme.fg("muted", `${s.summaryNodes}n`),
  ];
  if (!narrow && s.compactorCost > 0) {
    const costStr = s.compactorCost < 0.01 ? s.compactorCost.toFixed(4) : s.compactorCost.toFixed(3);
    parts.push(theme.fg("dim", `$${costStr}`));
  }
  if (s.pending > 0) {
    parts.push(theme.fg("warning", narrow ? `${s.pending} compacting` : `${s.pending} compacting`));
  }
  return parts.join(sep);
}

function formatTokensCompact(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatPwdShort(cwd: string): string {
  const home = os.homedir();
  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = path.resolve(home);
  const rel = path.relative(resolvedHome, resolvedCwd);
  const insideHome = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  if (!insideHome) return cwd;
  return rel === "" ? "~" : `~${path.sep}${rel}`;
}

function alignRow(left: string, right: string, width: number, dimEllipsis: string): string {
  const minGap = 2;
  const leftW = visibleWidth(left);
  const rightW = visibleWidth(right);
  if (!right) return truncateToWidth(left, width, dimEllipsis);
  if (leftW + minGap + rightW <= width) {
    return left + " ".repeat(width - leftW - rightW) + right;
  }
  // Keep right side intact when possible, shrink left slightly; if still tight, truncate right
  const maxRight = Math.max(0, width - Math.min(leftW, Math.floor(width * 0.55)) - minGap);
  const fittedRight = rightW <= maxRight ? right : truncateToWidth(right, maxRight, dimEllipsis);
  const fittedRightW = visibleWidth(fittedRight);
  const maxLeft = Math.max(0, width - fittedRightW - minGap);
  const fittedLeft = leftW <= maxLeft ? left : truncateToWidth(left, maxLeft, dimEllipsis);
  const gap = Math.max(1, width - visibleWidth(fittedLeft) - fittedRightW);
  return truncateToWidth(fittedLeft + " ".repeat(gap) + fittedRight, width, dimEllipsis);
}

function formatCleanTitle(cwd: string, sessionName?: string): string {
  if (sessionName?.trim()) return sessionName.trim();
  const home = os.homedir();
  return cwd === home ? "~" : path.basename(cwd) || cwd;
}

export default function optchatSession(pi: ExtensionAPI) {
  let activeProfile: string | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastRexLabel: string | undefined;
  let cachedStats: OptchatStats | null = null;
  let requestFooterRender: (() => void) | undefined;
  let compactStartStats: { pending: number; viewBytes: number; summaryNodes: number; startedAt: number } | null = null;
  let compactDoneBanner: { text: string; expiresAt: number } | null = null;
  let compactDoneTimer: ReturnType<typeof setTimeout> | undefined;

  const syncRexSessionName = (label: string) => {
    if (!process.env.REX_SESSION || label === lastRexLabel) return;
    lastRexLabel = label;
    execFile("rex", ["session", "rename", label], () => { /* best effort */ });
  };

  const mountFooter = (ctx: ExtensionContext) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      requestFooterRender = () => tui.requestRender();

      return {
        dispose() {
          unsub();
          requestFooterRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const ellipsis = theme.fg("dim", "…");
          const narrow = width < 72;

          // Row 1: pwd (branch) • session name
          let pwd = formatPwdShort(ctx.cwd);
          const branch = footerData.getGitBranch();
          const sessionName = pi.getSessionName()?.trim();
          if (branch) pwd = `${pwd} (${branch})`;
          if (sessionName) pwd = `${pwd} • ${sessionName}`;
          const row1Left = theme.fg("dim", pwd);

          const model = ctx.model;
          const modelId = model?.id || "no-model";
          let modelText = modelId;
          if (model?.reasoning) {
            const level = pi.getThinkingLevel() || "off";
            if (narrow) {
              modelText = level === "off" ? modelId : `${modelId} • ${level.slice(0, 3)}`;
            } else {
              modelText = level === "off" ? `${modelId} • thinking off` : `${modelId} • ${level}`;
            }
          }
          if (!narrow && footerData.getAvailableProviderCount() > 1 && model?.provider) {
            modelText = `(${model.provider}) ${modelText}`;
          }
          const row1Right = theme.fg("muted", modelText);

          // Session token/cost/context stats
          let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
          let latestCacheHitRate: number | undefined;
          for (const entry of ctx.sessionManager.getEntries()) {
            const u =
              entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
                ? (entry.message as any).usage
                : (entry as any).usage;
            if (!u) continue;
            input += Number(u.input ?? 0);
            output += Number(u.output ?? 0);
            cacheRead += Number(u.cacheRead ?? 0);
            cacheWrite += Number(u.cacheWrite ?? 0);
            cost += Number(u.cost?.total ?? 0);
            if (entry.type === "message" && entry.message.role === "assistant") {
              const prompt = Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
              if (prompt > 0) latestCacheHitRate = (Number(u.cacheRead ?? 0) / prompt) * 100;
            }
          }

          const ctxUsage = ctx.getContextUsage();
          const ctxWindow = ctxUsage?.contextWindow ?? model?.contextWindow ?? 0;
          const ctxPctVal = ctxUsage?.percent ?? 0;
          const ctxPctStr = ctxUsage?.percent !== null && ctxUsage?.percent !== undefined
            ? (narrow ? `${Math.round(ctxPctVal)}%/${formatTokensCompact(ctxWindow)}` : `${ctxPctVal.toFixed(1)}%/${formatTokensCompact(ctxWindow)}`)
            : `?/${formatTokensCompact(ctxWindow)}`;
          const coloredCtx = ctxPctVal > 90
            ? theme.fg("error", ctxPctStr)
            : ctxPctVal > 70
              ? theme.fg("warning", ctxPctStr)
              : theme.fg("dim", ctxPctStr);

          let lines: string[];
          if (narrow) {
            // Mobile multi-row layout: each group gets breathing room without aggressive clipping
            // Row 1: pwd (branch) • session
            // Row 2: cost + ctx% | model • thinking
            // Row 3: mem stats (full width)
            const compactLeft = cost > 0 ? `${theme.fg("dim", `$${cost.toFixed(2)} `)}${coloredCtx}` : coloredCtx;
            lines = [
              truncateToWidth(row1Left, width, ellipsis),
              alignRow(compactLeft, row1Right, width, ellipsis),
            ];
            if (cachedStats) {
              lines.push(truncateToWidth(formatOptchatFooterStyled(cachedStats, theme, true), width, ellipsis));
            }
          } else {
            const statsParts: string[] = [];
            if (input) statsParts.push(`↑${formatTokensCompact(input)}`);
            if (output) statsParts.push(`↓${formatTokensCompact(output)}`);
            if (cacheRead) statsParts.push(`R${formatTokensCompact(cacheRead)}`);
            if (cacheWrite) statsParts.push(`W${formatTokensCompact(cacheWrite)}`);
            if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
              statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
            }
            if (cost > 0) statsParts.push(`$${cost.toFixed(3)}`);
            const dimStats = statsParts.length ? theme.fg("dim", statsParts.join(" ") + " ") : "";
            const row2Left = dimStats + coloredCtx;
            const row2Right = cachedStats ? formatOptchatFooterStyled(cachedStats, theme) : "";
            lines = [
              alignRow(row1Left, row1Right, width, ellipsis),
              alignRow(row2Left, row2Right, width, ellipsis),
            ];
          }

          // Preserve any non-optchat extension statuses on a 3rd line if present
          const otherStatuses = Array.from(footerData.getExtensionStatuses().entries())
            .filter(([k]) => k !== "optchat" && k !== "optchat.role" && k !== "optchat-compact")
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
            .filter(Boolean);
          if (otherStatuses.length > 0) {
            lines.push(truncateToWidth(otherStatuses.join(" "), width, ellipsis));
          }

          return lines;
        },
      };
    });
  };

  const updateUi = (ctx: ExtensionContext) => {
    if (!activeProfile) return;

    // Hide pi-optchat's redundant below-editor Agents/Usage/Activity bar (F6 & /optchat still work)
    ctx.ui.setWidget("optchat-agents", undefined);

    // Replace pi-optchat's `● π s-<uuid>` tab title with a clean session title (and sync Rex)
    const label = formatCleanTitle(ctx.cwd, pi.getSessionName());
    ctx.ui.setTitle(label);
    syncRexSessionName(label);

    const prevStats = cachedStats;
    cachedStats = readOptchatStats(activeProfile);

    // Emit OptChat compaction state to the prompt box's native top border
    // (clear any legacy floating widget from earlier reloads).
    ctx.ui.setWidget("optchat-compacting", undefined);
    if (cachedStats) {
      const isCompacting = cachedStats.pending > 0 || cachedStats.merging;
      if (isCompacting) {
        if (!compactStartStats) {
          compactStartStats = {
            pending: cachedStats.pending,
            viewBytes: prevStats?.viewBytes ?? cachedStats.viewBytes,
            summaryNodes: prevStats?.summaryNodes ?? cachedStats.summaryNodes,
            startedAt: Date.now(),
          };
        } else if (cachedStats.pending > compactStartStats.pending) {
          compactStartStats.pending = cachedStats.pending;
        }
        compactDoneBanner = null;
        if (compactDoneTimer) { clearTimeout(compactDoneTimer); compactDoneTimer = undefined; }
        const s = cachedStats;
        const parts: string[] = [];
        if (s.pending > 0) parts.push(`${s.pending} msg${s.pending === 1 ? "" : "s"}`);
        if (s.merging) parts.push("merging");
        const kb = (s.viewBytes / 1000).toFixed(s.viewBytes >= 10_000 ? 0 : 1);
        const budgetKb = Math.round(s.viewBudget / 1000);
        pi.events.emit("optchat:compaction", {
          kind: "compacting",
          text: `compacting ${parts.join(" · ")} · ${kb}/${budgetKb}KB`,
        });
      } else if (compactStartStats) {
        const started = compactStartStats;
        compactStartStats = null;
        const addedNodes = Math.max(0, cachedStats.summaryNodes - started.summaryNodes);
        const elapsedSec = ((Date.now() - started.startedAt) / 1000).toFixed(1);
        const kb = (cachedStats.viewBytes / 1000).toFixed(cachedStats.viewBytes >= 10_000 ? 0 : 1);
        const budgetKb = Math.round(cachedStats.viewBudget / 1000);
        const delta = addedNodes > 0 ? `+${addedNodes}n · ` : "";
        compactDoneBanner = {
          text: `compacted ${delta}${kb}/${budgetKb}KB · ${elapsedSec}s`,
          expiresAt: Date.now() + 4000,
        };
        pi.events.emit("optchat:compaction", { kind: "done", text: compactDoneBanner.text });
        if (compactDoneTimer) clearTimeout(compactDoneTimer);
        compactDoneTimer = setTimeout(() => {
          compactDoneBanner = null;
          compactDoneTimer = undefined;
          pi.events.emit("optchat:compaction", { kind: "idle" });
        }, 4000);
        compactDoneTimer.unref?.();
      } else if (!compactDoneBanner || Date.now() >= compactDoneBanner.expiresAt) {
        compactDoneBanner = null;
        pi.events.emit("optchat:compaction", { kind: "idle" });
      }

      // Publish colored compact stats under our own status key so coexisting footers (e.g. pi-better-devin-auth)
      // can place it on the right side of the stats row (or its own row on narrow terminals) and suppress
      // pi-optchat's verbose 'optchat' line.
      const narrow = (process.stdout.columns || 120) < 72;
      ctx.ui.setStatus("optchat-compact", formatOptchatFooterStyled(cachedStats, ctx.ui.theme, narrow));
    }
    // Mount our own footer only when no provider-specific footer (like devin) owns it
    if (ctx.model?.provider !== "devin" && !requestFooterRender) {
      mountFooter(ctx);
    }
    requestFooterRender?.();
  };

  pi.on("session_start", async (_event, ctx) => {
    const flagAgent = pi.getFlag("optchat-agent");
    if (flagAgent !== undefined) return;

    const flagProfile = pi.getFlag("optchat-profile");
    const entries = ctx.sessionManager.getEntries();
    const existing = boundProfile(entries);

    if (existing) {
      activeProfile = existing;
      ensureSessionProfile(existing);
    } else if (typeof flagProfile === "string" && flagProfile.trim()) {
      activeProfile = flagProfile.trim();
      ensureSessionProfile(activeProfile);
    } else if (process.env.OPTCHAT_PROFILE?.trim()) {
      activeProfile = process.env.OPTCHAT_PROFILE.trim();
      ensureSessionProfile(activeProfile);
    } else {
      const sid = ctx.sessionManager.getSessionId();
      const name = sessionProfileName(sid);
      ensureSessionProfile(name);
      pi.appendEntry(BINDING_TYPE, { name });
      activeProfile = name;
    }

    cachedStats = readOptchatStats(activeProfile);
    if (cachedStats) {
      const narrow = (process.stdout.columns || 120) < 72;
      ctx.ui.setStatus("optchat-compact", formatOptchatFooterStyled(cachedStats, ctx.ui.theme, narrow));
    }
    if (ctx.model?.provider !== "devin") {
      mountFooter(ctx);
    }

    // Defer slightly so our clean UI wins after pi-optchat mounts its widget/title
    setTimeout(() => updateUi(ctx), 150).unref?.();
    setTimeout(() => updateUi(ctx), 600).unref?.();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => updateUi(ctx), 2000);
    pollTimer.unref?.();
  });

  pi.on("model_select", (_event, ctx) => {
    // Re-sync footer ownership when switching between devin and non-devin models
    if (ctx.model?.provider !== "devin") {
      setTimeout(() => {
        if (ctx.model?.provider !== "devin" && activeProfile) mountFooter(ctx);
      }, 50).unref?.();
    }
    updateUi(ctx);
  });
  pi.on("turn_start", (_event, ctx) => updateUi(ctx));
  pi.on("turn_end", (_event, ctx) => updateUi(ctx));
  pi.on("agent_settled", (_event, ctx) => updateUi(ctx));
  pi.on("session_shutdown", () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
    if (compactDoneTimer) { clearTimeout(compactDoneTimer); compactDoneTimer = undefined; }
    activeProfile = undefined;
    cachedStats = null;
    compactStartStats = null;
    compactDoneBanner = null;
    lastRexLabel = undefined;
    requestFooterRender = undefined;
  });
}
