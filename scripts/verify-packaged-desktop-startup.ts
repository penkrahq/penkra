#!/usr/bin/env node
// FILE: verify-packaged-desktop-startup.ts
// Purpose: Launches a packaged desktop payload from an isolated temporary tree before upload.
// Layer: Release verification script

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PackagedDesktopPlatform = "linux" | "mac" | "win";

export interface PackagedDesktopStartupOptions {
  readonly assetsDirectory: string;
  readonly platform: PackagedDesktopPlatform;
  readonly arch: string;
  readonly version: string;
  readonly timeoutMs: number;
}

export function parsePackagedDesktopStartupArgs(
  argv: ReadonlyArray<string>,
): PackagedDesktopStartupOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid packaged startup argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  const known = new Set(["--assets-dir", "--platform", "--arch", "--version", "--timeout-ms"]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown packaged startup argument: ${name}.`);
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`Missing packaged startup argument: ${name}.`);
    return value;
  };
  const platform = required("--platform");
  if (platform !== "linux" && platform !== "mac" && platform !== "win") {
    throw new Error(`Unsupported packaged startup platform: ${platform}.`);
  }
  const timeoutMs = Number(values.get("--timeout-ms") ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) {
    throw new Error("--timeout-ms must be an integer between 5000 and 180000.");
  }
  return {
    assetsDirectory: resolve(required("--assets-dir")),
    platform,
    arch: required("--arch"),
    version: required("--version"),
    timeoutMs,
  };
}

function runCommand(command: string, args: ReadonlyArray<string>, cwd?: string): void {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}.`);
  }
}

function findFiles(root: string, predicate: (path: string) => boolean): string[] {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && predicate(candidate)) {
        matches.push(candidate);
      }
    }
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

function requireSingleAsset(directory: string, suffix: string): string {
  const matches = readdirSync(directory)
    .map((entry) => join(directory, entry))
    .filter((candidate) => statSync(candidate).isFile() && candidate.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${suffix} release asset, found ${matches.length}.`);
  }
  return matches[0]!;
}

interface LaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly macAppExecutable?: string;
}

function prepareMacLaunch(assetsDirectory: string, extractionRoot: string): LaunchCommand {
  const archive = requireSingleAsset(assetsDirectory, ".zip");
  runCommand("ditto", ["-x", "-k", archive, extractionRoot]);
  const appBundles = readdirSync(extractionRoot).filter((entry) => entry.endsWith(".app"));
  if (appBundles.length !== 1) {
    throw new Error(`Expected one packaged macOS app in ${basename(archive)}.`);
  }
  const appBundle = join(extractionRoot, appBundles[0]!);
  runCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appBundle]);
  const executables = findFiles(join(appBundle, "Contents", "MacOS"), (candidate) =>
    statSync(candidate).isFile(),
  );
  if (executables.length !== 1) {
    throw new Error(`Expected one macOS main executable, found ${executables.length}.`);
  }
  return {
    command: "open",
    args: ["-n", "-W", "-g", appBundle],
    cwd: appBundle,
    macAppExecutable: executables[0]!,
  };
}

function prepareLinuxLaunch(assetsDirectory: string, extractionRoot: string): LaunchCommand {
  const collectedAppImage = requireSingleAsset(assetsDirectory, ".AppImage");
  const appImage = join(extractionRoot, basename(collectedAppImage));
  copyFileSync(collectedAppImage, appImage);
  chmodSync(appImage, 0o755);
  runCommand(appImage, ["--appimage-extract"], extractionRoot);
  const appRun = join(extractionRoot, "squashfs-root", "AppRun");
  if (!existsSync(appRun)) {
    throw new Error(`${basename(appImage)} did not extract a runnable AppRun payload.`);
  }
  chmodSync(appRun, 0o755);
  return {
    command: "xvfb-run",
    args: ["-a", appRun, "--no-sandbox", "--disable-gpu"],
    cwd: join(extractionRoot, "squashfs-root"),
  };
}

function prepareWindowsLaunch(assetsDirectory: string, extractionRoot: string): LaunchCommand {
  const installer = requireSingleAsset(assetsDirectory, ".exe");
  const installerRoot = join(extractionRoot, "installer");
  const applicationRoot = join(extractionRoot, "application");
  mkdirSync(installerRoot, { recursive: true });
  mkdirSync(applicationRoot, { recursive: true });
  runCommand("7z", ["x", "-y", `-o${installerRoot}`, installer]);
  const applicationArchives = findFiles(installerRoot, (candidate) =>
    /[/\\]app-(?:32|64|arm64)\.7z$/i.test(candidate),
  );
  if (applicationArchives.length !== 1) {
    throw new Error(
      `Expected one embedded NSIS application archive, found ${applicationArchives.length}.`,
    );
  }
  runCommand("7z", ["x", "-y", `-o${applicationRoot}`, applicationArchives[0]!]);
  const executables = findFiles(applicationRoot, (candidate) =>
    /[/\\]Penkra\.exe$/i.test(candidate),
  );
  if (executables.length !== 1) {
    throw new Error(`Expected one extracted Penkra.exe, found ${executables.length}.`);
  }
  return { command: executables[0]!, args: [], cwd: dirname(executables[0]!) };
}

function prepareLaunch(
  options: PackagedDesktopStartupOptions,
  extractionRoot: string,
): LaunchCommand {
  if (options.platform === "mac") {
    return prepareMacLaunch(options.assetsDirectory, extractionRoot);
  }
  if (options.platform === "linux") {
    return prepareLinuxLaunch(options.assetsDirectory, extractionRoot);
  }
  return prepareWindowsLaunch(options.assetsDirectory, extractionRoot);
}

export function createPackagedDesktopSmokeEnvironment(
  root: string,
  options: Pick<PackagedDesktopStartupOptions, "platform" | "version">,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const homeDirectory = join(root, "home");
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    PENKRA_DESKTOP_SMOKE_USER_DATA: join(root, "user-data"),
    PENKRA_DISABLE_AUTO_UPDATE: "1",
    ELECTRON_ENABLE_LOGGING: "1",
  };
  delete env.PENKRA_AUTH_TOKEN;
  delete env.PENKRA_HOME;
  delete env.ELECTRON_RUN_AS_NODE;
  for (const path of [
    env.HOME,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.PENKRA_DESKTOP_SMOKE_USER_DATA,
  ]) {
    if (path) mkdirSync(path, { recursive: true });
  }
  const appDataBase =
    options.platform === "mac"
      ? join(homeDirectory, "Library", "Application Support")
      : options.platform === "win"
        ? env.APPDATA!
        : env.XDG_CONFIG_HOME!;
  const penkraRoot = resolvePackagedDesktopSmokePenkraRoot(root);
  const pointerDirectory = join(appDataBase, "Penkra");
  mkdirSync(pointerDirectory, { recursive: true });
  mkdirSync(penkraRoot, { recursive: true });
  writeFileSync(
    join(pointerDirectory, "root.json"),
    `${JSON.stringify({ root: penkraRoot }, null, 2)}\n`,
  );
  if (options.platform === "mac") {
    const userDataPath = join(appDataBase, "penkra");
    mkdirSync(userDataPath, { recursive: true });
    // Prevent the packaged app's update-only icon repair from registering this
    // temporary bundle in the runner's normal Launch Services database.
    const launchVersionPath = join(userDataPath, "last-launch-version.json");
    writeFileSync(launchVersionPath, `${JSON.stringify({ version: options.version }, null, 2)}\n`);
  }
  return env;
}

export function resolvePackagedDesktopSmokePenkraRoot(root: string): string {
  return join(root, "penkra-root");
}

export function resolvePackagedDesktopSmokeLogPath(root: string): string {
  return join(
    resolvePackagedDesktopSmokePenkraRoot(root),
    ".penkra",
    "userdata",
    "logs",
    "desktop-main.log",
  );
}

export function removePackagedDesktopSmokeRoot(root: string): void {
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 20 : 0,
    retryDelay: 250,
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await waitForExit(child, 5_000);
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForExit(child, 5_000)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForExit(child, 2_000);
}

async function terminateMacApplication(executablePath: string): Promise<void> {
  const findPids = (): number[] => {
    const result = spawnSync("pgrep", ["-f", "-x", executablePath], {
      encoding: "utf8",
      shell: false,
    });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1);
  };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const pids = findPids();
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // A process may exit between discovery and signalling.
      }
    }
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, signal === "SIGTERM" ? 1_000 : 250),
    );
  }
}

async function terminateProcessesInsideRoot(root: string): Promise<void> {
  if (process.platform === "win32") return;
  const findPids = (): number[] => {
    const result = spawnSync("pgrep", ["-f", root], {
      encoding: "utf8",
      shell: false,
    });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const pids = findPids();
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // A process may exit between discovery and signalling.
      }
    }
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, signal === "SIGTERM" ? 1_000 : 250),
    );
  }
  const survivors = findPids();
  if (survivors.length > 0) {
    throw new Error(
      `Packaged desktop smoke left processes running inside its temporary root: ${survivors.join(", ")}.`,
    );
  }
}

export function inspectPackagedDesktopStartupLog(log: string): {
  readonly failure: string | null;
  readonly hasProof: boolean;
} {
  const missingAccountAuthHandler = "No handler registered for 'desktop:account-auth-";
  if (log.includes(missingAccountAuthHandler)) {
    return {
      failure: "Packaged desktop invoked account authentication before its IPC handler existed.",
      hasProof: false,
    };
  }
  const fatalStartup = /fatal startup error stage=([^\n]+)/.exec(log);
  if (fatalStartup) {
    return {
      failure: `Packaged desktop reported a fatal startup error: ${fatalStartup[1]!.trim()}`,
      hasProof: false,
    };
  }
  return {
    failure: null,
    hasProof:
      log.includes("app ready") &&
      log.includes("bootstrap main window created") &&
      log.includes("bootstrap backend ready source=") &&
      log.includes("bootstrap required Apps package ready"),
  };
}

function inspectStartupLog(logPath: string): ReturnType<typeof inspectPackagedDesktopStartupLog> {
  try {
    return inspectPackagedDesktopStartupLog(readFileSync(logPath, "utf8"));
  } catch {
    return { failure: null, hasProof: false };
  }
}

export function extractPackagedDesktopBackendPort(log: string): number | null {
  const match = /bootstrap resolved backend endpoint port=(\d+)/.exec(log);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

async function hasPackagedDesktopHttpProof(logPath: string): Promise<boolean> {
  let log: string;
  try {
    log = readFileSync(logPath, "utf8");
  } catch {
    return false;
  }
  if (
    !log.includes("app ready") ||
    !log.includes("bootstrap main window created") ||
    !log.includes("bootstrap required Apps package ready")
  ) {
    return false;
  }
  const port = extractPackagedDesktopBackendPort(log);
  if (port === null) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      redirect: "manual",
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { startupReady?: unknown };
    return payload.startupReady === true;
  } catch {
    return false;
  }
}

export function resolveNativePackagedDesktopPlatform(
  platform: NodeJS.Platform,
): PackagedDesktopPlatform {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  return "linux";
}

export async function verifyPackagedDesktopStartup(
  options: PackagedDesktopStartupOptions,
): Promise<void> {
  const nativePlatform = resolveNativePackagedDesktopPlatform(process.platform);
  if (nativePlatform !== options.platform) {
    throw new Error(
      `Packaged ${options.platform} startup smoke must run on its native host, not ${process.platform}.`,
    );
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), `penkra-packaged-smoke-${options.platform}-`));
  const extractionRoot = join(temporaryRoot, "payload");
  mkdirSync(extractionRoot, { recursive: true });

  let child: ChildProcess | null = null;
  let logPath: string | null = null;
  let childStdout = "";
  let childStderr = "";
  let macAppExecutable: string | null = null;
  try {
    const launch = prepareLaunch(options, extractionRoot);
    macAppExecutable = launch.macAppExecutable ?? null;
    const stateRoot = join(temporaryRoot, "state");
    const env = createPackagedDesktopSmokeEnvironment(stateRoot, options);
    logPath = resolvePackagedDesktopSmokeLogPath(stateRoot);
    child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const childOutcome: {
      exited: { code: number | null; signal: NodeJS.Signals | null } | null;
      launchError: Error | null;
    } = { exited: null, launchError: null };
    child.once("exit", (code, signal) => {
      childOutcome.exited = { code, signal };
    });
    child.once("error", (error) => {
      childOutcome.launchError = error;
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      childStdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      childStderr += chunk;
    });

    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      const startupLog = inspectStartupLog(logPath);
      if (startupLog.failure) {
        throw new Error(startupLog.failure);
      }
      if (startupLog.hasProof) {
        console.log(
          `Packaged ${options.platform}/${options.arch} startup smoke passed from isolated state.`,
        );
        return;
      }
      if (await hasPackagedDesktopHttpProof(logPath)) {
        console.log(
          `Packaged ${options.platform}/${options.arch} startup smoke passed from isolated state.`,
        );
        return;
      }
      if (childOutcome.launchError) {
        throw new Error(`Packaged app could not start: ${childOutcome.launchError.message}`);
      }
      if (childOutcome.exited) {
        throw new Error(
          `Packaged app exited before startup proof (code=${childOutcome.exited.code ?? "null"}, signal=${childOutcome.exited.signal ?? "null"}).`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    throw new Error(`Packaged startup proof timed out after ${options.timeoutMs}ms.`);
  } catch (cause) {
    const log = logPath && existsSync(logPath) ? readFileSync(logPath, "utf8") : "<missing>";
    const serverLogPath = logPath ? join(dirname(logPath), "server-child.log") : null;
    const serverLog =
      serverLogPath && existsSync(serverLogPath)
        ? readFileSync(serverLogPath, "utf8")
        : "<missing>";
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${message}\nPackaged desktop log:\n${log.slice(-16_000)}\nPackaged server log:\n${serverLog.slice(-16_000)}\nstdout:\n${childStdout.slice(-4_000)}\nstderr:\n${childStderr.slice(-4_000)}`,
      { cause },
    );
  } finally {
    if (macAppExecutable) {
      await terminateMacApplication(macAppExecutable);
    }
    if (child) {
      await terminateProcessTree(child);
    }
    await terminateProcessesInsideRoot(temporaryRoot);
    removePackagedDesktopSmokeRoot(temporaryRoot);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await verifyPackagedDesktopStartup(parsePackagedDesktopStartupArgs(process.argv.slice(2)));
}
