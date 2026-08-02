// FILE: appInstallationService.ts
// Purpose: Coordinates trusted App package mutations with Space runtimes and persisted state.
// Layer: Trusted desktop App runtime

import {
  registerVerifiedAppPackage,
  removeRetainedAppState,
  replaceSpaceAppPermissions,
  replaceVerifiedAppPackage,
  replaceVerifiedRegistryAppPackage,
  setSpaceAppPermission,
  unregisterAppPackage,
  type AppInstallationState,
  type AppPermissionGrant,
  type VerifiedAppPackageInput,
} from "./appInstallationState";
import { permissionsRequiringUpdateReview } from "@penkra/sdk";
import type { AppInstallationStore } from "./appInstallationStore";
import type { AppRuntimeLifecycle } from "./appRuntimeLifecycle";
import type { AppUpdateJournal } from "./appUpdateJournal";

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
  readonly #updates: Pick<AppUpdateJournal, "prepare" | "clear"> | undefined;
  readonly #listeners = new Set<AppInstallationStateListener>();
  #queue: Promise<void> = Promise.resolve();

  constructor(input: {
    store: Pick<AppInstallationStore, "snapshot" | "mutate">;
    lifecycle: Pick<AppRuntimeLifecycle, "enable" | "disable" | "isActive">;
    updates?: Pick<AppUpdateJournal, "prepare" | "clear">;
  }) {
    this.#store = input.store;
    this.#lifecycle = input.lifecycle;
    this.#updates = input.updates;
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
    return this.#mutate((state) => {
      if (Object.values(state.spaceStateByKey).some((space) => space.appId === input.manifest.id && space.enabled)) {
        throw new Error("Enabled Apps must be updated through the runtime-safe Space update path.");
      }
      return replaceVerifiedRegistryAppPackage(state, input);
    });
  }

  updateForSpaces(input: {
    package: VerifiedAppPackageInput & { source: "registry" };
    permissionsBySpace: Readonly<Record<string, Readonly<Record<string, AppPermissionGrant>>>>;
  }): Promise<AppInstallationState> {
    return this.#updateForSpaces(input);
  }

  updateSideloadForSpaces(input: {
    package: VerifiedAppPackageInput & { source: "sideload" };
  }): Promise<AppInstallationState> {
    const current = this.#store.snapshot();
    const existing = current.packagesByAppId[input.package.manifest.id];
    if (!existing || existing.source !== "sideload") {
      return Promise.reject(new Error(`${input.package.manifest.id} is not installed as a sideload.`));
    }
    const permissionsBySpace = Object.fromEntries(
      Object.values(current.spaceStateByKey)
        .filter((space) => space.appId === existing.appId)
        .map((space) => [space.spaceId, space.permissions]),
    );
    return this.#updateForSpaces({ package: input.package, permissionsBySpace });
  }

  #updateForSpaces(input: {
    package: VerifiedAppPackageInput;
    permissionsBySpace: Readonly<Record<string, Readonly<Record<string, AppPermissionGrant>>>>;
  }): Promise<AppInstallationState> {
    return this.#enqueue(async () => {
      const previous = this.#store.snapshot();
      const appId = input.package.manifest.id;
      applyUpdate(previous, input);
      const enabledSpaces = Object.values(previous.spaceStateByKey)
        .filter((space) => space.appId === appId && space.enabled)
        .map((space) => space.spaceId);
      await this.#updates?.prepare({
        appId,
        targetVersion: input.package.manifest.version,
        previousState: previous,
      });
      try {
        for (const spaceId of enabledSpaces) await this.#lifecycle.disable(appId, spaceId);
        await this.#store.mutate((current) => applyUpdate(current, input));
        let state = this.#store.snapshot();
        for (const spaceId of enabledSpaces) state = await this.#lifecycle.enable(appId, spaceId);
        await this.#updates?.clear();
        this.#publish(state);
        return state;
      } catch (cause) {
        const rollbackFailures: unknown[] = [];
        for (const spaceId of enabledSpaces) {
          if (!this.#lifecycle.isActive(appId, spaceId)) continue;
          await this.#lifecycle.disable(appId, spaceId).catch((error) => rollbackFailures.push(error));
        }
        await this.#store.mutate(() => previous).catch((error) => rollbackFailures.push(error));
        for (const spaceId of enabledSpaces) {
          await this.#lifecycle.enable(appId, spaceId).catch((error) => rollbackFailures.push(error));
        }
        if (this.#updates) {
          await this.#updates.clear().catch((error) => rollbackFailures.push(error));
        }
        this.#publish(this.#store.snapshot());
        if (rollbackFailures.length > 0) {
          throw new AggregateError([cause, ...rollbackFailures], `App update failed and ${rollbackFailures.length} rollback step(s) also failed.`);
        }
        throw cause;
      }
    });
  }

  async setEnabled(input: {
    appId: string;
    spaceId: string;
    enabled: boolean;
  }): Promise<AppInstallationState> {
    if (input.enabled) assertRequiredPermissionsGranted(this.#store.snapshot(), input.appId, input.spaceId);
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
    return this.#mutate((state) => {
      const installed = state.packagesByAppId[input.appId];
      if (!installed) throw new Error(`${input.appId} is not installed.`);
      const declaration = (installed.manifest.permissions ?? []).find((permission) => permission.name === input.permission);
      if (!declaration) throw new Error(`${input.permission} is not declared by ${installed.name}.`);
      const space = Object.values(state.spaceStateByKey).find(
        (candidate) => candidate.appId === input.appId && candidate.spaceId === input.spaceId,
      );
      if (space?.enabled && declaration.required && input.grant !== "granted") {
        throw new Error(`Required App permission ${input.permission} cannot be denied while the App is enabled.`);
      }
      return setSpaceAppPermission(state, input);
    });
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

function applyUpdate(
  state: AppInstallationState,
  input: {
    package: VerifiedAppPackageInput;
    permissionsBySpace: Readonly<Record<string, Readonly<Record<string, AppPermissionGrant>>>>;
  },
): AppInstallationState {
  const appId = input.package.manifest.id;
  let next = replaceVerifiedAppPackage(state, input.package);
  const declarations = input.package.manifest.permissions ?? [];
  const reviewRequired = new Set(permissionsRequiringUpdateReview(
    state.packagesByAppId[appId]?.manifest.permissions ?? [],
    declarations,
  ));
  const declaredNames = new Set(declarations.map((permission) => permission.name));
  const spaces = Object.values(state.spaceStateByKey).filter((space) => space.appId === appId);
  const knownSpaces = new Set(spaces.map((space) => space.spaceId));
  for (const [spaceId, review] of Object.entries(input.permissionsBySpace)) {
    if (!knownSpaces.has(spaceId)) throw new Error(`App update includes unknown Space ${spaceId}.`);
    for (const permission of Object.keys(review)) {
      if (!declaredNames.has(permission)) throw new Error(`App update includes undeclared permission ${permission}.`);
    }
  }
  for (const space of spaces) {
    const review = input.permissionsBySpace[space.spaceId] ?? {};
    if (space.enabled) {
      for (const permission of reviewRequired) {
        if (!Object.hasOwn(review, permission)) {
          throw new Error(`New App permission ${permission} must be reviewed for Space ${space.spaceId}.`);
        }
      }
    }
    const permissions = Object.fromEntries(declarations.map((declaration) => [
      declaration.name,
      review[declaration.name] ?? space.permissions[declaration.name] ?? "denied",
    ])) as Record<string, AppPermissionGrant>;
    if (space.enabled) {
      for (const declaration of declarations) {
        if (declaration.required && permissions[declaration.name] !== "granted") {
          throw new Error(`Required App permission ${declaration.name} must be reviewed for Space ${space.spaceId}.`);
        }
      }
    }
    next = replaceSpaceAppPermissions(next, { appId, spaceId: space.spaceId, permissions });
  }
  return next;
}

function assertRequiredPermissionsGranted(state: AppInstallationState, appId: string, spaceId: string): void {
  const installed = state.packagesByAppId[appId];
  if (!installed) throw new Error(`${appId} is not installed.`);
  const space = Object.values(state.spaceStateByKey).find(
    (candidate) => candidate.appId === appId && candidate.spaceId === spaceId,
  );
  for (const permission of installed.manifest.permissions ?? []) {
    if (permission.required && space?.permissions[permission.name] !== "granted") {
      throw new Error(`Required App permission ${permission.name} must be granted before enabling ${installed.name}.`);
    }
  }
}
