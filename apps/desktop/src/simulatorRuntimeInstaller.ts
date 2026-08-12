// FILE: simulatorRuntimeInstaller.ts
// Purpose: Owns cancellable, long-running official simulator-runtime installers.
// Layer: Trusted desktop simulator infrastructure

import ChildProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STOP_TIMEOUT_MS = 5_000;

export interface SimulatorRuntimeInstallInput {
  executable: string;
  args: ReadonlyArray<string>;
  signal: AbortSignal;
}

export interface SimulatorRuntimeInstaller {
  install(input: SimulatorRuntimeInstallInput): Promise<void>;
}

export class DefaultSimulatorRuntimeInstaller implements SimulatorRuntimeInstaller {
  readonly #spawn: (
    executable: string,
    args: ReadonlyArray<string>,
  ) => ChildProcessWithoutNullStreams;
  readonly #stop: (child: ChildProcessWithoutNullStreams) => Promise<void>;

  constructor(
    input: {
      spawn?: (executable: string, args: ReadonlyArray<string>) => ChildProcessWithoutNullStreams;
      stop?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
    } = {},
  ) {
    this.#spawn = input.spawn ?? spawnSimulatorSetupProcess;
    this.#stop = input.stop ?? stopSimulatorSetupProcess;
  }

  install(input: SimulatorRuntimeInstallInput): Promise<void> {
    if (!input.executable || input.executable.includes("\0")) {
      throw installerError("INVALID_COMMAND", "Runtime installer executable is invalid.");
    }
    if (input.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
      throw installerError("INVALID_COMMAND", "Runtime installer arguments are invalid.");
    }
    if (input.signal.aborted) {
      throw installerError("SETUP_CANCELLED", "Runtime setup was cancelled.");
    }

    const child = this.#spawn(input.executable, input.args);
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let stopping: Promise<void> | null = null;

      const collect = (target: Buffer[], chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          void stopAndReject(
            installerError(
              "OUTPUT_LIMIT_EXCEEDED",
              "Runtime installer output exceeded the trusted host limit.",
            ),
          );
          return;
        }
        target.push(Buffer.from(chunk));
      };
      const cleanup = () => input.signal.removeEventListener("abort", abort);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const stopAndReject = async (error: Error) => {
        stopping ??= this.#stop(child);
        try {
          await stopping;
        } catch (stopError) {
          error = new AggregateError([error, stopError], "Runtime installer cleanup failed.");
          Object.assign(error, { code: "SETUP_CLEANUP_FAILED" });
        }
        finish(() => reject(error));
      };
      const abort = () => {
        void stopAndReject(installerError("SETUP_CANCELLED", "Runtime setup was cancelled."));
      };

      input.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (exitCode, signal) => {
        if (settled || stopping) return;
        const stderrText = Buffer.concat(stderr).toString("utf8").trim();
        if (exitCode !== 0) {
          finish(() =>
            reject(
              Object.assign(
                installerError(
                  "RUNTIME_INSTALL_FAILED",
                  stderrText || `Runtime installer exited with code ${exitCode ?? "unknown"}.`,
                ),
                { exitCode, signal, stderr: stderrText },
              ),
            ),
          );
          return;
        }
        finish(resolve);
      });
      child.stdin.end();
    });
  }
}

export function spawnSimulatorSetupProcess(
  executable: string,
  args: ReadonlyArray<string>,
): ChildProcessWithoutNullStreams {
  return ChildProcess.spawn(executable, [...args], {
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function stopSimulatorSetupProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    await stopWindowsTree(pid);
    return;
  }
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, STOP_TIMEOUT_MS)) return;
  signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, STOP_TIMEOUT_MS))) {
    throw installerError(
      "SETUP_STOP_FAILED",
      `Runtime installer process group ${pid} remains live after cleanup.`,
    );
  }
}

async function stopWindowsTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const killer = ChildProcess.spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", reject);
    killer.once("close", (code) => {
      if (code === 0 || code === 128) resolve();
      else reject(installerError("SETUP_STOP_FAILED", `taskkill exited with code ${code}.`));
    });
  });
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processGroupExists(processGroupId);
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw error;
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function installerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
