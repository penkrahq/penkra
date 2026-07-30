// FILE: desktopParentLifecycle.ts
// Purpose: Bind a desktop backend's lifetime to its Electron parent.

import { Effect } from "effect";

export const DESKTOP_PARENT_PID_ENV_KEY = "SYNARA_DESKTOP_PARENT_PID";
const PARENT_LIVENESS_INTERVAL_MS = 1_000;

export interface DesktopParentProcess {
  readonly channel?: unknown;
  readonly connected: boolean;
  readonly ppid: number;
  once(event: "disconnect", listener: () => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

export function consumeDesktopParentPidFromEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): number | null {
  const matchingKeys =
    platform === "win32"
      ? Object.keys(environment).filter((key) => key.toUpperCase() === DESKTOP_PARENT_PID_ENV_KEY)
      : [DESKTOP_PARENT_PID_ENV_KEY];
  let rawValue: string | undefined;
  for (const key of matchingKeys) {
    rawValue ??= environment[key];
    delete environment[key];
  }

  const parsed = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function isDesktopParentGone(input: {
  readonly expectedParentPid: number;
  readonly currentParentPid: number;
  readonly isExpectedParentLive: boolean;
  readonly platform: NodeJS.Platform;
}): boolean {
  if (!input.isExpectedParentLive) return true;
  // POSIX reparents an orphan immediately. This also protects against the old
  // PID being recycled for an unrelated live process.
  return input.platform !== "win32" && input.currentParentPid !== input.expectedParentPid;
}

function isPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Standalone/web servers have no Electron parent identity and live normally.
 * Desktop children use both IPC disconnect and parent-process liveness so force
 * quits and crashes cannot leave a database-owning orphan.
 */
export function waitForDesktopParentDisconnect(input: {
  readonly parentProcess: DesktopParentProcess;
  readonly expectedParentPid: number | null;
}): Effect.Effect<void> {
  const hasIpcChannel = input.parentProcess.channel !== undefined;
  // The expected PID is a desktop-only capability set by Electron. Do not bind
  // ordinary web servers merely because a task runner happened to give them IPC.
  if (input.expectedParentPid === null) {
    return Effect.never;
  }

  return Effect.callback<void>((resume) => {
    let settled = false;
    const complete = () => {
      if (settled) return;
      settled = true;
      resume(Effect.void);
    };
    const parentIsGone = () =>
      input.expectedParentPid !== null &&
      isDesktopParentGone({
        expectedParentPid: input.expectedParentPid,
        currentParentPid: input.parentProcess.ppid,
        isExpectedParentLive: isPidLive(input.expectedParentPid),
        platform: process.platform,
      });

    if ((hasIpcChannel && !input.parentProcess.connected) || parentIsGone()) {
      complete();
      return;
    }

    const handleDisconnect = complete;
    if (hasIpcChannel) {
      input.parentProcess.once("disconnect", handleDisconnect);
    }
    const livenessTimer =
      input.expectedParentPid === null
        ? null
        : setInterval(() => {
            if (parentIsGone()) complete();
          }, PARENT_LIVENESS_INTERVAL_MS);
    livenessTimer?.unref();

    return Effect.sync(() => {
      settled = true;
      if (hasIpcChannel) {
        input.parentProcess.off("disconnect", handleDisconnect);
      }
      if (livenessTimer) clearInterval(livenessTimer);
    });
  });
}
