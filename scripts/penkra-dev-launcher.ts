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

import {
  readPenkraDevWorkspace,
  resolvePenkraDevWorkspaceConfigPath,
  type PenkraDevWorkspace,
} from "./lib/penkra-dev-workspace.ts";

declare const PENKRA_DEV_REPO_ROOT: string | undefined;
declare const PENKRA_DEV_BUN_EXECUTABLE: string | undefined;

const SUPERVISOR_COMMAND = "supervise";
const DEV_INSTANCE_NAME = "penkra-app-launcher";
const compiledRepoRoot =
  typeof PENKRA_DEV_REPO_ROOT === "string" ? PENKRA_DEV_REPO_ROOT : undefined;
const compiledBunExecutable =
  typeof PENKRA_DEV_BUN_EXECUTABLE === "string" ? PENKRA_DEV_BUN_EXECUTABLE : undefined;
const repoRoot = resolve(
  compiledRepoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const launcherScriptPath = fileURLToPath(import.meta.url);
const launcherExecutablePath = compiledRepoRoot ? process.execPath : launcherScriptPath;
const developmentAppPath = join(
  repoRoot,
  "apps",
  "desktop",
  ".electron-runtime",
  "Penkra (Dev).app",
);

export interface PenkraDevLauncherPaths {
  readonly stateDirectory: string;
  readonly lockDirectory: string;
  readonly ownerPath: string;
  readonly statusPath: string;
  readonly failurePath: string;
  readonly logPath: string;
  readonly developmentRoot: string;
}

export function resolvePenkraDevLauncherPaths(homeDirectory = homedir()): PenkraDevLauncherPaths {
  const developmentRoot = join(homeDirectory, "Penkra_Dev");
  const stateDirectory = join(developmentRoot, ".launcher");
  return {
    stateDirectory,
    lockDirectory: join(stateDirectory, "supervisor.lock"),
    ownerPath: join(stateDirectory, "supervisor.lock", "owner.json"),
    statusPath: join(stateDirectory, "status.json"),
    failurePath: join(stateDirectory, "failure.json"),
    logPath: join(stateDirectory, "launcher.log"),
    developmentRoot,
  };
}

export interface DockerReadinessOptions {
  readonly isReady: () => boolean;
  readonly startDockerDesktop: () => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly onWaiting?: () => void;
}

export async function waitForDockerEngine({
  isReady,
  startDockerDesktop,
  sleep,
  timeoutMs = 120_000,
  pollIntervalMs = 1_000,
  onWaiting,
}: DockerReadinessOptions): Promise<"already-ready" | "started"> {
  if (isReady()) return "already-ready";

  startDockerDesktop();
  onWaiting?.();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (isReady()) return "started";
  }
  throw new Error(
    `Docker Desktop did not become ready within ${Math.ceil(timeoutMs / 1_000)} seconds.`,
  );
}

export function isExpectedPenkraDevSupervisorCommand(
  command: string,
  expectedLauncherPath = launcherExecutablePath,
): boolean {
  return command.includes(expectedLauncherPath) && command.includes(` ${SUPERVISOR_COMMAND}`);
}

export interface PenkraDevWorkspaceCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ProcessSnapshotEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly command: string;
}

export function resolveOrphanedWorkspaceProcessRoots(
  processes: readonly ProcessSnapshotEntry[],
  workspaceRoots: readonly string[],
): number[] {
  const processByPid = new Map(processes.map((entry) => [entry.pid, entry] as const));
  const orphanedRoots = new Set<number>();

  for (const processEntry of processes) {
    if (!workspaceRoots.some((root) => processEntry.command.includes(root))) continue;

    let root = processEntry;
    const visited = new Set<number>();
    while (root.parentPid > 1 && !visited.has(root.pid)) {
      visited.add(root.pid);
      const parent = processByPid.get(root.parentPid);
      if (!parent) break;
      root = parent;
    }
    if (root.parentPid === 1) orphanedRoots.add(root.pid);
  }

  return [...orphanedRoots].sort((left, right) => left - right);
}

export function resolveOrphanedDesktopBackendPids(
  processes: readonly ProcessSnapshotEntry[],
  desktopRoot: string,
): number[] {
  const backendEntry = join(desktopRoot, "apps", "server", "dist", "index.mjs");
  const developmentExecutable = join(
    desktopRoot,
    "apps",
    "desktop",
    ".electron-runtime",
    "Penkra (Dev).app",
    "Contents",
    "MacOS",
    "Penkra (Dev)",
  );

  return processes
    .filter(
      (entry) =>
        entry.parentPid === 1 &&
        entry.command.includes(developmentExecutable) &&
        entry.command.includes(backendEntry),
    )
    .map((entry) => entry.pid)
    .sort((left, right) => left - right);
}

export function resolvePenkraDevWorkspaceCommand(
  runtimeExecutable: string,
  workspace: PenkraDevWorkspace,
): PenkraDevWorkspaceCommand {
  const orchestratorPath = join(workspace.backendRoot, "ops", "dev-workspace.mjs");
  return {
    executable: resolve(runtimeExecutable),
    args: [
      orchestratorPath,
      "--desktop-root",
      workspace.desktopRoot,
      "--website-root",
      workspace.websiteRoot,
    ],
    cwd: workspace.backendRoot,
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
  const marker = `--penkra-dev-root=${join(repoRoot, "apps", "desktop")}`;
  const result = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.split("\n").some((line) => line.includes(marker));
}

function focusDevelopmentElectron(): boolean {
  if (!developmentElectronIsRunning()) return false;
  const result = spawnSync(
    "/usr/bin/osascript",
    ["-e", `tell application "${developmentAppPath}" to activate`],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

export interface DevelopmentElectronReadinessOptions {
  readonly isRunning: () => boolean;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly onRunning?: () => void;
  readonly pollIntervalMs?: number;
  readonly shouldContinue?: () => boolean;
  readonly timeoutMs?: number | null;
}

export async function waitForDevelopmentElectron({
  isRunning,
  sleep,
  onRunning,
  pollIntervalMs = 200,
  shouldContinue = () => true,
  timeoutMs = 10_000,
}: DevelopmentElectronReadinessOptions): Promise<boolean> {
  const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
  while (shouldContinue() && (deadline === null || Date.now() < deadline)) {
    if (isRunning()) {
      onRunning?.();
      return true;
    }
    await sleep(pollIntervalMs);
  }
  return false;
}

async function focusDevelopmentElectronWhenReady(
  timeoutMs: number | null = 10_000,
  shouldContinue = () => true,
): Promise<boolean> {
  return waitForDevelopmentElectron({
    isRunning: developmentElectronIsRunning,
    onRunning: () => {
      focusDevelopmentElectron();
    },
    shouldContinue,
    sleep: (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    timeoutMs,
  });
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

type LauncherStatusPhase =
  | "starting"
  | "waiting-for-docker"
  | "starting-workspace"
  | "running"
  | "failed"
  | "stopped";

function writeLauncherStatus(
  paths: PenkraDevLauncherPaths,
  phase: LauncherStatusPhase,
  detail: string,
): void {
  writeFileSync(
    paths.statusPath,
    `${JSON.stringify(
      {
        phase,
        detail,
        supervisorPid: process.pid,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function resolveDockerExecutable(): string {
  const candidates = [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      "Docker CLI is not installed. Install Docker Desktop before launching Penkra (Dev).",
    );
  }
  return executable;
}

function dockerEngineIsReady(dockerExecutable: string): boolean {
  const result = spawnSync(dockerExecutable, ["info", "--format", "{{.ServerVersion}}"], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return result.status === 0;
}

async function ensureDockerEngineReady(paths: PenkraDevLauncherPaths): Promise<void> {
  const dockerExecutable = resolveDockerExecutable();
  await waitForDockerEngine({
    isReady: () => dockerEngineIsReady(dockerExecutable),
    startDockerDesktop: () => {
      if (!existsSync("/Applications/Docker.app")) {
        throw new Error(
          "Docker Desktop is not installed in Applications. Install it before launching Penkra (Dev).",
        );
      }
      const result = spawnSync("/usr/bin/open", ["-gja", "/Applications/Docker.app"], {
        encoding: "utf8",
      });
      if (result.status !== 0) {
        throw new Error(`Could not open Docker Desktop: ${result.stderr.trim()}`);
      }
    },
    sleep: (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    onWaiting: () =>
      writeLauncherStatus(
        paths,
        "waiting-for-docker",
        "Waiting for the Docker Desktop engine to become ready.",
      ),
  });
}

type FailureAction = "quit" | "retry" | "view-log";

function showFailureDialog(message: string): FailureAction {
  const script = [
    "on run argv",
    "set failureMessage to item 1 of argv",
    'display dialog failureMessage with title "Penkra (Dev) could not start" buttons {"Quit", "View Log", "Retry"} default button "Retry" cancel button "Quit" with icon stop',
    "return button returned of result",
    "end run",
  ];
  const result = spawnSync(
    "/usr/bin/osascript",
    script.flatMap((line) => ["-e", line]).concat(message),
    { encoding: "utf8" },
  );
  if (result.status !== 0) return "quit";
  switch (result.stdout.trim()) {
    case "Retry":
      return "retry";
    case "View Log":
      return "view-log";
    default:
      return "quit";
  }
}

function revealLauncherLog(logPath: string): void {
  spawnSync("/usr/bin/open", ["-R", logPath], { stdio: "ignore" });
}

function readWorkspaceFailure(paths: PenkraDevLauncherPaths): string | null {
  try {
    const parsed = JSON.parse(readFileSync(paths.failurePath, "utf8")) as {
      message?: unknown;
    };
    return typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message.trim()
      : null;
  } catch {
    return null;
  }
}

function parseBunExecutable(args: readonly string[]): string {
  const index = args.indexOf("--bun");
  const candidate = index >= 0 ? args[index + 1]?.trim() : compiledBunExecutable?.trim();
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

function readProcessSnapshot(): ProcessSnapshotEntry[] {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];

  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) return [];
    return [{ pid, parentPid, command: match[3] ?? "" } satisfies ProcessSnapshotEntry];
  });
}

async function cleanupOrphanedWorkspaceProcesses(workspace: PenkraDevWorkspace): Promise<void> {
  const processes = readProcessSnapshot();
  const orphanedRoots = [
    ...new Set([
      ...resolveOrphanedWorkspaceProcessRoots(processes, [
        workspace.backendRoot,
        workspace.websiteRoot,
      ]),
      ...resolveOrphanedDesktopBackendPids(processes, workspace.desktopRoot),
    ]),
  ].filter((pid) => pid !== process.pid);

  for (const pid of orphanedRoots) {
    await terminateProcessTree(pid, "SIGTERM");
  }
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
  const workspace = readPenkraDevWorkspace(resolvePenkraDevWorkspaceConfigPath());
  const workspaceCommand = resolvePenkraDevWorkspaceCommand(bunExecutable, workspace);
  if (!existsSync(workspaceCommand.args[0]!)) {
    throw new Error(
      `Penkra Dev launcher cannot find the full-workspace orchestrator: ${workspaceCommand.args[0]}`,
    );
  }
  if (!acquireSupervisorLock(paths)) {
    await focusDevelopmentElectronWhenReady();
    return;
  }

  try {
    writeFileSync(
      paths.ownerPath,
      `${JSON.stringify(
        {
          pid: process.pid,
          desktopRoot: workspace.desktopRoot,
          backendRoot: workspace.backendRoot,
          websiteRoot: workspace.websiteRoot,
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
      PENKRA_DEV_FAILURE_PATH: paths.failurePath,
      PENKRA_DEV_ROOT: paths.developmentRoot,
      PENKRA_SKIP_LOGIN_SHELL_ENVIRONMENT: "1",
      PENKRA_DEV_INSTANCE: DEV_INSTANCE_NAME,
    };
    delete environment.PENKRA_AUTH_TOKEN;

    while (true) {
      try {
        writeLauncherStatus(paths, "starting", "Checking local development prerequisites.");
        await ensureDockerEngineReady(paths);
        await cleanupOrphanedWorkspaceProcesses(workspace);
        writeLauncherStatus(paths, "starting-workspace", "Starting the local Penkra workspace.");
        rmSync(paths.failurePath, { force: true });

        const child = spawn(workspaceCommand.executable, workspaceCommand.args, {
          cwd: workspaceCommand.cwd,
          detached: true,
          env: environment,
          stdio: "inherit",
        });

        let stopping = false;
        let stopPromise: Promise<void> | null = null;
        let childActive = true;
        const stop = (signal: NodeJS.Signals) => {
          if (stopping) return;
          stopping = true;
          if (child.exitCode === null && child.signalCode === null) {
            stopPromise = terminateProcessTree(child.pid!, signal);
          }
        };
        const signalHandlers = new Map<NodeJS.Signals, () => void>();
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
          const handler = () => stop(signal);
          signalHandlers.set(signal, handler);
          process.once(signal, handler);
        }

        const focusPromise = focusDevelopmentElectronWhenReady(null, () => childActive).then(
          (running) => {
            if (running) {
              writeLauncherStatus(paths, "running", "Penkra (Dev) is running.");
            }
          },
        );

        let exitCode: number;
        try {
          exitCode = await new Promise<number>((resolveExit, rejectExit) => {
            child.once("error", rejectExit);
            child.once("exit", (code, signal) => {
              resolveExit(code ?? (signal ? 1 : 0));
            });
          });
        } finally {
          childActive = false;
          for (const [signal, handler] of signalHandlers) {
            process.removeListener(signal, handler);
          }
          await focusPromise;
        }
        await stopPromise;
        if (exitCode === 0 || stopping) {
          writeLauncherStatus(paths, "stopped", "Penkra (Dev) stopped.");
          process.exitCode = exitCode;
          return;
        }
        throw new Error(
          readWorkspaceFailure(paths) ?? `The local workspace exited with code ${exitCode}.`,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        writeLauncherStatus(paths, "failed", detail);
        const action = showFailureDialog(
          `${detail}\n\nThe detailed startup log is available at:\n${paths.logPath}`,
        );
        if (action === "retry") continue;
        if (action === "view-log") revealLauncherLog(paths.logPath);
        process.exitCode = 1;
        return;
      }
    }
  } finally {
    releaseSupervisorLock(paths);
  }
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
  if (developmentElectronIsRunning()) {
    void focusDevelopmentElectronWhenReady();
    return;
  }
  if (supervisorIsRunning(paths)) {
    void focusDevelopmentElectronWhenReady();
    return;
  }

  const logDescriptor = openSync(paths.logPath, "a", 0o600);
  try {
    const launcherArgs = compiledRepoRoot
      ? [SUPERVISOR_COMMAND, "--bun", bunExecutable]
      : [launcherScriptPath, SUPERVISOR_COMMAND, "--bun", bunExecutable];
    const child = spawn(process.execPath, launcherArgs, {
      cwd: repoRoot,
      detached: true,
      env: process.env,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    child.unref();
  } finally {
    closeSync(logDescriptor);
  }
}

export async function runPenkraDevLauncher(argv = process.argv): Promise<void> {
  const commandIndex = argv.findIndex(
    (argument) => argument === "launch" || argument === SUPERVISOR_COMMAND,
  );
  const [command = "launch", ...args] = argv.slice(commandIndex >= 0 ? commandIndex : 2);
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

export function shouldRunPenkraDevLauncher(input: {
  readonly compiledRepoRoot: string | undefined;
  readonly importMetaMain: boolean;
  readonly argvEntry: string | undefined;
  readonly sourcePath: string;
}): boolean {
  return (
    input.compiledRepoRoot !== undefined ||
    input.importMetaMain ||
    (input.argvEntry !== undefined && resolve(input.argvEntry) === resolve(input.sourcePath))
  );
}

const isDirectExecution = shouldRunPenkraDevLauncher({
  compiledRepoRoot,
  importMetaMain: (import.meta as ImportMeta & { readonly main?: boolean }).main === true,
  argvEntry: process.argv[1],
  sourcePath: fileURLToPath(import.meta.url),
});
if (isDirectExecution) {
  void runPenkraDevLauncher().catch((error: unknown) => {
    process.stderr.write(
      `[penkra-dev-launcher] ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
