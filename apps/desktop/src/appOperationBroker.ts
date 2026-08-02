// FILE: appOperationBroker.ts
// Purpose: Routes App operations to one controller and, when requested, one validated App tab.
// Layer: Trusted desktop App runtime

import type {
  AppTabHandle,
  AppTabs,
  OperationContext,
  OperationRequest,
} from "@penkra/sdk";

import type { AppInstallationState, InstalledAppPackage } from "./appInstallationState";
import {
  assertOperationValue,
  compileOperationValidators,
  type AppOperationValidators,
} from "./appOperationSchema";

export type AppOperationBrokerErrorCode =
  | "app-disabled"
  | "app-not-installed"
  | "controller-already-registered"
  | "controller-unavailable"
  | "invalid-input"
  | "invalid-output"
  | "operation-not-found"
  | "tab-already-registered"
  | "tab-not-found"
  | "tab-target-mismatch";

export class AppOperationBrokerError extends Error {
  readonly code: AppOperationBrokerErrorCode;

  constructor(code: AppOperationBrokerErrorCode, message: string) {
    super(message);
    this.name = "AppOperationBrokerError";
    this.code = code;
  }
}

export interface InvokeAppOperationRequest<Input = unknown> extends OperationRequest<Input> {
  /** Host context; these are not part of the App operation's input schema. */
  spaceId: string;
  threadId: string;
  signal?: AbortSignal;
}

export type AppOperationHandler<Input = unknown, Result = unknown> = (
  input: Input,
  context: OperationContext,
) => Promise<Result> | Result;

export interface AppOperationController {
  appId: string;
  spaceId: string;
  handlers: Readonly<Record<string, AppOperationHandler>>;
}

/** A renderer-owned endpoint. The broker never broadcasts requests to tabs. */
export interface AppTabEndpoint extends AppTabHandle {
  appId: string;
  spaceId: string;
  threadId: string;
}

export interface OpenAppTabRequest {
  app: InstalledAppPackage;
  spaceId: string;
  threadId: string;
  route: string;
  state?: unknown;
}

export interface AppTabHost {
  open(input: OpenAppTabRequest): Promise<AppTabHandle>;
  openForResult<Result = unknown>(input: OpenAppTabRequest): Promise<Result>;
}

export interface AppOperationBrokerOptions {
  installationState: () => AppInstallationState;
  tabs: AppTabHost;
  mintInvocationId?: () => string;
}

/**
 * Trusted routing boundary between agent/CLI calls and App code.
 *
 * Controllers are scoped to one App installation in one Space. A supplied
 * tabId is resolved once at invocation start and captured in the context, so a
 * later focus or navigation change cannot redirect the operation.
 */
export class AppOperationBroker {
  readonly #installationState: () => AppInstallationState;
  readonly #tabHost: AppTabHost;
  readonly #mintInvocationId: () => string;
  readonly #controllers = new Map<string, AppOperationController>();
  readonly #tabs = new Map<string, AppTabEndpoint>();
  readonly #validators = new Map<string, AppOperationValidators>();

  constructor(options: AppOperationBrokerOptions) {
    this.#installationState = options.installationState;
    this.#tabHost = options.tabs;
    this.#mintInvocationId = options.mintInvocationId ?? (() => crypto.randomUUID());
  }

  registerController(controller: AppOperationController): () => void {
    const key = controllerKey(controller.appId, controller.spaceId);
    if (this.#controllers.has(key)) {
      throw new AppOperationBrokerError(
        "controller-already-registered",
        `A controller is already registered for ${controller.appId} in Space ${controller.spaceId}.`,
      );
    }
    this.#controllers.set(key, controller);
    return () => {
      if (this.#controllers.get(key) === controller) this.#controllers.delete(key);
    };
  }

  registerTab(tab: AppTabEndpoint): () => void {
    if (this.#tabs.has(tab.id)) {
      throw new AppOperationBrokerError(
        "tab-already-registered",
        `App tab ${tab.id} is already registered.`,
      );
    }
    this.#tabs.set(tab.id, tab);
    return () => {
      if (this.#tabs.get(tab.id) === tab) this.#tabs.delete(tab.id);
    };
  }

  async invoke<Input = unknown, Result = unknown>(
    request: InvokeAppOperationRequest<Input>,
  ): Promise<Result> {
    const installedApp = this.#resolveEnabledApp(request.app, request.spaceId);
    const controller = this.#controllers.get(controllerKey(installedApp.appId, request.spaceId));
    if (!controller) {
      throw new AppOperationBrokerError(
        "controller-unavailable",
        `${installedApp.slug} has no controller available in Space ${request.spaceId}.`,
      );
    }
    const handler = controller.handlers[request.operation];
    if (!handler) {
      throw new AppOperationBrokerError(
        "operation-not-found",
        `${installedApp.slug} does not provide operation ${request.operation}.`,
      );
    }
    const declaration = installedApp.manifest.operations?.find(
      (candidate) => candidate.key === request.operation,
    );
    if (!declaration) {
      throw new AppOperationBrokerError(
        "operation-not-found",
        `${installedApp.slug} does not declare operation ${request.operation}.`,
      );
    }
    const validatorKey = `${installedApp.sha256}\u0000${request.operation}`;
    let validators = this.#validators.get(validatorKey);
    if (!validators) {
      validators = compileOperationValidators(declaration);
      this.#validators.set(validatorKey, validators);
    }
    try {
      assertOperationValue(request.input, validators.input, "input");
    } catch (error) {
      throw new AppOperationBrokerError("invalid-input", toError(error).message);
    }

    const invocation: OperationContext["invocation"] = {
      id: this.#mintInvocationId(),
      app: request.app,
      operation: request.operation,
      spaceId: request.spaceId,
      threadId: request.threadId,
      ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
    };
    const tab = request.tabId
      ? this.#resolveTab(request.tabId, installedApp.appId, request.spaceId, request.threadId)
      : undefined;
    const tabs: AppTabs = {
      open: (input) =>
        this.#tabHost.open({
          app: installedApp,
          spaceId: request.spaceId,
          threadId: request.threadId,
          ...input,
        }),
      openForResult: (input) =>
        this.#tabHost.openForResult({
          app: installedApp,
          spaceId: request.spaceId,
          threadId: request.threadId,
          ...input,
        }),
    };
    const context: OperationContext = {
      invocation,
      ...(tab === undefined ? {} : { tab }),
      tabs,
      signal: request.signal ?? new AbortController().signal,
    };

    const result = await handler(request.input, context);
    try {
      assertOperationValue(result, validators.output, "output");
    } catch (error) {
      throw new AppOperationBrokerError("invalid-output", toError(error).message);
    }
    return result as Result;
  }

  #resolveEnabledApp(slug: string, spaceId: string): InstalledAppPackage {
    const state = this.#installationState();
    const installedApp = Object.values(state.packagesByAppId).find(
      (candidate) => candidate.slug === slug,
    );
    if (!installedApp) {
      throw new AppOperationBrokerError("app-not-installed", `App ${slug} is not installed.`);
    }
    const spaceState = Object.values(state.spaceStateByKey).find(
      (candidate) => candidate.appId === installedApp.appId && candidate.spaceId === spaceId,
    );
    if (!spaceState?.enabled) {
      throw new AppOperationBrokerError(
        "app-disabled",
        `${installedApp.slug} is not enabled in Space ${spaceId}.`,
      );
    }
    return installedApp;
  }

  #resolveTab(tabId: string, appId: string, spaceId: string, threadId: string): AppTabEndpoint {
    const tab = this.#tabs.get(tabId);
    if (!tab) {
      throw new AppOperationBrokerError("tab-not-found", `App tab ${tabId} is not open.`);
    }
    if (tab.appId !== appId || tab.spaceId !== spaceId || tab.threadId !== threadId) {
      throw new AppOperationBrokerError(
        "tab-target-mismatch",
        `App tab ${tabId} does not belong to the invoked App, Space, and thread.`,
      );
    }
    return tab;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function controllerKey(appId: string, spaceId: string): string {
  return `${spaceId}\u0000${appId}`;
}
