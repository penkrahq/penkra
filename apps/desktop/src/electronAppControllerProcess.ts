// FILE: electronAppControllerProcess.ts
// Purpose: Runs App operation controllers as dedicated permission-bounded Node processes.
// Layer: Trusted desktop App runtime

import { fork as forkNodeProcess, type ChildProcess } from "node:child_process";

import type { AppControllerProcess, AppControllerProcessFactory } from "./appControllerHost";
import type { AppRendererRpcHost } from "./appRendererRpc";

export interface ElectronAppControllerProcessFactoryOptions {
  runnerPath: string;
  rpc: Pick<AppRendererRpcHost, "acceptContextCall" | "acceptResponse">;
  serviceCall(input: {
    appId: string;
    spaceId: string;
    method: string;
    input: unknown;
  }): Promise<unknown>;
  fork?: typeof forkNodeProcess;
  startupTimeoutMs?: number;
}

// Electron may briefly use -1 for a tab whose renderer is not connected yet.
// Controller targets live in a disjoint synthetic range.
let nextControllerProcessId = -1_000_000_000;

export class ElectronAppControllerProcessFactory implements AppControllerProcessFactory {
  readonly #options: ElectronAppControllerProcessFactoryOptions;

  constructor(options: ElectronAppControllerProcessFactoryOptions) {
    this.#options = options;
  }

  create(input: Parameters<AppControllerProcessFactory["create"]>[0]): AppControllerProcess {
    const id = nextControllerProcessId--;
    let child: ChildProcess | null = null;
    let intentionallyDestroyed = false;
    let unexpectedlyDestroyed = false;
    const destroyedListeners = new Set<() => void>();
    const reportUnexpectedDestroy = () => {
      if (intentionallyDestroyed || unexpectedlyDestroyed) return;
      unexpectedlyDestroyed = true;
      for (const listener of destroyedListeners) listener();
    };

    return {
      id,
      send: (message) => {
        if (!child?.pid || !child.connected)
          throw new Error("App controller process is unavailable.");
        child.send(message);
      },
      start: async (entrypointPath) => {
        if (child) throw new Error("App controller process was already started.");
        const spawned = (this.#options.fork ?? forkNodeProcess)(
          this.#options.runnerPath,
          [entrypointPath, input.installedApp.appId],
          {
            cwd: input.installedApp.packagePath,
            execPath: process.execPath,
            execArgv: ["--permission", "--allow-fs-read=*", "--allow-fs-write=*", "--no-addons"],
            env: appControllerEnvironment(process.env),
            serialization: "advanced",
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        child = spawned;
        let startupStderr = "";
        spawned.stdout?.on("data", (chunk: Buffer | string) => {
          process.stdout.write(chunk);
        });
        spawned.stderr?.on("data", (chunk: Buffer | string) => {
          startupStderr = `${startupStderr}${String(chunk)}`.slice(-16_000);
          process.stderr.write(chunk);
        });
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let ready = false;
          const timeout = setTimeout(
            () => settle(new Error(`${input.installedApp.name} operation controller timed out.`)),
            this.#options.startupTimeoutMs ?? 30_000,
          );
          const settle = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            spawned.removeListener("exit", onStartupExit);
            if (error) reject(error);
            else resolve();
          };
          const onStartupExit = (code: number | null) =>
            settle(
              new Error(
                `${input.installedApp.name} operation controller exited during startup (${code}).${formatStartupStderr(startupStderr)}`,
              ),
            );
          const onProcessError = (error: Error) => {
            if (!ready) settle(error);
            else reportUnexpectedDestroy();
          };
          const onMessage = (message: unknown) => {
            if (!isRecord(message)) return;
            if (message.type === "ready") {
              ready = true;
              settle();
            } else if (message.type === "startup-error") {
              const detail =
                typeof message.stack === "string" && message.stack.trim().length > 0
                  ? `\n${message.stack.trim()}`
                  : "";
              settle(
                new Error(
                  typeof message.message === "string"
                    ? `${message.message}${detail}`
                    : `${input.installedApp.name} operation controller failed to start.`,
                ),
              );
            } else if (message.type === "result" || message.type === "error") {
              try {
                this.#options.rpc.acceptResponse(id, message);
              } catch (error) {
                const requestId = typeof message.id === "string" ? message.id : "";
                if (!requestId) return;
                try {
                  this.#options.rpc.acceptResponse(id, {
                    type: "error",
                    id: requestId,
                    code: "INVALID_APP_RESPONSE",
                    message: error instanceof Error ? error.message : String(error),
                  });
                } catch {
                  // A malformed or stale controller message must never escape the
                  // child-process event callback and terminate the desktop host.
                }
              }
            } else if (message.type === "context-call") {
              try {
                this.#options.rpc.acceptContextCall(id, message);
              } catch {
                const parentId = typeof message.parentId === "string" ? message.parentId : "";
                const contextId = typeof message.id === "string" ? message.id : "";
                if (parentId && contextId && spawned.pid && spawned.connected) {
                  spawned.send({
                    type: "context-error",
                    parentId,
                    id: contextId,
                    code: "INVALID_CONTEXT_CALL",
                    message: "The App controller sent an invalid context call.",
                  });
                }
              }
            } else if (message.type === "service-call") {
              void this.#handleServiceCall(spawned, input, message);
            }
          };
          spawned.on("message", onMessage);
          spawned.on("error", onProcessError);
          spawned.once("exit", onStartupExit);
        });
        spawned.once("exit", () => {
          child = null;
          reportUnexpectedDestroy();
        });
      },
      destroy: () => {
        intentionallyDestroyed = true;
        child?.kill();
        child = null;
      },
      onDestroyed: (listener) => {
        if (unexpectedlyDestroyed) {
          queueMicrotask(listener);
          return () => undefined;
        }
        destroyedListeners.add(listener);
        return () => destroyedListeners.delete(listener);
      },
    };
  }

  async #handleServiceCall(
    child: ChildProcess,
    identity: Parameters<AppControllerProcessFactory["create"]>[0],
    message: Record<string, unknown>,
  ): Promise<void> {
    const id = typeof message.id === "string" ? message.id : "";
    const method = typeof message.method === "string" ? message.method : "";
    if (!id || !method) return;
    try {
      const result = await this.#options.serviceCall({
        appId: identity.installedApp.appId,
        spaceId: identity.spaceId,
        method,
        input: message.input,
      });
      if (child.pid && child.connected)
        child.send({ type: "service-result", id, result: result ?? null });
    } catch (error) {
      if (!child.pid || !child.connected) return;
      child.send({
        type: "service-error",
        id,
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function formatStartupStderr(stderr: string): string {
  const detail = stderr.trim();
  return detail.length === 0 ? "" : `\nController stderr:\n${detail}`;
}

const APP_CONTROLLER_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
]);

export function appControllerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (APP_CONTROLLER_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_")) {
      environment[key] = value;
    }
  }
  return environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return "APP_SERVICE_FAILED";
}
