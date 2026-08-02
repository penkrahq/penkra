// FILE: appInstallationService.ts
// Purpose: Coordinates trusted App package mutations with Space runtimes and persisted state.
// Layer: Trusted desktop App runtime

import {
  registerVerifiedAppPackage,
  removeRetainedAppState,
  replaceVerifiedRegistryAppPackage,
  setSpaceAppPermission,
  unregisterAppPackage,
  type AppInstallationState,
  type AppPermissionGrant,
  type VerifiedAppPackageInput,
} from "./appInstallationState";
import type { AppInstallationStore } from "./appInstallationStore";
import type { AppRuntimeLifecycle } from "./appRuntimeLifecycle";

export type AppInstallationStateListener = (state: AppInstallationState) => void;

export interface UninstallAppInput {
  appId: string;
  retainData: boolean;
}

/**
 * The narrow trusted mutation boundary used by the Apps App and core Settings.
 *
 * Package verification/copying happens before this service receives a
 * VerifiedAppPackageInput. This class owns the ordering between persisted
 * intent and live controllers so callers cannot mutate the JSON store without
 * reconciling the runtime.
 */
export class AppInstallationService {
  readonly #store: Pick<AppInstallationStore, "snapshot" | "mutate">;
  readonly #lifecycle: Pick<AppRuntimeLifecycle, "enable" | "disable" | "isActive">;
  readonly #listeners = new Set<AppInstallationStateListener>();
  #queue: Promise<void> = Promise.resolve();

  constructor(input: {
    store: Pick<AppInstallationStore, "snapshot" | "mutate">;
    lifecycle: Pick<AppRuntimeLifecycle, "enable" | "disable" | "isActive">;
  }) {
    this.#store = input.store;
    this.#lifecycle = input.lifecycle;
  }

  snapshot(): AppInstallationState {
    return this.#store.snapshot();
  }

  subscribe(listener: AppInstallationStateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  install(input: VerifiedAppPackageInput): Promise<AppInstallationState> {
    return this.#mutate((state) => registerVerifiedAppPackage(state, input));
  }

  async installForSpace(input: {
    package: VerifiedAppPackageInput & { source: "registry" };
    spaceId: string;
    permissions: Readonly<Record<string, AppPermissionGrant>>;
  }): Promise<AppInstallationState> {
    await this.#mutate((state) => {
      let next = registerVerifiedAppPackage(state, input.package);
      for (const [permission, grant] of Object.entries(input.permissions)) {
        next = setSpaceAppPermission(next, {
          appId: input.package.manifest.id,
          spaceId: input.spaceId,
          permission,
          grant,
        });
      }
      return next;
    });
    const state = await this.#lifecycle.enable(input.package.manifest.id, input.spaceId);
    this.#publish(state);
    return state;
  }

  update(input: VerifiedAppPackageInput & { source: "registry" }): Promise<AppInstallationState> {
    return this.#mutate((state) => replaceVerifiedRegistryAppPackage(state, input));
  }

  async setEnabled(input: {
    appId: string;
    spaceId: string;
    enabled: boolean;
  }): Promise<AppInstallationState> {
    const state = input.enabled
      ? await this.#lifecycle.enable(input.appId, input.spaceId)
      : await this.#lifecycle.disable(input.appId, input.spaceId);
    this.#publish(state);
    return state;
  }

  setPermission(input: {
    appId: string;
    spaceId: string;
    permission: string;
    grant: AppPermissionGrant;
  }): Promise<AppInstallationState> {
    return this.#mutate((state) => setSpaceAppPermission(state, input));
  }

  uninstall(input: UninstallAppInput): Promise<AppInstallationState> {
    return this.#enqueue(async () => {
      const snapshot = this.#store.snapshot();
      const enabledSpaces = Object.values(snapshot.spaceStateByKey).filter(
        (candidate) => candidate.appId === input.appId && candidate.enabled,
      );
      for (const space of enabledSpaces) {
        await this.#lifecycle.disable(input.appId, space.spaceId);
      }
      const state = await this.#store.mutate((current) => {
        const withoutPackage = unregisterAppPackage(current, input.appId);
        return input.retainData
          ? withoutPackage
          : removeRetainedAppState(withoutPackage, { appId: input.appId });
      });
      this.#publish(state);
      return state;
    });
  }

  removeData(input: { appId: string; spaceId?: string }): Promise<AppInstallationState> {
    if (Object.values(this.#store.snapshot().packagesByAppId).some((app) => app.appId === input.appId)) {
      return Promise.reject(new Error("App data can only be removed after the App is uninstalled."));
    }
    return this.#mutate((state) => removeRetainedAppState(state, input));
  }

  isActive(appId: string, spaceId: string): boolean {
    return this.#lifecycle.isActive(appId, spaceId);
  }

  #mutate(
    transition: (state: AppInstallationState) => AppInstallationState,
  ): Promise<AppInstallationState> {
    return this.#enqueue(async () => {
      const state = await this.#store.mutate(transition);
      this.#publish(state);
      return state;
    });
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #publish(state: AppInstallationState): void {
    for (const listener of this.#listeners) listener(state);
  }
}
