// FILE: appleAppiumServer.ts
// Purpose: Owns the loopback-only Appium daemon used by Apple simulator sessions.
// Layer: Trusted desktop simulator infrastructure

import ChildProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";

import { reserveSimulatorLoopbackPort } from "./simulatorLoopbackPort";

const APPIUM_START_TIMEOUT_MS = 30_000;
const APPIUM_STOP_TIMEOUT_MS = 5_000;

export interface AppleAppiumServer {
  baseUrl: string;
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

export class DefaultAppleAppiumServerLauncher {
  readonly #appiumExecutable: string;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #spawn: (
    executable: string,
    args: ReadonlyArray<string>,
    environment?: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams;

  constructor(input: {
    appiumExecutable: string;
    environment?: NodeJS.ProcessEnv;
    spawn?: (
      executable: string,
      args: ReadonlyArray<string>,
      environment?: NodeJS.ProcessEnv,
    ) => ChildProcessWithoutNullStreams;
  }) {
    this.#appiumExecutable = input.appiumExecutable;
    this.#environment = input.environment;
    this.#spawn = input.spawn ?? spawnAppium;
  }

  async start(signal?: AbortSignal): Promise<AppleAppiumServer> {
    const port = await reserveSimulatorLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = this.#spawn(
      this.#appiumExecutable,
      buildAppiumServerArguments(port),
      this.#environment,
    );
    const exited = processExit(child);
    try {
      await waitForAppium(baseUrl, exited, signal);
    } catch (error) {
      await stopProcess(child, exited);
      throw error;
    }
    let stopping: Promise<void> | undefined;
    return {
      baseUrl,
      exited,
      stop: () => {
        stopping ??= stopProcess(child, exited);
        return stopping;
      },
    };
  }
}

export function buildAppiumServerArguments(port: number): ReadonlyArray<string> {
  return [
    "server",
    "--address",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-path",
    "/",
    "--log-level",
    "warn",
  ];
}

async function waitForAppium(
  baseUrl: string,
  exited: AppleAppiumServer["exited"],
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + APPIUM_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw serverError("SESSION_CANCELLED", "Appium startup was cancelled.");
    if (await isExited(exited))
      throw serverError("APPIUM_START_FAILED", "Appium exited during startup.");
    try {
      const response = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The loopback listener is not ready yet.
    }
    await delay(100);
  }
  throw serverError("APPIUM_START_TIMEOUT", "Appium did not start in time.");
}

function spawnAppium(
  executable: string,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return ChildProcess.spawn(executable, [...args], {
    detached: true,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function processExit(child: ChildProcessWithoutNullStreams): AppleAppiumServer["exited"] {
  return new Promise((resolve) => {
    child.once("error", () => resolve({ exitCode: null, signal: null }));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  _exited: AppleAppiumServer["exited"],
): Promise<void> {
  const processGroupId = child.pid;
  if (!processGroupId) {
    child.kill();
    return;
  }
  const processGroups = [processGroupId, ...descendantProcessGroups(processGroupId)];
  await stopAppleAppiumProcessGroups({
    processGroups,
    signal: signalProcessGroup,
    waitForExit: waitForProcessGroupExit,
  });
}

export async function stopAppleAppiumProcessGroups(input: {
  processGroups: ReadonlyArray<number>;
  signal(processGroupId: number, signal: NodeJS.Signals): void;
  waitForExit(processGroupId: number, timeoutMs: number): Promise<boolean>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? APPIUM_STOP_TIMEOUT_MS;
  for (const groupId of input.processGroups) input.signal(groupId, "SIGTERM");
  const graceful = await Promise.all(
    input.processGroups.map((groupId) => input.waitForExit(groupId, timeoutMs)),
  );
  const remaining = input.processGroups.filter((_groupId, index) => !graceful[index]);
  for (const groupId of remaining) input.signal(groupId, "SIGKILL");
  const forceful = await Promise.all(
    remaining.map((groupId) => input.waitForExit(groupId, timeoutMs)),
  );
  const orphaned = remaining.filter((_groupId, index) => !forceful[index]);
  if (orphaned.length > 0) {
    throw serverError(
      "APPIUM_STOP_FAILED",
      `Appium process groups remain live after cleanup: ${orphaned.join(", ")}.`,
    );
  }
}

export function collectDescendantProcessGroups(
  rows: ReadonlyArray<{ pid: number; ppid: number; pgid: number }>,
  rootPid: number,
): ReadonlyArray<number> {
  return [
    ...new Set(
      rows
        .filter((row) => row.ppid === rootPid && row.pgid > 0 && row.pgid !== rootPid)
        .map((row) => row.pgid),
    ),
  ];
}

function descendantProcessGroups(rootPid: number): ReadonlyArray<number> {
  const result = ChildProcess.spawnSync("ps", ["-axo", "pid=,ppid=,pgid="], {
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  const rows = result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (columns): columns is [number, number, number] =>
        columns.length === 3 && columns.every(Number.isFinite),
    )
    .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
  return collectDescendantProcessGroups(rows, rootPid);
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId)) return true;
    await delay(100);
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
    if (isInaccessibleProcess(error)) return true;
    throw error;
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isInaccessibleProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}

function isExited(exited: AppleAppiumServer["exited"]): Promise<boolean> {
  return Promise.race([exited.then(() => true), Promise.resolve(false)]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function serverError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
