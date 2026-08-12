// FILE: requiredRegistryAppBootstrap.ts
// Purpose: Loads Penkra's embedded Apps archive and reconciles its required per-Space installation.
// Layer: Trusted desktop App bootstrap

import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { compare, satisfies } from "semver";
import {
  parseRequiredAppsReleaseLock,
  REQUIRED_APPS_APP_ID,
  REQUIRED_APPS_ARCHIVE_FILE_NAME,
  REQUIRED_APPS_BUNDLE_DIRECTORY,
  REQUIRED_APPS_LOCK_FILE_NAME,
  REQUIRED_APPS_SLUG,
  REQUIRED_APPS_SOURCE_PATH_ENV,
  type RequiredAppsReleaseLock,
} from "@penkra/shared/requiredAppsRelease";

import type { DesktopAppRuntime } from "./desktopAppRuntime";
import {
  getInstalledAppPackage,
  type AppPermissionGrant,
  type VerifiedAppPackageInput,
} from "./appInstallationState";
export {
  parseRequiredAppsReleaseLock,
  REQUIRED_APPS_ARCHIVE_FILE_NAME,
  REQUIRED_APPS_BUNDLE_DIRECTORY,
  REQUIRED_APPS_LOCK_FILE_NAME,
  REQUIRED_APPS_SOURCE_PATH_ENV,
  type RequiredAppsReleaseLock,
} from "@penkra/shared/requiredAppsRelease";

const REQUIRED_APPS_LOCK_MAX_BYTES = 16 * 1024;
const REQUIRED_APPS_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

export type RequiredAppsBundleSource =
  | { kind: "archive"; archivePath: string; lockPath: string }
  | { kind: "directory"; sourcePath: string };

export interface RequiredAppsReconciliationResult {
  spaceId: string;
  status:
    | "installed"
    | "current"
    | "updated"
    | "newer"
    | "development-existing"
    | "development-sideload";
}

export function resolveRequiredAppsBundle(input: {
  configuredSourcePath?: string;
  resourcesPath: string;
  desktopBundleDirectory: string;
  packaged: boolean;
}): RequiredAppsBundleSource | null {
  const configured = input.configuredSourcePath?.trim();
  if (configured) {
    const resolved = Path.resolve(configured);
    const configuredBundle = resolveBundleCandidate(resolved);
    if (configuredBundle) return configuredBundle;
    return null;
  }

  if (input.packaged) {
    return (
      resolveBundleCandidate(Path.join(input.resourcesPath, REQUIRED_APPS_BUNDLE_DIRECTORY)) ??
      resolveBundleCandidate(
        Path.resolve(
          input.desktopBundleDirectory,
          "../prod-resources",
          REQUIRED_APPS_BUNDLE_DIRECTORY,
        ),
      )
    );
  }

  return resolveBundleCandidate(
    Path.resolve(input.desktopBundleDirectory, "../../../..", "penkra-apps", "apps"),
  );
}

export async function loadRequiredAppsPackage(input: {
  runtime: Pick<DesktopAppRuntime, "packages">;
  source: RequiredAppsBundleSource;
  hostVersion: string;
}): Promise<VerifiedAppPackageInput & { source: "registry" }> {
  let verified: VerifiedAppPackageInput;
  let lockedVersion: string | null = null;
  if (input.source.kind === "archive") {
    const lock = await readReleaseLock(input.source.lockPath);
    const archive = await readBoundedFile(
      input.source.archivePath,
      REQUIRED_APPS_ARCHIVE_MAX_BYTES,
      "Required Apps archive",
    );
    const packageDigest = createHash("sha256").update(archive).digest("hex");
    if (packageDigest !== lock.packageDigest) {
      throw new Error("Embedded Apps archive does not match its release lock.");
    }
    verified = await input.runtime.packages.ingestRegistryArchive({
      packageBytes: archive,
      expectedArchiveDigest: lock.packageDigest,
    });
    lockedVersion = lock.version;
  } else {
    verified = await input.runtime.packages.ingestDirectory({
      sourcePath: input.source.sourcePath,
      source: "registry",
    });
  }

  if (
    verified.manifest.id !== REQUIRED_APPS_APP_ID ||
    verified.manifest.slug !== REQUIRED_APPS_SLUG
  ) {
    throw new Error(`Embedded Apps package must use ${REQUIRED_APPS_APP_ID} and slug apps.`);
  }
  if (lockedVersion !== null && verified.manifest.version !== lockedVersion) {
    throw new Error("Embedded Apps manifest version does not match its release lock.");
  }
  if (
    !satisfies(input.hostVersion, verified.manifest.compatibility.penkra, {
      includePrerelease: true,
    })
  ) {
    throw new Error(
      `Embedded Apps ${verified.manifest.version} is not compatible with Penkra ${input.hostVersion}.`,
    );
  }
  return { ...verified, source: "registry" };
}

export async function reconcileRequiredAppsForSpaces(input: {
  runtime: Pick<DesktopAppRuntime, "installations">;
  requiredPackage: VerifiedAppPackageInput & { source: "registry" };
  hostVersion: string;
  spaceIds: ReadonlyArray<string>;
  allowDevelopmentSideload?: boolean;
  developmentSourcePackage?: boolean;
}): Promise<ReadonlyArray<RequiredAppsReconciliationResult>> {
  const results: RequiredAppsReconciliationResult[] = [];
  for (const spaceId of new Set(input.spaceIds)) {
    const current = input.runtime.installations.snapshot();
    const existing = getInstalledAppPackage(current, REQUIRED_APPS_APP_ID, spaceId);
    if (!existing) {
      await input.runtime.installations.installForSpace({
        package: input.requiredPackage,
        spaceId,
        permissions: requiredPermissionGrants(input.requiredPackage, {}),
      });
      results.push({ spaceId, status: "installed" });
      continue;
    }

    if (existing.source === "sideload") {
      if (!input.allowDevelopmentSideload) {
        throw new Error("Required Apps is unexpectedly installed from a development sideload.");
      }
      await ensureRequiredAppEnabled(input.runtime.installations, spaceId);
      results.push({ spaceId, status: "development-sideload" });
      continue;
    }

    // A source checkout is a bootstrap fallback, not an implicit sideload/update channel.
    // Replacing an active App while the shell is restoring its tabs races renderer startup.
    // Contributors apply source changes through the explicit runtime-safe sideload workflow.
    if (input.developmentSourcePackage) {
      await ensureRequiredAppEnabled(input.runtime.installations, spaceId);
      results.push({ spaceId, status: "development-existing" });
      continue;
    }

    const versionOrder = compare(existing.version, input.requiredPackage.manifest.version);
    if (versionOrder === 0) {
      if (existing.sha256 !== input.requiredPackage.sha256) {
        throw new Error(
          `Required Apps ${existing.version} has different bytes than the embedded release.`,
        );
      }
      await ensureRequiredAppEnabled(input.runtime.installations, spaceId);
      results.push({ spaceId, status: "current" });
      continue;
    }

    if (
      versionOrder > 0 &&
      satisfies(input.hostVersion, existing.manifest.compatibility.penkra, {
        includePrerelease: true,
      })
    ) {
      await ensureRequiredAppEnabled(input.runtime.installations, spaceId);
      results.push({ spaceId, status: "newer" });
      continue;
    }

    const previousPermissions =
      current.spaceStateByKey[`${spaceId}\u0000${REQUIRED_APPS_APP_ID}`]?.permissions ?? {};
    await input.runtime.installations.updateForSpace({
      package: input.requiredPackage,
      spaceId,
      permissions: requiredPermissionGrants(input.requiredPackage, previousPermissions),
    });
    await ensureRequiredAppEnabled(input.runtime.installations, spaceId);
    results.push({ spaceId, status: "updated" });
  }
  return results;
}

function resolveBundleCandidate(candidate: string): RequiredAppsBundleSource | null {
  const stat = statSafe(candidate);
  if (stat?.isFile() && candidate.endsWith(".penkra")) {
    const lockPath = Path.join(Path.dirname(candidate), REQUIRED_APPS_LOCK_FILE_NAME);
    return FS.existsSync(lockPath) ? { kind: "archive", archivePath: candidate, lockPath } : null;
  }
  if (!stat?.isDirectory()) return null;
  const archivePath = Path.join(candidate, REQUIRED_APPS_ARCHIVE_FILE_NAME);
  const lockPath = Path.join(candidate, REQUIRED_APPS_LOCK_FILE_NAME);
  if (FS.existsSync(archivePath) && FS.existsSync(lockPath)) {
    return { kind: "archive", archivePath, lockPath };
  }
  return FS.existsSync(Path.join(candidate, "penkra-app.json"))
    ? { kind: "directory", sourcePath: candidate }
    : null;
}

async function readReleaseLock(path: string): Promise<RequiredAppsReleaseLock> {
  const bytes = await readBoundedFile(path, REQUIRED_APPS_LOCK_MAX_BYTES, "Required Apps lock");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `Required Apps release lock is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseRequiredAppsReleaseLock(value);
}

async function readBoundedFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const handle = await FS.promises.open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > maximumBytes) {
      throw new Error(`${label} is missing, empty, or too large.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function requiredPermissionGrants(
  requiredPackage: VerifiedAppPackageInput,
  previous: Readonly<Record<string, AppPermissionGrant>>,
): Record<string, AppPermissionGrant> {
  return Object.fromEntries(
    (requiredPackage.manifest.permissions ?? []).map((permission) => [
      permission.name,
      permission.required ? "granted" : (previous[permission.name] ?? "denied"),
    ]),
  );
}

async function ensureRequiredAppEnabled(
  installations: Pick<DesktopAppRuntime["installations"], "snapshot" | "setEnabled">,
  spaceId: string,
): Promise<void> {
  const state = installations.snapshot().spaceStateByKey[`${spaceId}\u0000${REQUIRED_APPS_APP_ID}`];
  if (state?.enabled !== true) {
    await installations.setEnabled({ appId: REQUIRED_APPS_APP_ID, spaceId, enabled: true });
  }
}

function statSafe(path: string): FS.Stats | null {
  try {
    return FS.statSync(path);
  } catch {
    return null;
  }
}
