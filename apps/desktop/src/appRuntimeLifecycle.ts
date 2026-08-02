// FILE: appRuntimeLifecycle.ts
// Purpose: Reconciles persisted Space enablement with App sessions and isolated controllers.
// Layer: Trusted desktop App runtime

import {
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
  }): Promise<(reason?: OperationCancellationCode) => Promise<void> | void>;
}

export interface AppRuntimeLifecycleDependencies {
  store: Pick<AppInstallationStore, "snapshot" | "mutate">;
  sessions: Pick<AppSessionManager, "activate" | "deactivate">;
  controllers: AppRuntimeControllerHost;
}

export type AppRuntimeRestoreResult =
  | { status: "active"; appId: string; spaceId: string }
  | { status: "failed"; appId: string; spaceId: string; error: Error };

interface ActiveRuntime {
  appId: string;
  spaceId: string;
  releaseController: (reason?: OperationCancellationCode) => Promise<void> | void;
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
  readonly #active = new Map<string, ActiveRuntime>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(dependencies: AppRuntimeLifecycleDependencies) {
    this.#store = dependencies.store;
    this.#sessions = dependencies.sessions;
    this.#controllers = dependencies.controllers;
  }

  async restoreEnabled(): Promise<ReadonlyArray<AppRuntimeRestoreResult>> {
    const snapshot = this.#store.snapshot();
    const enabled = Object.values(snapshot.spaceStateByKey).filter((state) => state.enabled);
    return Promise.all(
      enabled.map(async (spaceState): Promise<AppRuntimeRestoreResult> => {
        try {
          await this.#enqueue(runtimeKey(spaceState.appId, spaceState.spaceId), () =>
            this.#activate(spaceState.appId, spaceState.spaceId, snapshot),
          );
          return { status: "active", appId: spaceState.appId, spaceId: spaceState.spaceId };
        } catch (error) {
          return {
            status: "failed",
            appId: spaceState.appId,
            spaceId: spaceState.spaceId,
            error: toError(error),
          };
        }
      }),
    );
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

  disable(appId: string, spaceId: string): Promise<AppInstallationState> {
    return this.#enqueue(runtimeKey(appId, spaceId), async () => {
      // Persist disabled first. The broker reads this snapshot for every new
      // invocation, so no new work enters while teardown is in progress.
      const state = await this.#store.mutate((current) =>
        setSpaceAppEnabled(current, { appId, spaceId, enabled: false }),
      );
      await this.#deactivate(appId, spaceId);
      return state;
    });
  }

  isActive(appId: string, spaceId: string): boolean {
    return this.#active.has(runtimeKey(appId, spaceId));
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

  async #activate(
    appId: string,
    spaceId: string,
    snapshot: AppInstallationState,
  ): Promise<void> {
    const key = runtimeKey(appId, spaceId);
    if (this.#active.has(key)) return;
    const installedApp = snapshot.packagesByAppId[appId];
    if (!installedApp) throw new Error(`${appId} is not installed.`);

    const activeSession = await this.#sessions.activate({ installedApp, spaceId });
    let releaseController: (() => Promise<void> | void) | null = null;
    try {
      releaseController = await this.#controllers.activate({
        installedApp,
        spaceId,
        session: activeSession,
      });
      this.#active.set(key, { appId, spaceId, releaseController });
    } catch (error) {
      await this.#sessions.deactivate(appId, spaceId).catch(() => undefined);
      throw error;
    }
  }

  async #deactivate(
    appId: string,
    spaceId: string,
    reason: OperationCancellationCode = "app-disabled",
  ): Promise<void> {
    const key = runtimeKey(appId, spaceId);
    const active = this.#active.get(key);
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
