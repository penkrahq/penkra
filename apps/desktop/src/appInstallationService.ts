// FILE: appInstallationService.ts
// Purpose: Coordinates trusted App package mutations with Space runtimes and persisted state.
// Layer: Trusted desktop App runtime

import {
  getInstalledAppPackage,
  registerVerifiedAppPackage,
  reconcileSpaceAppSkills,
  removeRetainedAppState,
  replaceSpaceAppPermissions,
  replaceVerifiedAppPackage,
  replaceVerifiedRegistryAppPackage,
  resetSpaceAppSetting,
  setSpaceAppPermission,
  setSpaceAppSetting,
  setSpaceAppSettingMigration,
  setSpaceAppSkillEnabled,
  unregisterAppPackage,
  type AppInstallationState,
  type AppPermissionGrant,
  type VerifiedAppPackageInput,
} from "./appInstallationState";
import { permissionsRequiringUpdateReview } from "@penkra/sdk";
import type { AppInstallationStore } from "./appInstallationStore";
import type { AppRuntimeLifecycle } from "./appRuntimeLifecycle";
import type { AppUpdateJournal } from "./appUpdateJournal";
import {
  isAppStandardPermissionName,
  type AppStandardPermissionName,
} from "./appStandardPermissions";
import {
  appSettingSecretName,
  findAppSettingDeclaration,
  isSensitiveAppSetting,
  readPlainAppSetting,
  reconcileAppSettingsAfterUpdate,
  validateAppSettingValue,
  type AppSettingSnapshot,
  type AppSettingValue,
} from "./appSettings";

export type AppInstallationStateListener = (state: AppInstallationState) => void;

export interface UninstallAppInput {
  appId: string;
  spaceId: string;
  retainData: boolean;
}

export interface AppInstallationDataEraser {
  eraseData(appId: string, spaceId: string): Promise<void>;
}

export interface AppSettingSecretStore {
  getSecret(appId: string, spaceId: string, name: string): string | null;
  setSecret(appId: string, spaceId: string, name: string, value: string): Promise<void>;
  deleteSecret(appId: string, spaceId: string, name: string): Promise<void>;
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
  readonly #lifecycle: Pick<
    AppRuntimeLifecycle,
    "enable" | "disable" | "isActive" | "subscribeUnexpectedDisable"
  >;
  readonly #data: AppInstallationDataEraser;
  readonly #updates: Pick<AppUpdateJournal, "prepare" | "clear"> | undefined;
  readonly #settingSecrets: AppSettingSecretStore;
  readonly #listeners = new Set<AppInstallationStateListener>();
  readonly #permissionRevisions = new Map<string, number>();
  readonly #pendingPermissionRequests = new Map<string, Promise<AppInstallationState>>();
  #queue: Promise<void> = Promise.resolve();

  constructor(input: {
    store: Pick<AppInstallationStore, "snapshot" | "mutate">;
    lifecycle: Pick<
      AppRuntimeLifecycle,
      "enable" | "disable" | "isActive" | "subscribeUnexpectedDisable"
    >;
    data: AppInstallationDataEraser;
    updates?: Pick<AppUpdateJournal, "prepare" | "clear">;
    settingSecrets?: AppSettingSecretStore;
  }) {
    this.#store = input.store;
    this.#lifecycle = input.lifecycle;
    this.#data = input.data;
    this.#updates = input.updates;
    this.#settingSecrets = input.settingSecrets ?? {
      getSecret: () => null,
      setSecret: async () => undefined,
      deleteSecret: async () => undefined,
    };
    this.#lifecycle.subscribeUnexpectedDisable(({ state, error, appId, spaceId }) => {
      console.error(
        `[penkra-app] Disabled ${appId} in Space ${spaceId} after its controller exited.`,
        error,
      );
      this.#publish(state);
    });
  }

  snapshot(): AppInstallationState {
    return this.#store.snapshot();
  }

  subscribe(listener: AppInstallationStateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  install(input: VerifiedAppPackageInput, spaceId: string): Promise<AppInstallationState> {
    return this.#mutate((state) => registerVerifiedAppPackage(state, input, spaceId));
  }

  async installForSpace(input: {
    package: VerifiedAppPackageInput & { source: "registry" };
    spaceId: string;
    permissions: Readonly<Record<string, AppPermissionGrant>>;
  }): Promise<AppInstallationState> {
    await this.#mutate((state) => {
      let next = registerVerifiedAppPackage(state, input.package, input.spaceId);
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

  update(
    input: VerifiedAppPackageInput & { source: "registry" },
    spaceId: string,
  ): Promise<AppInstallationState> {
    return this.#mutate((state) => {
      if (state.spaceStateByKey[`${spaceId}\u0000${input.manifest.id}`]?.enabled) {
        throw new Error("Enabled Apps must be updated through the runtime-safe Space update path.");
      }
      return replaceVerifiedRegistryAppPackage(state, input, spaceId);
    });
  }

  updateForSpace(input: {
    package: VerifiedAppPackageInput & { source: "registry" };
    spaceId: string;
    permissions: Readonly<Record<string, AppPermissionGrant>>;
  }): Promise<AppInstallationState> {
    return this.#updateForSpace(input);
  }

  updateSideloadForSpace(input: {
    package: VerifiedAppPackageInput & { source: "sideload" };
    spaceId: string;
  }): Promise<AppInstallationState> {
    const current = this.#store.snapshot();
    const existing = getInstalledAppPackage(current, input.package.manifest.id, input.spaceId);
    if (!existing || existing.source !== "sideload") {
      return Promise.reject(
        new Error(`${input.package.manifest.id} is not installed as a sideload.`),
      );
    }
    const permissions =
      current.spaceStateByKey[`${input.spaceId}\u0000${existing.appId}`]?.permissions ?? {};
    return this.#updateForSpace({
      package: input.package,
      spaceId: input.spaceId,
      permissions,
    });
  }

  #updateForSpace(input: {
    package: VerifiedAppPackageInput;
    spaceId: string;
    permissions: Readonly<Record<string, AppPermissionGrant>>;
  }): Promise<AppInstallationState> {
    return this.#enqueue(async () => {
      const previous = this.#store.snapshot();
      const appId = input.package.manifest.id;
      applyUpdate(previous, input);
      const wasEnabled =
        previous.spaceStateByKey[`${input.spaceId}\u0000${appId}`]?.enabled === true;
      await this.#updates?.prepare({
        appId,
        spaceId: input.spaceId,
        targetVersion: input.package.manifest.version,
        previousState: previous,
      });
      try {
        if (wasEnabled) await this.#lifecycle.disable(appId, input.spaceId);
        await this.#store.mutate((current) => applyUpdate(current, input));
        let state = this.#store.snapshot();
        if (wasEnabled) state = await this.#lifecycle.enable(appId, input.spaceId);
        await this.#updates?.clear();
        this.#publish(state);
        return state;
      } catch (cause) {
        const rollbackFailures: unknown[] = [];
        if (wasEnabled && this.#lifecycle.isActive(appId, input.spaceId)) {
          await this.#lifecycle
            .disable(appId, input.spaceId)
            .catch((error) => rollbackFailures.push(error));
        }
        await this.#store.mutate(() => previous).catch((error) => rollbackFailures.push(error));
        if (wasEnabled) {
          await this.#lifecycle
            .enable(appId, input.spaceId)
            .catch((error) => rollbackFailures.push(error));
        }
        if (this.#updates) {
          await this.#updates.clear().catch((error) => rollbackFailures.push(error));
        }
        this.#publish(this.#store.snapshot());
        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            [cause, ...rollbackFailures],
            `App update failed and ${rollbackFailures.length} rollback step(s) also failed.`,
          );
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
    if (input.enabled)
      assertRequiredPermissionsGranted(this.#store.snapshot(), input.appId, input.spaceId);
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
    return this.#enqueue(async () => {
      const state = this.#store.snapshot();
      const installed = getInstalledAppPackage(state, input.appId, input.spaceId);
      if (!installed) throw new Error(`${input.appId} is not installed in this Space.`);
      const declaration = (installed.manifest.permissions ?? []).find(
        (permission) => permission.name === input.permission,
      );
      if (!declaration)
        throw new Error(`${input.permission} is not declared by ${installed.name}.`);
      const space = Object.values(state.spaceStateByKey).find(
        (candidate) => candidate.appId === input.appId && candidate.spaceId === input.spaceId,
      );
      if (space?.enabled && declaration.required && input.grant !== "granted") {
        await this.#lifecycle.disable(input.appId, input.spaceId);
      }
      const next = await this.#store.mutate((current) => setSpaceAppPermission(current, input));
      this.#advancePermissionRevision(input.appId, input.spaceId, input.permission);
      this.#publish(next);
      return next;
    });
  }

  /**
   * Requests one optional manifest permission after the App invokes the dependent feature.
   * Concurrent requests share one prompt. A Settings revocation/change made while the prompt is
   * open wins instead of being overwritten by a late approval.
   */
  requestOptionalPermission(input: {
    appId: string;
    spaceId: string;
    permission: string;
    confirm(request: { appName: string; permission: string; reason: string }): Promise<boolean>;
  }): Promise<AppInstallationState> {
    const key = permissionKey(input.appId, input.spaceId, input.permission);
    const pending = this.#pendingPermissionRequests.get(key);
    if (pending) return pending;
    const request = this.#requestOptionalPermission(input, key).finally(() => {
      if (this.#pendingPermissionRequests.get(key) === request) {
        this.#pendingPermissionRequests.delete(key);
      }
    });
    this.#pendingPermissionRequests.set(key, request);
    return request;
  }

  async #requestOptionalPermission(
    input: {
      appId: string;
      spaceId: string;
      permission: string;
      confirm(request: { appName: string; permission: string; reason: string }): Promise<boolean>;
    },
    key: string,
  ): Promise<AppInstallationState> {
    const initial = this.#store.snapshot();
    const declaration = optionalPermissionDeclaration(initial, input);
    if (spacePermissionGrant(initial, input) === "granted") return initial;
    const revision = this.#permissionRevisions.get(key) ?? 0;
    const approved = await input.confirm({
      appName: getInstalledAppPackage(initial, input.appId, input.spaceId)!.name,
      permission: input.permission,
      reason: declaration.reason,
    });
    if (!approved) return this.#store.snapshot();
    return this.#enqueue(async () => {
      const current = this.#store.snapshot();
      optionalPermissionDeclaration(current, input);
      if ((this.#permissionRevisions.get(key) ?? 0) !== revision) return current;
      if (spacePermissionGrant(current, input) === "granted") return current;
      const next = await this.#store.mutate((state) =>
        setSpaceAppPermission(state, {
          appId: input.appId,
          spaceId: input.spaceId,
          permission: input.permission,
          grant: "granted",
        }),
      );
      this.#advancePermissionRevision(input.appId, input.spaceId, input.permission);
      this.#publish(next);
      return next;
    });
  }

  setRuntimePermission(input: {
    appId: string;
    spaceId: string;
    permission: AppStandardPermissionName;
    grant: AppPermissionGrant;
  }): Promise<AppInstallationState> {
    if (!isAppStandardPermissionName(input.permission))
      return Promise.reject(new Error("Unknown standard App permission."));
    return this.#enqueue(async () => {
      const next = await this.#store.mutate((state) => setSpaceAppPermission(state, input));
      this.#advancePermissionRevision(input.appId, input.spaceId, input.permission);
      this.#publish(next);
      return next;
    });
  }

  listSettings(input: { appId: string; spaceId: string }): ReadonlyArray<AppSettingSnapshot> {
    const state = this.#store.snapshot();
    const installed = getInstalledAppPackage(state, input.appId, input.spaceId);
    if (!installed) throw new Error(`${input.appId} is not installed in this Space.`);
    return (installed.manifest.contributions?.settings ?? []).map((declaration) => {
      if (isSensitiveAppSetting(declaration)) {
        return {
          declaration,
          configured:
            this.#settingSecrets.getSecret(
              input.appId,
              input.spaceId,
              appSettingSecretName(declaration.key),
            ) !== null,
        };
      }
      return {
        declaration,
        configured: Object.hasOwn(
          state.spaceStateByKey[`${input.spaceId}\u0000${input.appId}`]?.settings ?? {},
          declaration.key,
        ),
        value: readPlainAppSetting(state, input.appId, input.spaceId, declaration),
      };
    });
  }

  getSetting(input: { appId: string; spaceId: string; key: string }): AppSettingValue {
    const state = this.#store.snapshot();
    const declaration = findAppSettingDeclaration(state, input.appId, input.spaceId, input.key);
    if (isSensitiveAppSetting(declaration)) {
      return (
        this.#settingSecrets.getSecret(
          input.appId,
          input.spaceId,
          appSettingSecretName(input.key),
        ) ?? declaration.default
      );
    }
    return readPlainAppSetting(state, input.appId, input.spaceId, declaration);
  }

  async setSetting(input: {
    appId: string;
    spaceId: string;
    key: string;
    value: unknown;
  }): Promise<AppInstallationState> {
    const declaration = findAppSettingDeclaration(
      this.#store.snapshot(),
      input.appId,
      input.spaceId,
      input.key,
    );
    const value = input.value;
    validateAppSettingValue(declaration, value);
    if (!isSensitiveAppSetting(declaration)) {
      return this.#mutate((state) =>
        setSpaceAppSetting(state, {
          appId: input.appId,
          spaceId: input.spaceId,
          key: input.key,
          value,
          ...(declaration.migrationId ? { migrationId: declaration.migrationId } : {}),
        }),
      );
    }
    return this.#enqueue(async () => {
      if (typeof value !== "string") throw new Error("Sensitive App settings must contain text.");
      const secretName = appSettingSecretName(input.key);
      const previous = this.#settingSecrets.getSecret(input.appId, input.spaceId, secretName);
      await this.#settingSecrets.setSecret(input.appId, input.spaceId, secretName, value);
      try {
        const next = await this.#store.mutate((state) =>
          setSpaceAppSettingMigration(state, {
            appId: input.appId,
            spaceId: input.spaceId,
            key: input.key,
            ...(declaration.migrationId ? { migrationId: declaration.migrationId } : {}),
          }),
        );
        this.#publish(next);
        return next;
      } catch (error) {
        if (previous === null)
          await this.#settingSecrets.deleteSecret(input.appId, input.spaceId, secretName);
        else await this.#settingSecrets.setSecret(input.appId, input.spaceId, secretName, previous);
        throw error;
      }
    });
  }

  resetSetting(input: {
    appId: string;
    spaceId: string;
    key: string;
  }): Promise<AppInstallationState> {
    const declaration = findAppSettingDeclaration(
      this.#store.snapshot(),
      input.appId,
      input.spaceId,
      input.key,
    );
    return this.#enqueue(async () => {
      const secretName = appSettingSecretName(input.key);
      const previous = isSensitiveAppSetting(declaration)
        ? this.#settingSecrets.getSecret(input.appId, input.spaceId, secretName)
        : null;
      if (isSensitiveAppSetting(declaration)) {
        await this.#settingSecrets.deleteSecret(input.appId, input.spaceId, secretName);
      }
      try {
        const next = await this.#store.mutate((state) => resetSpaceAppSetting(state, input));
        this.#publish(next);
        return next;
      } catch (error) {
        if (isSensitiveAppSetting(declaration) && previous !== null) {
          await this.#settingSecrets.setSecret(input.appId, input.spaceId, secretName, previous);
        }
        throw error;
      }
    });
  }

  setSkillEnabled(input: {
    appId: string;
    spaceId: string;
    path: string;
    enabled: boolean;
  }): Promise<AppInstallationState> {
    return this.#mutate((state) => setSpaceAppSkillEnabled(state, input));
  }

  uninstall(input: UninstallAppInput): Promise<AppInstallationState> {
    return this.#enqueue(async () => {
      const snapshot = this.#store.snapshot();
      if (!getInstalledAppPackage(snapshot, input.appId, input.spaceId)) {
        throw new Error(`${input.appId} is not installed in Space ${input.spaceId}.`);
      }
      const space = snapshot.spaceStateByKey[`${input.spaceId}\u0000${input.appId}`];
      if (space?.enabled) await this.#lifecycle.disable(input.appId, input.spaceId);
      if (!input.retainData) {
        await this.#data.eraseData(input.appId, input.spaceId);
      }
      const state = await this.#store.mutate((current) => {
        const withoutPackage = unregisterAppPackage(current, input.appId, input.spaceId);
        return input.retainData
          ? withoutPackage
          : removeRetainedAppState(withoutPackage, {
              appId: input.appId,
              spaceId: input.spaceId,
            });
      });
      this.#publish(state);
      return state;
    });
  }

  removeData(input: { appId: string; spaceId: string }): Promise<AppInstallationState> {
    if (getInstalledAppPackage(this.#store.snapshot(), input.appId, input.spaceId)) {
      return Promise.reject(
        new Error("App data can only be removed after the App is uninstalled."),
      );
    }
    return this.#enqueue(async () => {
      const retainedSpaces = Object.values(this.#store.snapshot().spaceStateByKey).filter(
        (candidate) => candidate.appId === input.appId && candidate.spaceId === input.spaceId,
      );
      for (const space of retainedSpaces) {
        await this.#data.eraseData(input.appId, space.spaceId);
      }
      const state = await this.#store.mutate((current) => removeRetainedAppState(current, input));
      this.#publish(state);
      return state;
    });
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

  #advancePermissionRevision(appId: string, spaceId: string, permission: string): void {
    const key = permissionKey(appId, spaceId, permission);
    this.#permissionRevisions.set(key, (this.#permissionRevisions.get(key) ?? 0) + 1);
  }
}

function permissionKey(appId: string, spaceId: string, permission: string): string {
  return `${spaceId}\u0000${appId}\u0000${permission}`;
}

function optionalPermissionDeclaration(
  state: AppInstallationState,
  input: { appId: string; spaceId: string; permission: string },
) {
  const installed = getInstalledAppPackage(state, input.appId, input.spaceId);
  if (!installed) throw new Error(`${input.appId} is not installed in this Space.`);
  const declaration = (installed.manifest.permissions ?? []).find(
    (candidate) => candidate.name === input.permission,
  );
  if (!declaration) throw new Error(`${input.permission} is not declared by ${installed.name}.`);
  if (declaration.required) {
    throw new Error(`${input.permission} is required and cannot be requested at runtime.`);
  }
  return declaration;
}

function spacePermissionGrant(
  state: AppInstallationState,
  input: { appId: string; spaceId: string; permission: string },
): AppPermissionGrant {
  return (
    Object.values(state.spaceStateByKey).find(
      (candidate) => candidate.appId === input.appId && candidate.spaceId === input.spaceId,
    )?.permissions[input.permission] ?? "denied"
  );
}

function applyUpdate(
  state: AppInstallationState,
  input: {
    package: VerifiedAppPackageInput;
    spaceId: string;
    permissions: Readonly<Record<string, AppPermissionGrant>>;
  },
): AppInstallationState {
  const appId = input.package.manifest.id;
  const previousPackage = getInstalledAppPackage(state, appId, input.spaceId);
  if (!previousPackage) throw new Error(`${appId} is not installed in Space ${input.spaceId}.`);
  let next = replaceVerifiedAppPackage(state, input.package, input.spaceId);
  next = reconcileAppSettingsAfterUpdate(next, appId, input.spaceId);
  next = reconcileSpaceAppSkills(next, appId, input.spaceId);
  const declarations = input.package.manifest.permissions ?? [];
  const reviewRequired = new Set(
    permissionsRequiringUpdateReview(previousPackage.manifest.permissions ?? [], declarations),
  );
  const declaredNames = new Set(declarations.map((permission) => permission.name));
  for (const permission of Object.keys(input.permissions)) {
    if (!declaredNames.has(permission))
      throw new Error(`App update includes undeclared permission ${permission}.`);
  }
  const space = state.spaceStateByKey[`${input.spaceId}\u0000${appId}`];
  if (!space) throw new Error(`${appId} has no state in Space ${input.spaceId}.`);
  if (space.enabled) {
    for (const permission of reviewRequired) {
      if (!Object.hasOwn(input.permissions, permission)) {
        throw new Error(
          `New App permission ${permission} must be reviewed for Space ${input.spaceId}.`,
        );
      }
    }
  }
  const permissions = Object.fromEntries(
    declarations.map((declaration) => [
      declaration.name,
      input.permissions[declaration.name] ?? space.permissions[declaration.name] ?? "denied",
    ]),
  ) as Record<string, AppPermissionGrant>;
  if (space.enabled) {
    for (const declaration of declarations) {
      if (declaration.required && permissions[declaration.name] !== "granted") {
        throw new Error(
          `Required App permission ${declaration.name} must be reviewed for Space ${input.spaceId}.`,
        );
      }
    }
  }
  return replaceSpaceAppPermissions(next, { appId, spaceId: input.spaceId, permissions });
}

function assertRequiredPermissionsGranted(
  state: AppInstallationState,
  appId: string,
  spaceId: string,
): void {
  const installed = getInstalledAppPackage(state, appId, spaceId);
  if (!installed) throw new Error(`${appId} is not installed in Space ${spaceId}.`);
  const space = Object.values(state.spaceStateByKey).find(
    (candidate) => candidate.appId === appId && candidate.spaceId === spaceId,
  );
  for (const permission of installed.manifest.permissions ?? []) {
    if (permission.required && space?.permissions[permission.name] !== "granted") {
      throw new Error(
        `Required App permission ${permission.name} must be granted before enabling ${installed.name}.`,
      );
    }
  }
}
