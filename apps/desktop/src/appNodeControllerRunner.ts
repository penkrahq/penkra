// FILE: appNodeControllerRunner.ts
// Purpose: Boots one installed App operation entrypoint in a dedicated Node process.
// Layer: App controller process

import { pathToFileURL } from "node:url";

import { AppNodeControllerRuntime } from "./appNodeControllerRuntime";

type ServiceResponse =
  | { type: "service-result"; id: string; result: unknown }
  | { type: "service-error"; id: string; code: string; message: string };

const entrypointArgument = process.argv[2];
const appIdArgument = process.argv[3];
if (!entrypointArgument || !appIdArgument) {
  throw new Error("App controller entrypoint and App ID are required.");
}
const entrypointPath: string = entrypointArgument;
const appId: string = appIdArgument;
if (!process.send) throw new Error("App controller runner requires a Node IPC process.");
const sendToHost = process.send.bind(process);

let nextServiceCallId = 0;
const pendingServiceCalls = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
const hostListeners = new Set<(message: unknown) => void>();

function serviceCall<Result = unknown>(method: string, input?: unknown): Promise<Result> {
  const id = `service-${++nextServiceCallId}`;
  return new Promise<Result>((resolve, reject) => {
    pendingServiceCalls.set(id, { resolve, reject });
    sendToHost({ type: "service-call", id, method, input });
  });
}

process.on("message", (message: unknown) => {
  if (isServiceResponse(message)) {
    const pending = pendingServiceCalls.get(message.id);
    if (!pending) return;
    pendingServiceCalls.delete(message.id);
    if (message.type === "service-result") pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.message), { code: message.code }));
    return;
  }
  for (const listener of hostListeners) listener(message);
});

const runtime = new AppNodeControllerRuntime({
  serviceCall,
  send: (message) => sendToHost(message),
  onHostMessage: (listener) => {
    hostListeners.add(listener);
    return () => hostListeners.delete(listener);
  },
  ready: () => sendToHost({ type: "ready" }),
});
const exposedApi =
  appId === "com.penkra.apps"
    ? {
        ...runtime.api,
        installations: new Proxy(
          {},
          {
            get: (_target, property) =>
              typeof property === "string"
                ? (input?: unknown) => serviceCall(`installations.${property}`, input)
                : undefined,
          },
        ),
      }
    : runtime.api;

Object.defineProperty(globalThis, "penkra", {
  configurable: false,
  enumerable: true,
  writable: false,
  value: exposedApi,
});
runtime.start();
void boot();

async function boot(): Promise<void> {
  try {
    await import(pathToFileURL(entrypointPath).href);
    runtime.markReady();
  } catch (error) {
    sendToHost({
      type: "startup-error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
  }
}

function isServiceResponse(value: unknown): value is ServiceResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { type?: unknown; id?: unknown };
  return (
    (candidate.type === "service-result" || candidate.type === "service-error") &&
    typeof candidate.id === "string"
  );
}
