/**
 * rex-resume.ts — Program Resume Protocol (OSC 7577) reporter for Pi.
 *
 * Lets Rex (and any other OSC 7577 terminal) automatically resume this Pi
 * session after a server restart or reboot.
 *
 * Protocol spec: https://superlogical.com/rex/docs/build/program-resume
 *
 * Security / lifecycle rules followed:
 *  - Reads OSC7577_TOKEN once at load time and removes it from process.env so
 *    child processes (e.g. bash tool calls) do not inherit the terminal token.
 *  - Reports `pi --session <sessionFile>` + `cwd` on session_start,
 *    session_switch, and session_fork.
 *  - Re-reports on SIGCONT (returning from Ctrl+Z suspend).
 *  - Sends `clear=1` only on clean user exit (not on SIGHUP/SIGTERM/terminal
 *    close, which is when the terminal needs the record to resume).
 */

import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const TOKEN = process.env.OSC7577_TOKEN;
if (TOKEN) {
  // Strip from env so spawned child processes cannot forge or inherit it.
  delete process.env.OSC7577_TOKEN;
}

const VALID_TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
// Control characters disallowed by OSC 7577 in decoded argv / cwd
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function writeOsc7577(body: string): void {
  if (!TOKEN || !VALID_TOKEN_RE.test(TOKEN)) return;
  if (!process.stdout.isTTY) return;
  const mac = createHash("sha256").update(`${body}:${TOKEN}`).digest("hex");
  try {
    process.stdout.write(`\x1b]7577;${body}:mac=${mac}\x1b\\`);
  } catch {
    // Terminal already closed — ignore.
  }
}

export default function rexResumeExtension(pi: ExtensionAPI): void {
  if (!TOKEN || !VALID_TOKEN_RE.test(TOKEN)) {
    return;
  }

  let terminatedBySignal = false;
  let lastSessionFile: string | undefined;
  let lastCwd: string | undefined;

  const markSignalExit = () => {
    terminatedBySignal = true;
  };
  process.on("SIGHUP", markSignalExit);
  process.on("SIGTERM", markSignalExit);

  function report(sessionFile: string | undefined, cwd: string | undefined): void {
    lastSessionFile = sessionFile;
    lastCwd = cwd;

    const pid = process.pid;
    const time = Math.floor(Date.now() / 1000);

    if (!sessionFile || CONTROL_CHAR_RE.test(sessionFile)) {
      writeOsc7577(`pid=${pid}:time=${time}:clear=1`);
      return;
    }

    const argv = ["pi", "--session", sessionFile].map(b64).join(",");
    const parts = [`pid=${pid}`, `time=${time}`];
    if (cwd && cwd.startsWith("/") && !CONTROL_CHAR_RE.test(cwd)) {
      parts.push(`cwd=${b64(cwd)}`);
    }
    parts.push(`argv=${argv}`);
    writeOsc7577(parts.join(":"));
  }

  function clear(): void {
    const pid = process.pid;
    const time = Math.floor(Date.now() / 1000);
    writeOsc7577(`pid=${pid}:time=${time}:clear=1`);
  }

  function reportFromCtx(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    report(ctx.sessionManager.getSessionFile(), ctx.cwd);
  }

  pi.on("session_start", async (_event, ctx) => {
    reportFromCtx(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    reportFromCtx(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    reportFromCtx(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    // Per OSC 7577: MUST NOT send clear on SIGHUP/SIGTERM/terminal loss.
    if (terminatedBySignal) return;
    clear();
  });

  // Re-report when resumed from suspension (Ctrl+Z -> fg)
  process.on("SIGCONT", () => {
    if (lastSessionFile) {
      report(lastSessionFile, lastCwd);
    }
  });
}
