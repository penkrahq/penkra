// FILE: penkraComputerMcp.ts
// Purpose: The one Computer Use tool server every provider gets (P57). The desktop app ships the
// driver (open-computer-use, MIT) as a plain helper inside Penkra.app and passes its path in
// PENKRA_COMPUTER_HELPER. Providers are descendants of Penkra.app, so macOS holds the
// Accessibility and Screen Recording grants on Penkra itself, once, for every thread.
// Every provider launches the driver through a small stdio guard that lets one thread at a time act.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import path from "node:path";

/** `computer-use` is reserved by Claude Code, so Penkra's server has its own name. */
export const PENKRA_COMPUTER_MCP_NAME = "penkra-computer";

/** A thread keeps the computer this long after its last action before another thread may take it. */
export const PENKRA_COMPUTER_LEASE_MS = 90_000;

export interface PenkraComputerMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Proxies MCP stdio to the driver. A `tools/call` takes the shared lease file; while another live
 * thread holds it the call is answered here with "in use by thread X" and never reaches the driver.
 */
export const PENKRA_COMPUTER_GUARD_SOURCE = `
import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
const [helper, ...helperArgs] = process.argv.slice(2);
const lockPath = process.env.PENKRA_COMPUTER_LOCK;
const leaseMs = Number(process.env.PENKRA_COMPUTER_LEASE_MS || "90000");
const owner = process.env.PENKRA_THREAD_ID || "pid:" + process.pid;
const label = process.env.PENKRA_THREAD_LABEL || "another thread";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const read = () => { try { return JSON.parse(readFileSync(lockPath, "utf8")); } catch { return null; } };
const write = () => {
  const tmp = lockPath + "." + process.pid;
  writeFileSync(tmp, JSON.stringify({ owner, label, pid: process.pid, at: Date.now() }));
  renameSync(tmp, lockPath);
};
function take() {
  if (!lockPath) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const held = read();
    if (held && held.owner !== owner && alive(held.pid) && Date.now() - held.at < leaseMs) return held.label || held.owner;
    if (held) { write(); return null; }
    try { closeSync(openSync(lockPath, "wx")); write(); return null; } catch {}
  }
  return null;
}
function release() {
  if (!lockPath) return;
  const held = read();
  if (held && held.owner === owner && held.pid === process.pid) { try { unlinkSync(lockPath); } catch {} }
}
const PANES = { accessibility: process.env.PENKRA_ACCESSIBILITY_PANE || "Accessibility", screenRecording: "Screen Recording" };
let grantedAt = 0;
function missingGrants() {
  if (Date.now() - grantedAt < 10000) return null;
  const result = spawnSync(helper, ["doctor", "--json"], { env: process.env, encoding: "utf8", timeout: 5000 });
  let snapshot = null;
  try { snapshot = JSON.parse(result.stdout); } catch {}
  if (!snapshot) return null;
  if (snapshot.allGranted) { grantedAt = Date.now(); return null; }
  return (snapshot.missingPermissions || []).map((kind) => PANES[kind] || kind);
}
const reply = (id, text) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } }) + "\\n");
const child = spawn(helper, helperArgs, { stdio: ["pipe", "inherit", "inherit"], env: process.env });
child.on("exit", (code, signal) => { release(); process.exit(code ?? (signal ? 1 : 0)); });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { release(); child.kill(sig); });
process.on("exit", release);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline + 1);
    buffer = buffer.slice(newline + 1);
    let message = null;
    try { message = JSON.parse(line); } catch {}
    if (message && message.method === "tools/call" && message.id !== undefined) {
      const missing = missingGrants();
      if (missing && missing.length > 0) {
        reply(message.id, "Computer Use unavailable: Penkra isn't allowed " + missing.join(" or ") + ". Allow it in Penkra Settings → General → Computer Use, then try again.");
        continue;
      }
      const holder = take();
      if (holder) {
        reply(message.id, "Computer Use is in use by " + holder + ". Try again when it finishes.");
        continue;
      }
    }
    child.stdin.write(line);
  }
});
process.stdin.on("end", () => { if (buffer) child.stdin.write(buffer); child.stdin.end(); });
`;

// macOS 27 (Darwin 26) renamed the Accessibility pane.
function accessibilityPaneName(): string {
  if (process.platform !== "darwin") return "Accessibility";
  const darwinMajor = Number(release().split(".")[0]);
  // Darwin 26 is macOS 27.
  return darwinMajor >= 26 ? "Device Control and Data Access" : "Accessibility";
}

let guardPath: string | null = null;
function ensureGuard(): string {
  const digest = createHash("sha256").update(PENKRA_COMPUTER_GUARD_SOURCE).digest("hex").slice(0, 12);
  const dir = path.join(tmpdir(), "penkra-computer");
  const file = path.join(dir, `guard-${digest}.mjs`);
  if (guardPath === file && existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, PENKRA_COMPUTER_GUARD_SOURCE);
  guardPath = file;
  return file;
}

export function penkraComputerLockPath(): string {
  return path.join(tmpdir(), "penkra-computer", "in-use.json");
}

/** A thread's turn ended: hand the computer back now rather than when its idle lease runs out. */
export function releasePenkraComputerLease(threadId: string): void {
  const lockPath = penkraComputerLockPath();
  try {
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { owner?: string };
    if (held.owner === threadId) unlinkSync(lockPath);
  } catch {
    // No lease, or another thread's: nothing to release.
  }
}

/** Why the shared server is left out of new turns, or null when it is offered. */
export function penkraComputerUnavailableReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== "darwin") return "Computer Use needs macOS.";
  if (env.PENKRA_COMPUTER_USE === "0") return "Computer Use is turned off for this server.";
  const command = env.PENKRA_COMPUTER_HELPER?.trim();
  if (!command || !existsSync(command)) return "Penkra's Computer Use helper isn't installed.";
  return null;
}

export function resolvePenkraComputerMcpServer(
  options: { readonly threadId?: string; readonly threadLabel?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): PenkraComputerMcpServer | null {
  if (penkraComputerUnavailableReason(env) !== null) return null;
  const helper = env.PENKRA_COMPUTER_HELPER!.trim();
  return {
    command: process.execPath,
    args: [ensureGuard(), helper, "mcp"],
    env: {
      // Run in-process, never through the driver's own app agent, so the grants stay Penkra's.
      OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY: "1",
      // The packaged server runs on Electron's binary; this makes it behave as plain Node.
      ELECTRON_RUN_AS_NODE: "1",
      PENKRA_COMPUTER_LOCK: penkraComputerLockPath(),
      PENKRA_COMPUTER_LEASE_MS: String(PENKRA_COMPUTER_LEASE_MS),
      PENKRA_ACCESSIBILITY_PANE: accessibilityPaneName(),
      ...(options.threadId ? { PENKRA_THREAD_ID: options.threadId } : {}),
      ...(options.threadLabel ? { PENKRA_THREAD_LABEL: options.threadLabel } : {}),
    },
  };
}
