// FILE: appControllerHost.ts
// Purpose: Runs declared App operation handlers in one isolated controller renderer per App/Space.
// Layer: Trusted desktop App runtime

import type { AppTabHandle, OperationContext } from "@penkra/sdk";

import type { InstalledAppPackage } from "./appInstallationState";
import type { AppOperationBroker, AppOperationController } from "./appOperationBroker";
import {
  type AppRendererContextMethod,
  type AppRendererRpcHost,
  type AppRendererRpcHostMessage,
} from "./appRendererRpc";
import { createAppDocumentUrl } from "./appRuntimePolicy";
import type { ActiveAppSession } from "./appSessionManager";

export interface AppControllerRenderer {
  /** Host-owned renderer identity, conventionally Electron webContents.id. */
  id: number;
  send(message: AppRendererRpcHostMessage): void;
  /** Resolves only after the preload and controller entrypoint are ready. */
  start(url: string): Promise<void>;
  destroy(): void;
  onDestroyed(listener: () => void): () => void;
}

export interface AppControllerRendererFactory {
  create(input: {
    installedApp: InstalledAppPackage;
    spaceId: string;
    session: ActiveAppSession;
  }): AppControllerRenderer;
}

export interface AppControllerHostDependencies {
  broker: Pick<AppOperationBroker, "registerController">;
  rpc: Pick<AppRendererRpcHost, "registerTarget" | "request">;
  renderers: AppControllerRendererFactory;
}

export class AppControllerHost {
  readonly #broker: AppControllerHostDependencies["broker"];
  readonly #rpc: AppControllerHostDependencies["rpc"];
  readonly #renderers: AppControllerRendererFactory;

  constructor(dependencies: AppControllerHostDependencies) {
    this.#broker = dependencies.broker;
    this.#rpc = dependencies.rpc;
    this.#renderers = dependencies.renderers;
  }

  async activate(input: {
    installedApp: InstalledAppPackage;
    spaceId: string;
    session: ActiveAppSession;
  }): Promise<() => Promise<void>> {
    const operations = input.installedApp.manifest.operations ?? [];
    if (operations.length === 0) return async () => undefined;
    const entrypoint = input.installedApp.manifest.entrypoints.operations;
    if (!entrypoint) {
      throw new Error(`${input.installedApp.appId} declares operations without a controller entrypoint.`);
    }

    const renderer = this.#renderers.create(input);
    let unregisterRpc: ((reason?: "app-disabled") => void) | null = null;
    let unregisterController: (() => void) | null = null;
    let removeDestroyedListener: (() => void) | null = null;
    let released = false;

    const release = async (unexpected = false): Promise<void> => {
      if (released) return;
      released = true;
      removeDestroyedListener?.();
      unregisterController?.();
      unregisterRpc?.(unexpected ? undefined : "app-disabled");
      if (!unexpected) renderer.destroy();
    };

    try {
      unregisterRpc = this.#rpc.registerTarget({
        id: renderer.id,
        send: (message) => renderer.send(message),
      });
      await renderer.start(createAppDocumentUrl(input.installedApp.appId, entrypoint));
      const controller: AppOperationController = {
        appId: input.installedApp.appId,
        spaceId: input.spaceId,
        handlers: Object.fromEntries(
          operations.map((declaration) => [
            declaration.key,
            async (operationInput: unknown, context: OperationContext) => {
              const openedTabs = new Map<string, AppTabHandle>();
              return this.#rpc.request(renderer.id, "controller.invoke", {
                operation: declaration.key,
                handler: declaration.handler,
                input: operationInput,
                invocation: context.invocation,
              }, {
                signal: context.signal,
                handleContextCall: (method, contextInput, signal) =>
                  handleContextCall(context, openedTabs, method, contextInput, signal),
              });
            },
          ]),
        ),
      };
      unregisterController = this.#broker.registerController(controller);
      removeDestroyedListener = renderer.onDestroyed(() => {
        void release(true);
      });
      return () => release(false);
    } catch (error) {
      await release(false);
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
    case "context.tab.navigate-for-result":
      return resolveTab(context, openedTabs, record).navigateForResult(parseNavigation(record));
    case "context.tab.invoke": {
      const operation = requireNonEmptyString(record.operation, "operation");
      return resolveTab(context, openedTabs, record).invoke({
        operation,
        input: record.input,
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
