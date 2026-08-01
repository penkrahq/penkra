// FILE: desktopParentLifecycle.ts
// Purpose: Share the exact Electron-parent lifetime capability between desktop and server.

export const DESKTOP_PARENT_PID_ENV_KEY = "PENKRA_DESKTOP_PARENT_PID";

export function bindDesktopParentPid(
  environment: NodeJS.ProcessEnv,
  parentPid: number,
): NodeJS.ProcessEnv {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error(`Invalid desktop parent pid: ${String(parentPid)}`);
  }
  return {
    ...environment,
    [DESKTOP_PARENT_PID_ENV_KEY]: String(parentPid),
  };
}
