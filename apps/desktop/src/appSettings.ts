import { createHash } from "node:crypto";

import type { AppSettingDeclaration } from "@penkra/sdk";

import type { AppInstallationState } from "./appInstallationState";

export type AppSettingValue = boolean | number | string;

export interface AppSettingSnapshot {
  declaration: AppSettingDeclaration;
  value?: AppSettingValue;
  configured: boolean;
}

export function findAppSettingDeclaration(
  state: AppInstallationState,
  appId: string,
  key: string,
): AppSettingDeclaration {
  const installed = state.packagesByAppId[appId];
  if (!installed) throw new Error(`${appId} is not installed.`);
  const declaration = (installed.manifest.contributions?.settings ?? []).find(
    (candidate) => candidate.key === key,
  );
  if (!declaration) throw new Error(`${key} is not declared by ${installed.name}.`);
  return declaration;
}

export function validateAppSettingValue(
  declaration: AppSettingDeclaration,
  value: unknown,
): asserts value is AppSettingValue {
  if (declaration.type === "boolean") {
    if (typeof value !== "boolean") throw invalidSetting(declaration, "must be a boolean");
    return;
  }
  if (declaration.type === "string") {
    if (typeof value !== "string") throw invalidSetting(declaration, "must be text");
    const bytes = Buffer.byteLength(value);
    if (bytes > 64 * 1024) throw invalidSetting(declaration, "may contain at most 64 KiB of text");
    if (
      declaration.validation?.minLength !== undefined &&
      value.length < declaration.validation.minLength
    ) {
      throw invalidSetting(
        declaration,
        `must contain at least ${declaration.validation.minLength} characters`,
      );
    }
    if (
      declaration.validation?.maxLength !== undefined &&
      value.length > declaration.validation.maxLength
    ) {
      throw invalidSetting(
        declaration,
        `may contain at most ${declaration.validation.maxLength} characters`,
      );
    }
    return;
  }
  if (declaration.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw invalidSetting(declaration, "must be a finite number");
    }
    if (declaration.validation?.minimum !== undefined && value < declaration.validation.minimum) {
      throw invalidSetting(declaration, `must be at least ${declaration.validation.minimum}`);
    }
    if (declaration.validation?.maximum !== undefined && value > declaration.validation.maximum) {
      throw invalidSetting(declaration, `may be at most ${declaration.validation.maximum}`);
    }
    if (declaration.validation?.step !== undefined) {
      const origin = declaration.validation.minimum ?? 0;
      const steps = (value - origin) / declaration.validation.step;
      if (Math.abs(steps - Math.round(steps)) > Number.EPSILON * 16) {
        throw invalidSetting(declaration, `must follow a step of ${declaration.validation.step}`);
      }
    }
    return;
  }
  if (typeof value !== "string" || !declaration.options.some((option) => option.value === value)) {
    throw invalidSetting(declaration, "must match a declared option");
  }
}

export function readPlainAppSetting(
  state: AppInstallationState,
  appId: string,
  spaceId: string,
  declaration: AppSettingDeclaration,
): AppSettingValue {
  const stored = state.spaceStateByKey[`${spaceId}\u0000${appId}`]?.settings[declaration.key];
  if (stored === undefined) return declaration.default;
  validateAppSettingValue(declaration, stored);
  return stored;
}

export function appSettingSecretName(key: string): string {
  return `setting-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

export function isSensitiveAppSetting(
  declaration: AppSettingDeclaration,
): declaration is Extract<AppSettingDeclaration, { type: "string" }> & { sensitive: true } {
  return declaration.type === "string" && declaration.sensitive === true;
}

/** Applies a new immutable manifest's declarative Settings schema to retained plain values. */
export function reconcileAppSettingsAfterUpdate(
  state: AppInstallationState,
  appId: string,
): AppInstallationState {
  const declarations = state.packagesByAppId[appId]?.manifest.contributions?.settings ?? [];
  const byKey = new Map(declarations.map((declaration) => [declaration.key, declaration]));
  let changed = false;
  const spaceStateByKey = Object.fromEntries(
    Object.entries(state.spaceStateByKey).map(([scopeKey, space]) => {
      if (space.appId !== appId) return [scopeKey, space];
      const settings: Record<string, AppSettingValue> = {};
      const settingMigrations: Record<string, string> = {};
      for (const [key, stored] of Object.entries(space.settings)) {
        const declaration = byKey.get(key);
        if (!declaration || isSensitiveAppSetting(declaration)) {
          changed = true;
          continue;
        }
        try {
          validateAppSettingValue(declaration, stored);
          settings[key] = stored;
        } catch {
          changed = true;
        }
      }
      for (const declaration of declarations) {
        if (!declaration.migrationId) continue;
        settingMigrations[declaration.key] = declaration.migrationId;
      }
      if (
        JSON.stringify(settings) !== JSON.stringify(space.settings) ||
        JSON.stringify(settingMigrations) !== JSON.stringify(space.settingMigrations)
      ) {
        changed = true;
        return [scopeKey, { ...space, settings, settingMigrations }];
      }
      return [scopeKey, space];
    }),
  );
  return changed ? { ...state, spaceStateByKey } : state;
}

function invalidSetting(declaration: AppSettingDeclaration, message: string): TypeError {
  return new TypeError(`${declaration.label} ${message}.`);
}
