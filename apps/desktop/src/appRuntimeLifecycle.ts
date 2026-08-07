// FILE: appRuntimeLifecycle.ts
// Purpose: Reconciles persisted Space enablement with App sessions and isolated controllers.
// Layer: Trusted desktop App runtime

import {
  getInstalledAppPackage,
  setSpaceAppEnabled,
  type AppInstallationState,
  type InstalledAppPackage,
} from "./appInstallationState";
import type { AppInstallationStore } from "./appInstallationStore";
import type { ActiveAppSession, AppSessionManager } from "./appSessionManager";
import type { OperationCancellationCode } from "@penkra/sdk";

export interface AppRuntimeControllerHost {
  activate(input: {
    installedApp: InstalledAppPackage;
    spaceId: string;
    session: ActiveAppSession;
    onUnexpectedExit?: (error: Error) => void;
  }): Promise<(reason?: OperationCancellationCode) => Promise<void> | void>;
}

export interface AppRuntimeLifecycleDependencies {
  store: Pick<AppInstallationStore, "snapshot" | "mutate">;
  sessions: Pick<AppSessionManager, "activate" | "deactivate">;
  controllers: AppRuntimeControllerHost;
  assertAppAllowed?: (app: InstalledAppPackage) => Promise<void>;
  closeTabs?: (appId: string, spaceId: string, reason: OperationCancellationCode) => void;
}

interface ActiveRuntime {
  appId: string;
  spaceId: string;
  releaseController: (reason?: OperationCancellationCode) => Promise<void> | void;
  token: object;
}

export interface AppRuntimeUnexpectedDisable {
  appId: string;
  spaceId: string;
  error: Error;
  state: AppInstallationState;
}

/**
 * Makes persisted enablement the authority visible to operation routing while
 * keeping activation recoverable. Startup failures remain explicit instead of
 * silently rewriting user intent to disabled.
 */
export class AppRuntimeLifecycle {
  readonly #store: AppRuntimeLifecycleDependencies["store"];
  readonly #sessions: AppRuntimeLifecycleDependencies["sessions"];
  readonly #controllers: AppRuntimeControllerHost;
  readonly #assertAppAllowed: (app: InstalledAppPackage) => Promise<void>;
  readonly #closeTabs: (appId: string, spaceId: string, reason: OperationCancellationCode) => void;
  readonly #active = new Map<string, ActiveRuntime>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #unexpectedDisableListeners = new Set<(event: AppRuntimeUnexpectedDisable) => void>();

  constructor(dependencies: AppRuntimeLifecycleDependencies) {
    this.#store = dependencies.store;
    this.#sessions = dependencies.sessions;
    this.#controllers = dependencies.controllers;
    this.#assertAppAllowed = dependencies.assertAppAllowed ?? (async () => undefined);
    this.#closeTabs = dependencies.closeTabs ?? (() => undefined);
  }

  enable(appId: string, spaceId: string): Promise<AppInstallationState> {
    return this.#enqueue(runtimeKey(appId, spaceId), async () => {
      const alreadyActive = this.#active.has(runtimeKey(appId, spaceId));
      if (!alreadyActive) await this.#activate(appId, spaceId, this.#store.snapshot());
      try {
        return await this.#store.mutate((state) =>
          setSpaceAppEnabled(state, { appId, spaceId, enabled: true }),
        );
      } catch (error) {
        if (!alreadyActive) await this.#deactivate(appId, spaceId).catch(() => undefined);
        throw error;
      }
    });
  }

  ensureActive(appId: string, spaceId: string): Promise<void> {
    return this.#enqueue(runtimeKey(appId, spaceId), async () => {
      if (this.#active.has(runtimeKey(appId, spaceId))) return;
      const snapshot = this.#store.snapshot();
      const spaceState = Object.values(snapshot.spaceStateByKey).find(
        (candidate) => candidate.appId === appId && candidate.spaceId === spaceId,
      );
      if (!spaceState?.enabled) {
        throw new Error(`${appId} is not enabled in Space ${spaceId}.`);
      }
      await this.#activate(appId, spaceId, snapshot);
    });
  }

  disable(
    appId: string,
    spaceId: string,
    reason: OperationCancellationCode = "app-disabled",
  ): Promise<AppInstallationState> {
    return this.#enqueue(runtimeKey(appId, spaceId), async () => {
      // Persist disabled first. The broker reads this snapshot for every new
      // invocation, so no new work enters while teardown is in progress.
      const state = await this.#store.mutate((current) =>
        setSpaceAppEnabled(current, { appId, spaceId, enabled: false }),
      );
      await this.#deactivate(appId, spaceId, reason);
      return state;
    });
  }

  isActive(appId: string, spaceId: string): boolean {
    return this.#active.has(runtimeKey(appId, spaceId));
  }

  subscribeUnexpectedDisable(listener: (event: AppRuntimeUnexpectedDisable) => void): () => void {
    this.#unexpectedDisableListeners.add(listener);
    return () => this.#unexpectedDisableListeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    const active = [...this.#active.values()];
    const results = await Promise.allSettled(
      active.map((runtime) =>
        this.#enqueue(runtimeKey(runtime.appId, runtime.spaceId), () =>
          this.#deactivate(runtime.appId, runtime.spaceId, "host-stopped"),
        ),
      ),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "One or more App runtimes failed to stop.",
      );
    }
  }

  async #activate(appId: string, spaceId: string, snapshot: AppInstallationState): Promise<void> {
    const key = runtimeKey(appId, spaceId);
    if (this.#active.has(key)) return;
    const installedApp = getInstalledAppPackage(snapshot, appId, spaceId);
    if (!installedApp) throw new Error(`${appId} is not installed in Space ${spaceId}.`);
    await this.#assertAppAllowed(installedApp);

    const activeSession = await this.#sessions.activate({ installedApp, spaceId });
    let releaseController: ((reason?: OperationCancellationCode) => Promise<void> | void) | null =
      null;
    const token = {};
    let activationComplete = false;
    let unexpectedExit: Error | null = null;
    try {
      releaseController = await this.#controllers.activate({
        installedApp,
        spaceId,
        session: activeSession,
        onUnexpectedExit: (error) => {
          unexpectedExit = error;
          if (activationComplete) this.#scheduleUnexpectedDisable(appId, spaceId, token, error);
        },
      });
      if (unexpectedExit) throw unexpectedExit;
      this.#active.set(key, { appId, spaceId, releaseController, token });
      activationComplete = true;
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (releaseController) {
        await Promise.resolve(releaseController("host-stopped")).catch((cause) =>
          cleanupFailures.push(cause),
        );
      }
      await this.#sessions.deactivate(appId, spaceId).catch((cause) => cleanupFailures.push(cause));
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `App activation failed and cleanup also failed.`,
        );
      }
      throw error;
    }
  }

  #scheduleUnexpectedDisable(appId: string, spaceId: string, token: object, error: Error): void {
    void this.#enqueue(runtimeKey(appId, spaceId), async () => {
      const active = this.#active.get(runtimeKey(appId, spaceId));
      if (!active || active.token !== token) return;
      let state: AppInstallationState | null = null;
      const failures: unknown[] = [];
      try {
        state = await this.#store.mutate((current) =>
          setSpaceAppEnabled(current, { appId, spaceId, enabled: false }),
        );
      } catch (cause) {
        failures.push(cause);
      }
      try {
        await this.#deactivate(appId, spaceId, "app-disabled");
      } catch (cause) {
        failures.push(cause);
      }
      const crash =
        failures.length === 0 ? error : new AggregateError([error, ...failures], error.message);
      if (state) {
        const event = { appId, spaceId, error: crash, state };
        for (const listener of this.#unexpectedDisableListeners) listener(event);
      } else {
        console.error(
          `[penkra-app] Failed to persist crash disable for ${appId} in Space ${spaceId}.`,
          crash,
        );
      }
    }).catch((cause) => {
      console.error(
        `[penkra-app] Failed to reconcile crashed controller ${appId} in Space ${spaceId}.`,
        cause,
      );
    });
  }

  async #deactivate(
    appId: string,
    spaceId: string,
    reason: OperationCancellationCode = "app-disabled",
  ): Promise<void> {
    const key = runtimeKey(appId, spaceId);
    const active = this.#active.get(key);
    this.#closeTabs(appId, spaceId, reason);
    let controllerError: unknown;
    if (active) {
      try {
        await active.releaseController(reason);
      } catch (error) {
        controllerError = error;
      } finally {
        this.#active.delete(key);
      }
    }
    await this.#sessions.deactivate(appId, spaceId);
    if (controllerError !== undefined) throw controllerError;
  }

  #enqueue<Result>(key: string, mutation: () => Promise<Result>): Promise<Result> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const operation = previous.then(mutation);
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, settled);
    void settled.finally(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return operation;
  }
}

function runtimeKey(appId: string, spaceId: string): string {
  return `${spaceId}\u0000${appId}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
