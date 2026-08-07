// FILE: penkra-dev-launcher.ts
// Purpose: Coordinate shared local services and independently numbered Penkra Dev desktops.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
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
import { resolvePenkraDevInstanceDefinition } from "./lib/penkra-dev-instance.ts";

declare const PENKRA_DEV_REPO_ROOT: string | undefined;
declare const PENKRA_DEV_BUN_EXECUTABLE: string | undefined;
declare const PENKRA_DEV_INSTANCE_NUMBER: string | undefined;

const SUPERVISOR_COMMAND = "supervise";
const compiledRepoRoot =
  typeof PENKRA_DEV_REPO_ROOT === "string" ? PENKRA_DEV_REPO_ROOT : undefined;
const compiledBunExecutable =
  typeof PENKRA_DEV_BUN_EXECUTABLE === "string" ? PENKRA_DEV_BUN_EXECUTABLE : undefined;
const compiledInstance =
  typeof PENKRA_DEV_INSTANCE_NUMBER === "string" ? PENKRA_DEV_INSTANCE_NUMBER : undefined;
const launcherInstance = resolvePenkraDevInstanceDefinition(compiledInstance).instance;
const repoRoot = resolve(
  compiledRepoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const launcherScriptPath = fileURLToPath(import.meta.url);
const launcherExecutablePath = compiledRepoRoot ? process.execPath : launcherScriptPath;

export interface PenkraDevLauncherPaths {
  readonly stateDirectory: string;
  readonly lockDirectory: string;
  readonly ownerPath: string;
  readonly statusPath: string;
  readonly failurePath: string;
  readonly logPath: string;
  readonly requestsDirectory: string;
  readonly readyPath: string;
  readonly instanceDirectory: string;
  readonly instanceStatusPath: string;
  readonly instanceLogPath: string;
  readonly developmentRoot: string;
}

export function resolvePenkraDevLauncherPaths(
  homeDirectory = homedir(),
  instance = launcherInstance,
): PenkraDevLauncherPaths {
  const definition = resolvePenkraDevInstanceDefinition(instance, homeDirectory);
  const sharedRoot = join(homeDirectory, "Penkra_Dev");
  const stateDirectory = join(sharedRoot, ".launcher");
  const instanceDirectory = join(stateDirectory, "instances", String(instance));
  return {
    stateDirectory,
    lockDirectory: join(stateDirectory, "coordinator.lock"),
    ownerPath: join(stateDirectory, "coordinator.lock", "owner.json"),
    statusPath: join(stateDirectory, "status.json"),
    failurePath: join(stateDirectory, "failure.json"),
    logPath: join(stateDirectory, "launcher.log"),
    requestsDirectory: join(stateDirectory, "requests"),
    readyPath: join(stateDirectory, "shared-ready.json"),
    instanceDirectory,
    instanceStatusPath: join(instanceDirectory, "status.json"),
    instanceLogPath: join(instanceDirectory, "launcher.log"),
    developmentRoot: definition.developmentRoot,
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
  return processes
    .filter(
      (entry) =>
        entry.parentPid === 1 &&
        entry.command.includes(join(desktopRoot, "apps", "desktop", ".electron-runtime")) &&
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
      "--shared-only",
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

function readOwner(paths: PenkraDevLauncherPaths): { pid: number; executable?: string } | null {
  try {
    const value = JSON.parse(readFileSync(paths.ownerPath, "utf8")) as {
      pid?: unknown;
      executable?: unknown;
    };
    return typeof value.pid === "number" && value.pid > 0
      ? {
          pid: value.pid,
          ...(typeof value.executable === "string" ? { executable: value.executable } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function supervisorIsRunning(paths: PenkraDevLauncherPaths): boolean {
  const owner = readOwner(paths);
  if (!owner) return false;
  try {
    process.kill(owner.pid, 0);
  } catch {
    return false;
  }
  return isExpectedPenkraDevSupervisorCommand(
    readProcessCommand(owner.pid),
    owner.executable ?? launcherExecutablePath,
  );
}

function developmentRuntimePath(instance: number): string {
  return join(
    repoRoot,
    "apps",
    "desktop",
    ".electron-runtime",
    "instances",
    String(instance),
    "Electron.app",
  );
}

function developmentElectronIsRunning(instance = launcherInstance): boolean {
  const marker = `--penkra-dev-instance=${instance}`;
  const result = spawnSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
  return result.status === 0 && result.stdout.split("\n").some((line) => line.includes(marker));
}

function focusDevelopmentElectron(instance = launcherInstance): boolean {
  if (!developmentElectronIsRunning(instance)) return false;
  const appPath = developmentRuntimePath(instance);
  const result = spawnSync("/usr/bin/open", [appPath], { encoding: "utf8" });
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
  if (readOwner(paths)?.pid === process.pid) {
    rmSync(paths.lockDirectory, { recursive: true, force: true });
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function writeStatus(paths: PenkraDevLauncherPaths, phase: string, detail: string): void {
  writeJson(paths.statusPath, {
    phase,
    detail,
    supervisorPid: process.pid,
    updatedAt: new Date().toISOString(),
  });
}

function writeInstanceStatus(instance: number, phase: string, detail: string): void {
  const paths = resolvePenkraDevLauncherPaths(homedir(), instance);
  writeJson(paths.instanceStatusPath, {
    instance,
    phase,
    detail,
    updatedAt: new Date().toISOString(),
  });
}

function resolveDockerExecutable(): string {
  const candidates = [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Docker CLI is not installed. Install Docker Desktop first.");
  return executable;
}

async function ensureDockerEngineReady(paths: PenkraDevLauncherPaths): Promise<void> {
  const docker = resolveDockerExecutable();
  await waitForDockerEngine({
    isReady: () =>
      spawnSync(docker, ["info", "--format", "{{.ServerVersion}}"], {
        stdio: "ignore",
        timeout: 5_000,
      }).status === 0,
    startDockerDesktop: () => {
      const result = spawnSync("/usr/bin/open", ["-gja", "/Applications/Docker.app"], {
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(`Could not open Docker Desktop: ${result.stderr}`);
    },
    sleep,
    onWaiting: () => writeStatus(paths, "waiting-for-docker", "Waiting for Docker Desktop."),
  });
}

function parseBunExecutable(args: readonly string[]): string {
  const index = args.indexOf("--bun");
  const candidate = index >= 0 ? args[index + 1]?.trim() : compiledBunExecutable?.trim();
  if (!candidate || !existsSync(candidate)) {
    throw new Error(`Penkra Dev launcher cannot find Bun: ${candidate ?? "not configured"}`);
  }
  return resolve(candidate);
}

function listDescendantPids(rootPid: number): number[] {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const descendants: number[] = [];
  const visit = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      visit(child);
      descendants.push(child);
    }
  };
  visit(rootPid);
  return descendants;
}

async function terminateProcessTree(rootPid: number, signal: NodeJS.Signals): Promise<void> {
  const pids = [...listDescendantPids(rootPid), rootPid];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (
      pids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      })
    )
      return;
    await sleep(100);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function enqueueLaunchRequest(instance: number): void {
  const paths = resolvePenkraDevLauncherPaths(homedir(), instance);
  mkdirSync(paths.requestsDirectory, { recursive: true, mode: 0o700 });
  writeJson(join(paths.requestsDirectory, `${instance}.json`), {
    instance,
    requestedAt: new Date().toISOString(),
  });
}

function takeLaunchRequests(paths: PenkraDevLauncherPaths): number[] {
  if (!existsSync(paths.requestsDirectory)) return [];
  const requests = readdirSync(paths.requestsDirectory)
    .filter((name) => /^\d+\.json$/u.test(name))
    .map((name) => Number(name.replace(/\.json$/u, "")))
    .filter((instance) => Number.isSafeInteger(instance) && instance > 0)
    .sort((left, right) => left - right);
  for (const instance of requests) {
    rmSync(join(paths.requestsDirectory, `${instance}.json`), { force: true });
  }
  return requests;
}

async function waitForSharedReadiness(paths: PenkraDevLauncherPaths, children: ChildProcess[]) {
  const requiredFiles = [
    join(repoRoot, "apps", "desktop", "dist-electron", "main.js"),
    join(repoRoot, "apps", "desktop", "dist-electron", "preload.js"),
    join(repoRoot, "apps", "server", "dist", "index.mjs"),
  ];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const failed = children.find((child) => child.exitCode !== null || child.signalCode !== null);
    if (failed) throw new Error("A shared Penkra Dev service exited during startup.");
    if (existsSync(paths.readyPath) && requiredFiles.every(existsSync)) {
      try {
        const response = await fetch("http://127.0.0.1:5733");
        if (response.ok) return;
      } catch {}
    }
    await sleep(250);
  }
  throw new Error("Penkra Dev shared services did not become ready within 3 minutes.");
}

function prepareInstanceHome(instance: number): void {
  if (instance === 1) return;
  const source = join(homedir(), "Penkra_Dev", ".penkra", "bin", "penkra");
  const target = join(
    resolvePenkraDevInstanceDefinition(instance).developmentRoot,
    ".penkra",
    "bin",
    "penkra",
  );
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  chmodSync(target, 0o700);
}

function startInstance(
  instance: number,
  bunExecutable: string,
  instances: Map<number, ChildProcess>,
): void {
  if (instances.has(instance)) {
    focusDevelopmentElectron(instance);
    return;
  }
  prepareInstanceHome(instance);
  const definition = resolvePenkraDevInstanceDefinition(instance);
  const paths = resolvePenkraDevLauncherPaths(homedir(), instance);
  mkdirSync(paths.instanceDirectory, { recursive: true, mode: 0o700 });
  const log = openSync(paths.instanceLogPath, "a", 0o600);
  const child = spawn(bunExecutable, ["run", "dev:electron"], {
    cwd: join(repoRoot, "apps", "desktop"),
    detached: true,
    env: {
      ...process.env,
      ELECTRON_RENDERER_PORT: "5733",
      PENKRA_API_URL: "http://localhost:3012",
      PENKRA_DEV_INSTANCE_NUMBER: String(instance),
      PENKRA_ROOT: definition.developmentRoot,
      PENKRA_WEBSITE_ORIGIN: "http://localhost:3000",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
    },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  instances.set(instance, child);
  writeInstanceStatus(instance, "starting", `Starting ${definition.displayName}.`);
  child.once("exit", (code, signal) => {
    instances.delete(instance);
    writeInstanceStatus(
      instance,
      code === 0 && signal === null ? "stopped" : "failed",
      `${definition.displayName} exited with ${signal ?? code ?? 0}.`,
    );
  });
  void waitForDevelopmentElectron({
    isRunning: () => developmentElectronIsRunning(instance),
    onRunning: () =>
      writeInstanceStatus(instance, "running", `${definition.displayName} is running.`),
    shouldContinue: () => instances.has(instance),
    sleep,
    timeoutMs: null,
  });
}

async function supervise(bunExecutable: string): Promise<void> {
  const paths = resolvePenkraDevLauncherPaths(homedir(), 1);
  const workspace = readPenkraDevWorkspace(resolvePenkraDevWorkspaceConfigPath());
  if (!acquireSupervisorLock(paths)) return;
  const instances = new Map<number, ChildProcess>();
  const sharedChildren: ChildProcess[] = [];
  let stopping = false;

  const stopAll = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled(
      [...instances.values(), ...sharedChildren]
        .filter((child) => child.pid)
        .map((child) => terminateProcessTree(child.pid!, signal)),
    );
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => void stopAll(signal));
  }

  try {
    writeJson(paths.ownerPath, {
      pid: process.pid,
      executable: launcherExecutablePath,
      desktopRoot: workspace.desktopRoot,
      backendRoot: workspace.backendRoot,
      websiteRoot: workspace.websiteRoot,
      startedAt: new Date().toISOString(),
    });
    writeStatus(paths, "starting", "Starting shared Penkra Dev services.");
    await ensureDockerEngineReady(paths);
    rmSync(paths.readyPath, { force: true });
    rmSync(paths.failurePath, { force: true });

    const workspaceCommand = resolvePenkraDevWorkspaceCommand(bunExecutable, workspace);
    const sharedEnvironment: NodeJS.ProcessEnv = {
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
      PENKRA_DEV_FAILURE_PATH: paths.failurePath,
      PENKRA_DEV_READY_PATH: paths.readyPath,
      PENKRA_DEV_ROOT: join(homedir(), "Penkra_Dev"),
    };
    delete sharedEnvironment.PENKRA_AUTH_TOKEN;

    sharedChildren.push(
      spawn(workspaceCommand.executable, workspaceCommand.args, {
        cwd: workspaceCommand.cwd,
        detached: true,
        env: sharedEnvironment,
        stdio: "inherit",
      }),
      spawn(bunExecutable, [join(repoRoot, "scripts", "dev-desktop-shared.mjs")], {
        cwd: repoRoot,
        detached: true,
        env: { ...sharedEnvironment, BUN_EXECUTABLE: bunExecutable },
        stdio: "inherit",
      }),
    );

    await waitForSharedReadiness(paths, sharedChildren);
    writeStatus(paths, "running", "Shared services are ready.");
    let launchedAnyInstance = false;
    let idleSince: number | null = null;
    while (!stopping) {
      const failedShared = sharedChildren.find(
        (child) => child.exitCode !== null || child.signalCode !== null,
      );
      if (failedShared) throw new Error("A shared Penkra Dev service exited unexpectedly.");
      for (const instance of takeLaunchRequests(paths)) {
        launchedAnyInstance = true;
        idleSince = null;
        startInstance(instance, bunExecutable, instances);
      }
      if (launchedAnyInstance && instances.size === 0) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= 1_000) break;
      } else {
        idleSince = null;
      }
      await sleep(200);
    }
    await stopAll("SIGTERM");
    writeStatus(paths, "stopped", "The last Penkra Dev instance closed.");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeStatus(paths, "failed", detail);
    writeJson(paths.failurePath, { message: detail, failedAt: new Date().toISOString() });
    await stopAll("SIGTERM");
    showFailureDialog(detail, paths.logPath);
    process.exitCode = 1;
  } finally {
    releaseSupervisorLock(paths);
  }
}

function showFailureDialog(detail: string, logPath: string): void {
  spawnSync(
    "/usr/bin/osascript",
    [
      "-e",
      "on run argv",
      "-e",
      'display dialog (item 1 of argv) with title "Penkra Dev could not start" buttons {"OK"} default button "OK" with icon stop',
      "-e",
      "end run",
      `${detail}\n\nThe detailed startup log is available at:\n${logPath}`,
    ],
    { stdio: "ignore" },
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function launchDetachedSupervisor(bunExecutable: string): void {
  const paths = resolvePenkraDevLauncherPaths();
  if (developmentElectronIsRunning()) {
    focusDevelopmentElectron();
    return;
  }
  enqueueLaunchRequest(launcherInstance);
  if (supervisorIsRunning(paths)) return;
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const log = openSync(paths.logPath, "a", 0o600);
  try {
    const args = compiledRepoRoot
      ? [SUPERVISOR_COMMAND, "--bun", bunExecutable]
      : [launcherScriptPath, SUPERVISOR_COMMAND, "--bun", bunExecutable];
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      detached: true,
      env: process.env,
      stdio: ["ignore", log, log],
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

export async function runPenkraDevLauncher(argv = process.argv): Promise<void> {
  const commandIndex = argv.findIndex(
    (argument) => argument === "launch" || argument === SUPERVISOR_COMMAND,
  );
  const [command = "launch", ...args] = argv.slice(commandIndex >= 0 ? commandIndex : 2);
  const bunExecutable = parseBunExecutable(args);
  if (command === "launch") return launchDetachedSupervisor(bunExecutable);
  if (command === SUPERVISOR_COMMAND) return supervise(bunExecutable);
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
