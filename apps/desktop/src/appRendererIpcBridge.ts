// FILE: appRendererIpcBridge.ts
// Purpose: Binds the internal App renderer RPC host to one namespaced Electron IPC channel family.
// Layer: Trusted desktop App runtime

import type { IpcMain, IpcMainEvent } from "electron";

import type { AppRendererRpcHost } from "./appRendererRpc";
import { APP_RUNTIME_IPC_CHANNELS } from "./ipcChannels";

interface ReadyWaiter {
  resolve(): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export interface AppRendererIpcBridgeOptions {
  ipcMain: Pick<IpcMain, "on" | "removeListener">;
  rpc: Pick<AppRendererRpcHost, "acceptResponse" | "acceptContextCall">;
  readyTimeoutMs?: number;
  onInvalidMessage?: (error: Error, senderId: number) => void;
}

export class AppRendererIpcBridge {
  readonly #ipcMain: AppRendererIpcBridgeOptions["ipcMain"];
  readonly #rpc: AppRendererIpcBridgeOptions["rpc"];
  readonly #readyTimeoutMs: number;
  readonly #onInvalidMessage: NonNullable<AppRendererIpcBridgeOptions["onInvalidMessage"]>;
  readonly #readyWaiters = new Map<number, ReadyWaiter>();
  #started = false;

  constructor(options: AppRendererIpcBridgeOptions) {
    this.#ipcMain = options.ipcMain;
    this.#rpc = options.rpc;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#readyTimeoutMs) || this.#readyTimeoutMs <= 0) {
      throw new TypeError("readyTimeoutMs must be a positive safe integer.");
    }
    this.#onInvalidMessage = options.onInvalidMessage ?? (() => undefined);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#ipcMain.on(APP_RUNTIME_IPC_CHANNELS.rendererMessage, this.#handleRendererMessage);
    this.#ipcMain.on(APP_RUNTIME_IPC_CHANNELS.ready, this.#handleReady);
  }

  waitForReady(targetId: number, signal?: AbortSignal): Promise<void> {
    if (!this.#started) return Promise.reject(new Error("App renderer IPC bridge is not started."));
    if (this.#readyWaiters.has(targetId)) {
      return Promise.reject(new Error(`App renderer ${targetId} already has a readiness waiter.`));
    }
    if (signal?.aborted) return Promise.reject(toError(signal.reason));

    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.#settleReady(targetId);
          reject(new Error(`App renderer ${targetId} did not become ready in time.`));
        }, this.#readyTimeoutMs),
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal) {
        waiter.abortListener = () => {
          this.#settleReady(targetId);
          reject(toError(signal.reason));
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.#readyWaiters.set(targetId, waiter);
    });
  }

  dispose(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#ipcMain.removeListener(
      APP_RUNTIME_IPC_CHANNELS.rendererMessage,
      this.#handleRendererMessage,
    );
    this.#ipcMain.removeListener(APP_RUNTIME_IPC_CHANNELS.ready, this.#handleReady);
    for (const [targetId, waiter] of this.#readyWaiters) {
      this.#settleReady(targetId);
      waiter.reject(new Error("App renderer IPC bridge stopped."));
    }
  }

  readonly #handleRendererMessage = (event: IpcMainEvent, message: unknown): void => {
    try {
      if (!isRecord(message) || typeof message.type !== "string") {
        throw new Error("App renderer IPC message is invalid.");
      }
      if (message.type === "result" || message.type === "error") {
        this.#rpc.acceptResponse(event.sender.id, message);
      } else if (message.type === "context-call") {
        this.#rpc.acceptContextCall(event.sender.id, message);
      } else {
        throw new Error("App renderer IPC message type is invalid.");
      }
    } catch (error) {
      this.#onInvalidMessage(toError(error), event.sender.id);
    }
  };

  readonly #handleReady = (event: IpcMainEvent): void => {
    const targetId = event.sender.id;
    const waiter = this.#readyWaiters.get(targetId);
    if (!waiter) return;
    this.#settleReady(targetId);
    waiter.resolve();
  };

  #settleReady(targetId: number): void {
    const waiter = this.#readyWaiters.get(targetId);
    if (!waiter) return;
    this.#readyWaiters.delete(targetId);
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
