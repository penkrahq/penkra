// FILE: androidEmulatorLauncher.ts
// Purpose: Starts and stops hidden official Android Emulator processes and resolves their authenticated endpoints.
// Layer: Trusted desktop platform boundary

import ChildProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import FS from "node:fs";
import Net from "node:net";
import Path from "node:path";

import type {
  AndroidEmulatorEndpoint,
  AndroidEmulatorInstance,
  AndroidEmulatorLauncher,
} from "./androidEmulatorSessionHost";
import type { SupportedDesktopPlatform } from "./desktopPlatform";
import type { SimulatorNativeCommandRunner } from "./simulatorNativeCommand";
import { reserveSimulatorLoopbackPort } from "./simulatorLoopbackPort";

const START_TIMEOUT_MS = 3 * 60_000;
const ENDPOINT_POLL_MS = 100;
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;

export interface AndroidEmulatorProcessSpawner {
  (executable: string, args: ReadonlyArray<string>): ChildProcessWithoutNullStreams;
}

export class DefaultAndroidEmulatorLauncher implements AndroidEmulatorLauncher {
  readonly #emulator: string;
  readonly #adb: string;
  readonly #protoPath: string;
  readonly #commands: SimulatorNativeCommandRunner;
  readonly #platform: SupportedDesktopPlatform;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #spawn: AndroidEmulatorProcessSpawner;

  constructor(input: {
    emulator: string;
    adb: string;
    protoPath: string;
    commands: SimulatorNativeCommandRunner;
    platform: SupportedDesktopPlatform;
    environment?: NodeJS.ProcessEnv;
    spawn?: AndroidEmulatorProcessSpawner;
  }) {
    this.#emulator = input.emulator;
    this.#adb = input.adb;
    this.#protoPath = input.protoPath;
    this.#commands = input.commands;
    this.#platform = input.platform;
    this.#environment = input.environment ?? process.env;
    this.#spawn = input.spawn ?? spawnNativeProcess;
  }

  async start(input: {
    avdName: string;
    signal: AbortSignal;
    onPhase(phase: "preparing" | "booting"): void;
  }): Promise<AndroidEmulatorInstance> {
    return this.#start(input, false);
  }

  async erase(avdName: string): Promise<void> {
    const controller = new AbortController();
    const instance = await this.#start(
      { avdName, signal: controller.signal, onPhase: () => undefined },
      true,
    );
    await instance.stop();
  }

  async #start(
    input: {
      avdName: string;
      signal: AbortSignal;
      onPhase(phase: "preparing" | "booting"): void;
    },
    wipeData: boolean,
  ): Promise<AndroidEmulatorInstance> {
    if (input.signal.aborted)
      throw launcherError("SESSION_CANCELLED", "Simulator session was cancelled.");
    input.onPhase("preparing");
    const report = await createConsoleReportServer();
    const grpcPort = await reserveSimulatorLoopbackPort();
    const args = buildAndroidEmulatorArguments({
      avdName: input.avdName,
      reportPort: report.port,
      grpcPort,
      wipeData,
    });
    const child = this.#spawn(this.#emulator, args);
    const diagnostics = collectDiagnostics(child);
    const exited = processExit(child);
    const pid = child.pid;
    if (!pid) {
      report.close();
      child.kill();
      throw launcherError("EMULATOR_START_FAILED", "Android Emulator did not return a process ID.");
    }
    const startup = new AbortController();
    const relayAbort = () => startup.abort(input.signal.reason);
    input.signal.addEventListener("abort", relayAbort, { once: true });
    void exited.then(() => startup.abort());

    let serial = "";
    let endpoint: AndroidEmulatorEndpoint | undefined;
    try {
      const consolePort = await withStartupDeadline(report.consolePort, startup.signal);
      serial = `emulator-${consolePort}`;
      endpoint = await withStartupDeadline(
        waitForAuthenticatedEndpoint({
          pid,
          expectedPort: grpcPort,
          protoPath: this.#protoPath,
          platform: this.#platform,
          environment: this.#environment,
          signal: startup.signal,
        }),
        startup.signal,
      );
      input.onPhase("booting");
      await this.#commands.run({
        executable: this.#adb,
        args: ["-s", serial, "wait-for-device"],
        timeoutMs: START_TIMEOUT_MS,
        signal: startup.signal,
      });
      await waitForAndroidBoot(this.#commands, this.#adb, serial, startup.signal);
    } catch (error) {
      await stopEmulator(child, exited, this.#commands, this.#adb, serial);
      if (input.signal.aborted) {
        throw launcherError("SESSION_CANCELLED", "Simulator session was cancelled.");
      }
      if (await hasExited(exited)) {
        throw launcherError(
          "EMULATOR_START_FAILED",
          `Android Emulator exited during startup.${diagnostics.text() ? ` ${diagnostics.text()}` : ""}`,
        );
      }
      throw error;
    } finally {
      report.close();
      input.signal.removeEventListener("abort", relayAbort);
    }

    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= stopEmulator(child, exited, this.#commands, this.#adb, serial);
      return stopping;
    };
    input.signal.addEventListener("abort", () => void stop(), { once: true });
    if (!endpoint)
      throw launcherError("EMULATOR_START_FAILED", "Android Emulator endpoint was not resolved.");
    return { serial, endpoint, exited, stop };
  }
}

export function buildAndroidEmulatorArguments(input: {
  avdName: string;
  reportPort: number;
  grpcPort: number;
  wipeData?: boolean;
}): ReadonlyArray<string> {
  const args = [
    "-avd",
    input.avdName,
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-grpc",
    String(input.grpcPort),
    "-grpc-use-token",
    "-report-console",
    `tcp:${input.reportPort},max=60`,
  ];
  if (input.wipeData) args.push("-wipe-data");
  return args;
}

export function androidEmulatorDiscoveryDirectories(
  platform: SupportedDesktopPlatform,
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  if (platform === "darwin" && environment.HOME) {
    return [Path.join(environment.HOME, "Library", "Caches", "TemporaryItems", "avd", "running")];
  }
  if (platform === "win32") {
    const roots = [
      environment.TEMP,
      environment.TMP,
      environment.LOCALAPPDATA && Path.join(environment.LOCALAPPDATA, "Temp"),
    ];
    return [
      ...new Set(
        roots
          .filter((root): root is string => Boolean(root))
          .map((root) => Path.join(root, "avd", "running")),
      ),
    ];
  }
  const roots = [
    environment.XDG_RUNTIME_DIR,
    typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : undefined,
    environment.USER ? `/tmp/android-${environment.USER}` : undefined,
  ];
  return [
    ...new Set(
      roots
        .filter((root): root is string => Boolean(root))
        .map((root) => Path.join(root, "avd", "running")),
    ),
  ];
}

export function parseAndroidEmulatorEndpoint(
  value: string,
  expectedPort: number,
  protoPath: string,
): AndroidEmulatorEndpoint | null {
  const fields = new Map<string, string>();
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const port = Number(fields.get("grpc.port"));
  const token = fields.get("grpc.token") ?? "";
  if (!Number.isInteger(port) || port !== expectedPort || !token || token.length > 16_384)
    return null;
  return { target: `127.0.0.1:${port}`, token, protoPath };
}

async function waitForAuthenticatedEndpoint(input: {
  pid: number;
  expectedPort: number;
  protoPath: string;
  platform: SupportedDesktopPlatform;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<AndroidEmulatorEndpoint> {
  const fileNames = [`pid_${input.pid}.ini`, `pid_${input.pid}_info.ini`];
  const candidates = androidEmulatorDiscoveryDirectories(input.platform, input.environment).flatMap(
    (directory) => fileNames.map((fileName) => Path.join(directory, fileName)),
  );
  while (!input.signal.aborted) {
    for (const path of candidates) {
      try {
        const endpoint = parseAndroidEmulatorEndpoint(
          await FS.promises.readFile(path, "utf8"),
          input.expectedPort,
          input.protoPath,
        );
        if (endpoint) return endpoint;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    await abortableDelay(ENDPOINT_POLL_MS, input.signal);
  }
  throw launcherError("SESSION_CANCELLED", "Simulator session was cancelled.");
}

async function waitForAndroidBoot(
  commands: SimulatorNativeCommandRunner,
  adb: string,
  serial: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const result = await commands.run({
      executable: adb,
      args: ["-s", serial, "shell", "getprop", "sys.boot_completed"],
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
      signal,
    });
    if (Buffer.from(result.stdout).toString("utf8").trim() === "1") return;
    await abortableDelay(250, signal);
  }
  throw launcherError("SESSION_CANCELLED", "Simulator session was cancelled.");
}

function spawnNativeProcess(
  executable: string,
  args: ReadonlyArray<string>,
): ChildProcessWithoutNullStreams {
  return ChildProcess.spawn(executable, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function processExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("error", () => resolve({ exitCode: null, signal: null }));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function stopEmulator(
  child: ChildProcessWithoutNullStreams,
  exited: AndroidEmulatorInstance["exited"],
  commands: SimulatorNativeCommandRunner,
  adb: string,
  serial: string,
): Promise<void> {
  if (await hasExited(exited)) return;
  if (serial) {
    await Promise.race([
      commands.run({ executable: adb, args: ["-s", serial, "emu", "kill"], timeoutMs: 5_000 }),
      abortableDelay(5_000),
    ]).catch(() => undefined);
  }
  if (await waitForExit(exited, 5_000)) return;
  child.kill();
  if (await waitForExit(exited, 3_000)) return;
  child.kill("SIGKILL");
  await waitForExit(exited, 3_000);
}

function collectDiagnostics(child: ChildProcessWithoutNullStreams): { text(): string } {
  let tail = "";
  const append = (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-MAX_DIAGNOSTIC_BYTES);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { text: () => tail.trim().slice(-4_096) };
}

async function createConsoleReportServer(): Promise<{
  port: number;
  consolePort: Promise<number>;
  close(): void;
}> {
  const server = Net.createServer();
  let resolveConsole!: (port: number) => void;
  let rejectConsole!: (error: Error) => void;
  const consolePort = new Promise<number>((resolve, reject) => {
    resolveConsole = resolve;
    rejectConsole = reject;
  });
  server.once("connection", (socket) => {
    let value = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      value = (value + chunk).slice(0, 32);
    });
    socket.once("end", () => {
      const port = Number(value.trim());
      if (Number.isInteger(port) && port >= 5554 && port <= 5682 && port % 2 === 0) {
        resolveConsole(port);
      } else {
        rejectConsole(
          launcherError("INVALID_ADB_TARGET", "Android Emulator returned an invalid console port."),
        );
      }
    });
    socket.once("error", rejectConsole);
  });
  await listenLoopback(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate report port.");
  return { port: address.port, consolePort, close: () => server.close() };
}

function listenLoopback(server: Net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function withStartupDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () =>
      finish(() => reject(launcherError("SESSION_CANCELLED", "Simulator session was cancelled.")));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            launcherError("EMULATOR_START_TIMEOUT", "Android Emulator did not start in time."),
          ),
        ),
      START_TIMEOUT_MS,
    );
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(launcherError("SESSION_CANCELLED", "Simulator session was cancelled."));
      return;
    }
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () =>
      finish(() => reject(launcherError("SESSION_CANCELLED", "Simulator session was cancelled.")));
    const timer = setTimeout(() => finish(resolve), ms);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitForExit(
  exited: AndroidEmulatorInstance["exited"],
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([exited.then(() => true), abortableDelay(timeoutMs).then(() => false)]);
}

async function hasExited(exited: AndroidEmulatorInstance["exited"]): Promise<boolean> {
  return Promise.race([exited.then(() => true), Promise.resolve(false)]);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function launcherError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
