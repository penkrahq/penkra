import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const processStopSignals = ["SIGTERM", "SIGKILL"] as const;
const processScanIntervalMs = 100;
const processScansPerSignal = 20;
const requiredEmptyProcessScans = 5;

interface StopProcessesUntilQuiescentOptions {
  readonly findProcesses: () => number[];
  readonly signalProcess: (pid: number, signal: (typeof processStopSignals)[number]) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export async function stopProcessesUntilQuiescent({
  findProcesses,
  signalProcess,
  wait = delay,
}: StopProcessesUntilQuiescentOptions): Promise<void> {
  let emptyScans = 0;

  for (const signal of processStopSignals) {
    for (let scan = 0; scan < processScansPerSignal; scan += 1) {
      const processIds = findProcesses();
      if (processIds.length === 0) {
        emptyScans += 1;
        if (emptyScans >= requiredEmptyProcessScans) return;
      } else {
        emptyScans = 0;
        for (const pid of processIds) signalProcess(pid, signal);
      }
      await wait(processScanIntervalMs);
    }
  }

  const survivors = findProcesses();
  if (survivors.length > 0) {
    throw new Error(
      `Owned native upgrade processes remain after shutdown: ${survivors.join(", ")}.`,
    );
  }
  throw new Error("Native upgrade process ownership did not become quiescent after shutdown.");
}

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
  await stopProcessesUntilQuiescent({
    findProcesses: () => findNativeUpgradeProcesses(userData),
    signalProcess: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
  });
}
