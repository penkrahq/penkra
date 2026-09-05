import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Relaunched AppImages extract outside the test root. Match the exact inherited
// profile marker, not executable names or a substring of another user's path.
export function findNativeUpgradeProcesses(userData: string, procRoot = "/proc"): number[] {
  const marker = `PENKRA_DESKTOP_SMOKE_USER_DATA=${userData}`;
  return readdirSync(procRoot).flatMap((entry) => {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) return [];
    try {
      return readFileSync(join(procRoot, entry, "environ"), "utf8")
        .split("\0")
        .includes(marker)
        ? [Number(entry)]
        : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH" || code === "EACCES") return [];
      throw error;
    }
  });
}

export async function stopNativeUpgradeProcesses(userData: string): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const pid of findNativeUpgradeProcesses(userData)) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      if (findNativeUpgradeProcesses(userData).length === 0) return;
      await delay(100);
    }
  }
  throw new Error("Owned native upgrade processes remain; preserving their profile.");
}
