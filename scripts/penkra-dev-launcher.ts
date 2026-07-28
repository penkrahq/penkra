// FILE: penkra-dev-launcher.ts
// Purpose: Own a detached Penkra desktop development stack launched from macOS Applications.

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPERVISOR_COMMAND = "supervise";
const DEVELOPMENT_BUNDLE_ID = "com.penkra.app.dev";
const DEV_INSTANCE_NAME = "penkra-app-launcher";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(repoRoot, "..");
const workspaceOrchestratorPath = join(workspaceRoot, "backend", "ops", "dev-workspace.mjs");
const launcherScriptPath = fileURLToPath(import.meta.url);

export interface PenkraDevLauncherPaths {
  readonly stateDirectory: string;
  readonly lockDirectory: string;
  readonly ownerPath: string;
  readonly logPath: string;
  readonly developmentRoot: string;
}

export function resolvePenkraDevLauncherPaths(homeDirectory = homedir()): PenkraDevLauncherPaths {
  const stateDirectory = join(
    homeDirectory,
    "Library",
    "Application Support",
    "Penkra Dev Launcher",
  );
  return {
    stateDirectory,
    lockDirectory: join(stateDirectory, "supervisor.lock"),
    ownerPath: join(stateDirectory, "supervisor.lock", "owner.json"),
    logPath: join(stateDirectory, "launcher.log"),
    developmentRoot: join(homeDirectory, "Penkra_Dev"),
  };
}

export function isExpectedPenkraDevSupervisorCommand(
  command: string,
  expectedScriptPath = launcherScriptPath,
): boolean {
  return command.includes(expectedScriptPath) && command.includes(` ${SUPERVISOR_COMMAND}`);
}

export interface PenkraDevWorkspaceCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function resolvePenkraDevWorkspaceCommand(
  nodeExecutable = process.execPath,
  orchestratorPath = workspaceOrchestratorPath,
): PenkraDevWorkspaceCommand {
  return {
    executable: resolve(nodeExecutable),
    args: [resolve(orchestratorPath)],
    cwd: resolve(orchestratorPath, "..", "..", ".."),
  };
}

function readProcessCommand(pid: number): string {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readOwnerPid(paths: PenkraDevLauncherPaths): number | null {
  try {
    const parsed = JSON.parse(readFileSync(paths.ownerPath, "utf8")) as {
      pid?: unknown;
    };
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null;
  } catch {
    return null;
  }
}

function supervisorIsRunning(paths: PenkraDevLauncherPaths): boolean {
  const pid = readOwnerPid(paths);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return isExpectedPenkraDevSupervisorCommand(readProcessCommand(pid));
}

function developmentElectronIsRunning(): boolean {
  const marker = `--synara-dev-root=${join(repoRoot, "apps", "desktop")}`;
  const result = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.split("\n").some((line) => line.includes(marker));
}

function focusDevelopmentElectron(): boolean {
  if (!developmentElectronIsRunning()) return false;
  const result = spawnSync(
    "/usr/bin/osascript",
    ["-e", `tell application id "${DEVELOPMENT_BUNDLE_ID}" to activate`],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

async function focusDevelopmentElectronWhenReady(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (focusDevelopmentElectron()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

function acquireSupervisorLock(paths: PenkraDevLauncherPaths): boolean {
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(paths.lockDirectory, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (supervisorIsRunning(paths)) return false;
  rmSync(paths.lockDirectory, { recursive: true, force: true });
  mkdirSync(paths.lockDirectory, { mode: 0o700 });
  return true;
}

function releaseSupervisorLock(paths: PenkraDevLauncherPaths): void {
  if (readOwnerPid(paths) === process.pid) {
    rmSync(paths.lockDirectory, { recursive: true, force: true });
  }
}

function parseBunExecutable(args: readonly string[]): string {
  const index = args.indexOf("--bun");
  const candidate = index >= 0 ? args[index + 1]?.trim() : "";
  if (!candidate || !existsSync(candidate)) {
    throw new Error(`Penkra Dev launcher cannot find its configured Bun executable: ${candidate}`);
  }
  return resolve(candidate);
}

function listDescendantPids(rootPid: number): number[] {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];

  const childrenByParent = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const [pidText, parentPidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) continue;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const descendants: number[] = [];
  const visit = (parentPid: number) => {
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      visit(childPid);
      descendants.push(childPid);
    }
  };
  visit(rootPid);
  return descendants;
}

function signalProcesses(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function terminateProcessTree(rootPid: number, signal: NodeJS.Signals): Promise<void> {
  const pids = [...listDescendantPids(rootPid), rootPid];
  signalProcesses(pids, signal);

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const runningPids = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (runningPids.length === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  signalProcesses(pids, "SIGKILL");
}

async function supervise(bunExecutable: string): Promise<void> {
  const paths = resolvePenkraDevLauncherPaths();
  const workspaceCommand = resolvePenkraDevWorkspaceCommand();
  if (!existsSync(workspaceCommand.args[0]!)) {
    throw new Error(
      `Penkra Dev launcher cannot find the full-workspace orchestrator: ${workspaceCommand.args[0]}`,
    );
  }
  if (!acquireSupervisorLock(paths)) {
    await focusDevelopmentElectronWhenReady();
    return;
  }

  writeFileSync(
    paths.ownerPath,
    `${JSON.stringify(
      {
        pid: process.pid,
        repoRoot,
        workspaceRoot,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [
      dirname(bunExecutable),
      join(repoRoot, "node_modules", ".bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    PENKRA_DEV_SUPERVISOR_PID: String(process.pid),
    PENKRA_DEV_ROOT: paths.developmentRoot,
    SYNARA_DEV_INSTANCE: DEV_INSTANCE_NAME,
  };
  delete environment.SYNARA_AUTH_TOKEN;

  const child = spawn(workspaceCommand.executable, workspaceCommand.args, {
    cwd: workspaceCommand.cwd,
    detached: true,
    env: environment,
    stdio: "inherit",
  });

  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) {
      stopPromise = terminateProcessTree(child.pid!, signal);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => stop(signal));
  }

  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });
  await stopPromise;
  releaseSupervisorLock(paths);
  process.exitCode = exitCode;
}

process.once("exit", () => {
  const paths = resolvePenkraDevLauncherPaths();
  if (readOwnerPid(paths) === process.pid) {
    releaseSupervisorLock(paths);
  }
});

function launchDetachedSupervisor(bunExecutable: string): void {
  const paths = resolvePenkraDevLauncherPaths();
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  if (supervisorIsRunning(paths)) {
    void focusDevelopmentElectronWhenReady();
    return;
  }

  const logDescriptor = openSync(paths.logPath, "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [launcherScriptPath, SUPERVISOR_COMMAND, "--bun", bunExecutable],
      {
        cwd: repoRoot,
        detached: true,
        env: process.env,
        stdio: ["ignore", logDescriptor, logDescriptor],
      },
    );
    child.unref();
  } finally {
    closeSync(logDescriptor);
  }
}

async function main(): Promise<void> {
  const [command = "launch", ...args] = process.argv.slice(2);
  const bunExecutable = parseBunExecutable(args);
  if (command === "launch") {
    launchDetachedSupervisor(bunExecutable);
    return;
  }
  if (command === SUPERVISOR_COMMAND) {
    await supervise(bunExecutable);
    return;
  }
  throw new Error(`Unknown Penkra Dev launcher command: ${command}`);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `[penkra-dev-launcher] ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
