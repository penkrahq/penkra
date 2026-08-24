// FILE: appControllerHost.ts
// Purpose: Runs declared App operation handlers in one dedicated Node controller per App/Space.
// Layer: Trusted desktop App runtime

import * as Path from "node:path";

import type { AppTabHandle, OperationCancellationCode, OperationContext } from "@penkra/sdk";

import type { InstalledAppPackage } from "./appInstallationState";
import type { AppOperationBroker, AppOperationController } from "./appOperationBroker";
import {
  type AppRendererContextMethod,
  type AppRendererRpcHost,
  type AppRendererRpcHostMessage,
} from "./appRendererRpc";
import type { ActiveAppSession } from "./appSessionManager";

export interface AppControllerProcess {
  /** Host-owned process identity used by the bounded operation RPC transport. */
  id: number;
  send(message: AppRendererRpcHostMessage): void;
  /** Resolves only after the Node runtime and controller entrypoint are ready. */
  start(entrypointPath: string): Promise<void>;
  destroy(): void;
  onDestroyed(listener: () => void): () => void;
}

export interface AppControllerProcessFactory {
  create(input: {
    installedApp: InstalledAppPackage;
    spaceId: string;
    session: ActiveAppSession;
  }): AppControllerProcess;
}

export interface AppControllerHostDependencies {
  broker: Pick<AppOperationBroker, "registerController">;
  rpc: Pick<AppRendererRpcHost, "registerTarget" | "request">;
  processes: AppControllerProcessFactory;
}

export class AppControllerHost {
  readonly #broker: AppControllerHostDependencies["broker"];
  readonly #rpc: AppControllerHostDependencies["rpc"];
  readonly #processes: AppControllerProcessFactory;

  constructor(dependencies: AppControllerHostDependencies) {
    this.#broker = dependencies.broker;
    this.#rpc = dependencies.rpc;
    this.#processes = dependencies.processes;
  }

  async activate(input: {
    installedApp: InstalledAppPackage;
    spaceId: string;
    session: ActiveAppSession;
    onUnexpectedExit?: (error: Error) => void;
  }): Promise<(reason?: OperationCancellationCode) => Promise<void>> {
    const operations = input.installedApp.manifest.operations ?? [];
    if (operations.length === 0) return async () => undefined;
    const entrypoint = input.installedApp.manifest.entrypoints.operations;
    if (!entrypoint) {
      throw new Error(
        `${input.installedApp.appId} declares operations without a controller entrypoint.`,
      );
    }

    const controllerProcess = this.#processes.create(input);
    let unregisterRpc: ((reason?: OperationCancellationCode) => void) | null = null;
    let unregisterController: (() => void) | null = null;
    let removeDestroyedListener: (() => void) | null = null;
    let released = false;

    const release = async (
      reason: OperationCancellationCode = "app-disabled",
      unexpected = false,
    ): Promise<void> => {
      if (released) return;
      released = true;
      removeDestroyedListener?.();
      unregisterController?.();
      unregisterRpc?.(unexpected ? "host-stopped" : reason);
      if (!unexpected) controllerProcess.destroy();
    };

    try {
      unregisterRpc = this.#rpc.registerTarget({
        id: controllerProcess.id,
        send: (message) => controllerProcess.send(message),
      });
      const packagePath = Path.resolve(input.installedApp.packagePath);
      const entrypointPath = Path.resolve(packagePath, entrypoint);
      if (!entrypointPath.startsWith(`${packagePath}${Path.sep}`)) {
        throw new Error("App controller entrypoint escapes its installed package.");
      }
      await controllerProcess.start(entrypointPath);
      const controller: AppOperationController = {
        appId: input.installedApp.appId,
        spaceId: input.spaceId,
        handlers: Object.fromEntries(
          operations.map((declaration) => [
            declaration.key,
            async (operationInput: unknown, context: OperationContext) => {
              const openedTabs = new Map<string, AppTabHandle>();
              return this.#rpc.request(
                controllerProcess.id,
                "controller.invoke",
                {
                  operation: declaration.key,
                  handler: declaration.handler,
                  input: operationInput,
                  invocation: context.invocation,
                  caller: context.caller,
                },
                {
                  signal: context.signal,
                  handleContextCall: (method, contextInput, signal) =>
                    handleContextCall(context, openedTabs, method, contextInput, signal),
                },
              );
            },
          ]),
        ),
      };
      unregisterController = this.#broker.registerController(controller);
      removeDestroyedListener = controllerProcess.onDestroyed(() => {
        const crash = new Error(
          `${input.installedApp.name} operation controller exited unexpectedly in Space ${input.spaceId}.`,
        );
        void release("host-stopped", true).then(
          () => input.onUnexpectedExit?.(crash),
          (error) => input.onUnexpectedExit?.(new AggregateError([crash, error], crash.message)),
        );
      });
      return (reason) => release(reason, false);
    } catch (error) {
      await release("host-stopped", false);
      throw error;
    }
  }
}

async function handleContextCall(
  context: OperationContext,
  openedTabs: Map<string, AppTabHandle>,
  method: AppRendererContextMethod,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw signal.reason;
  const record = requireRecord(input);
  switch (method) {
    case "context.tabs.open": {
      const tab = await context.tabs.open(parseNavigation(record));
      openedTabs.set(tab.id, tab);
      return { id: tab.id };
    }
    case "context.tabs.open-for-result":
      return context.tabs.openForResult(parseNavigation(record));
    case "context.tab.navigate": {
      await resolveTab(context, openedTabs, record).navigate(parseNavigation(record));
      return null;
    }
    case "context.tab.close": {
      const tab = resolveTab(context, openedTabs, record);
      await tab.close();
      openedTabs.delete(tab.id);
      return null;
    }
    case "context.tab.navigate-for-result":
      return resolveTab(context, openedTabs, record).navigateForResult(parseNavigation(record));
    case "context.tab.invoke": {
      const operation = requireNonEmptyString(record.operation, "operation");
      return resolveTab(context, openedTabs, record).invoke({
        operation,
        input: record.input,
      });
    }
    case "context.operations.invoke": {
      return context.operations.invoke({
        app: requireNonEmptyString(record.app, "app"),
        operation: requireNonEmptyString(record.operation, "operation"),
        input: record.input,
        ...(record.tabId === undefined
          ? {}
          : { tabId: requireNonEmptyString(record.tabId, "tabId") }),
      });
    }
  }
}

function resolveTab(
  context: OperationContext,
  openedTabs: Map<string, AppTabHandle>,
  input: Record<string, unknown>,
): AppTabHandle {
  if (input.handleId !== undefined) {
    const handleId = requireNonEmptyString(input.handleId, "handleId");
    const opened = openedTabs.get(handleId);
    if (opened) return opened;
    throw contextError("TAB_HANDLE_INVALID", "The App tab handle is not valid for this operation.");
  }
  if (context.tab) return context.tab;
  throw contextError("TAB_REQUIRED", "This operation requires an explicit App tab.");
}

function parseNavigation(input: Record<string, unknown>): { route: string; state?: unknown } {
  const route = requireNonEmptyString(input.route, "route");
  return input.state === undefined ? { route } : { route, state: input.state };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw contextError("INVALID_CONTEXT_INPUT", "App context input must be an object.");
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw contextError("INVALID_CONTEXT_INPUT", `${label} must be a non-empty string.`);
  }
  return value;
}

function contextError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
