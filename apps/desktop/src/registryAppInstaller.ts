// FILE: registryAppInstaller.ts
// Purpose: Orchestrates verified registry download, package ingestion, grants, and activation.
// Layer: Trusted Electron main process

import { gt, lt, satisfies } from "semver";

import type { AppInstallationService } from "./appInstallationService";
import type { AppInstallationState, AppPermissionGrant } from "./appInstallationState";
import type { AppPackageIngestor } from "./appPackageIngestor";
import type { AppRegistryClient } from "./appRegistryClient";
import { assertRegistryReleaseAllowed } from "./appRegistryTrust";

export async function installRegistryApp(input: {
  request: {
    slug: string;
    version: string;
    spaceId: string;
    permissions: Readonly<Record<string, AppPermissionGrant>>;
  };
  hostVersion: string;
  registry: Pick<AppRegistryClient, "get" | "downloadVerifiedRelease" | "getSecurityPolicy" | "recordSuccessfulInstallDurably">;
  packages: Pick<AppPackageIngestor, "ingestRegistryArchive">;
  installations: Pick<AppInstallationService, "installForSpace">;
}): Promise<AppInstallationState> {
  const app = await input.registry.get({ slug: input.request.slug });
  const version = app.versions.find((candidate) => candidate.version === input.request.version);
  if (!version) throw new Error("The selected App version is no longer available.");
  if (!satisfies(input.hostVersion, version.compatibilityRange, { includePrerelease: true })) {
    throw new Error(`App ${app.displayName} ${version.version} is not compatible with Penkra ${input.hostVersion}.`);
  }
  const grants = resolvePermissionGrants(version.permissions, input.request.permissions);
  const [verified, policy] = await Promise.all([
    input.registry.downloadVerifiedRelease({ app, version }),
    input.registry.getSecurityPolicy(),
  ]);
  assertRegistryReleaseAllowed(policy, {
    appId: verified.release.appId,
    versionId: verified.release.versionId,
    publisherId: verified.release.publisher.id,
  });
  const installedPackage = await input.packages.ingestRegistryArchive({
    packageBytes: verified.packageBytes,
    expectedArchiveDigest: verified.release.packageDigest,
  });
  assertPackageMatchesRegistry(installedPackage, app, version);
  const state = await input.installations.installForSpace({
    package: {
      ...installedPackage,
      source: "registry",
      registryRelease: {
        appId: app.id,
        versionId: version.id,
        publisherId: verified.release.publisher.id,
        packageDigest: verified.release.packageDigest,
        keyId: verified.release.keyId,
        publishedAt: verified.release.publishedAt,
      },
    },
    spaceId: input.request.spaceId,
    permissions: grants,
  });
  await input.registry.recordSuccessfulInstallDurably({ appId: app.id, versionId: version.id });
  return state;
}

export async function updateRegistryApp(input: {
  request: {
    slug: string;
    version: string;
    permissionsBySpace: Readonly<Record<string, Readonly<Record<string, AppPermissionGrant>>>>;
  };
  hostVersion: string;
  registry: Pick<AppRegistryClient, "get" | "downloadVerifiedRelease" | "getSecurityPolicy">;
  packages: Pick<AppPackageIngestor, "ingestRegistryArchive">;
  installations: Pick<AppInstallationService, "snapshot" | "updateForSpaces">;
}): Promise<AppInstallationState> {
  return replaceRegistryApp(input, "update");
}

export async function rollbackRegistryApp(input: {
  request: {
    slug: string;
    version: string;
    permissionsBySpace: Readonly<Record<string, Readonly<Record<string, AppPermissionGrant>>>>;
  };
  hostVersion: string;
  registry: Pick<AppRegistryClient, "get" | "downloadVerifiedRelease" | "getSecurityPolicy">;
  packages: Pick<AppPackageIngestor, "ingestRegistryArchive">;
  installations: Pick<AppInstallationService, "snapshot" | "updateForSpaces">;
}): Promise<AppInstallationState> {
  return replaceRegistryApp(input, "rollback");
}

async function replaceRegistryApp(input: {
  request: {
    slug: string;
    version: string;
    permissionsBySpace: Readonly<Record<string, Readonly<Record<string, AppPermissionGrant>>>>;
  };
  hostVersion: string;
  registry: Pick<AppRegistryClient, "get" | "downloadVerifiedRelease" | "getSecurityPolicy">;
  packages: Pick<AppPackageIngestor, "ingestRegistryArchive">;
  installations: Pick<AppInstallationService, "snapshot" | "updateForSpaces">;
}, direction: "update" | "rollback"): Promise<AppInstallationState> {
  const app = await input.registry.get({ slug: input.request.slug });
  const version = app.versions.find((candidate) => candidate.version === input.request.version);
  if (!version) throw new Error("The selected App version is no longer available.");
  const current = input.installations.snapshot().packagesByAppId[app.identifier];
  if (!current || current.source !== "registry") throw new Error(`${app.displayName} is not installed from the registry.`);
  const correctDirection = direction === "update"
    ? gt(version.version, current.version)
    : lt(version.version, current.version);
  if (!correctDirection) {
    throw new Error(direction === "update"
      ? `App updates must move forward from ${current.version} to a newer version.`
      : `App rollback must select a version older than ${current.version}.`);
  }
  if (!satisfies(input.hostVersion, version.compatibilityRange, { includePrerelease: true })) {
    throw new Error(`App ${app.displayName} ${version.version} is not compatible with Penkra ${input.hostVersion}.`);
  }
  const [verified, policy] = await Promise.all([
    input.registry.downloadVerifiedRelease({ app, version }),
    input.registry.getSecurityPolicy(),
  ]);
  assertRegistryReleaseAllowed(policy, {
    appId: verified.release.appId,
    versionId: verified.release.versionId,
    publisherId: verified.release.publisher.id,
  });
  const installedPackage = await input.packages.ingestRegistryArchive({
    packageBytes: verified.packageBytes,
    expectedArchiveDigest: verified.release.packageDigest,
  });
  assertPackageMatchesRegistry(installedPackage, app, version);
  return input.installations.updateForSpaces({
    package: {
      ...installedPackage,
      source: "registry",
      registryRelease: {
        appId: app.id,
        versionId: version.id,
        publisherId: verified.release.publisher.id,
        packageDigest: verified.release.packageDigest,
        keyId: verified.release.keyId,
        publishedAt: verified.release.publishedAt,
      },
    },
    permissionsBySpace: input.request.permissionsBySpace,
  });
}

function resolvePermissionGrants(
  declared: ReadonlyArray<{ permission: string; required: boolean }>,
  requested: Readonly<Record<string, AppPermissionGrant>>,
): Record<string, AppPermissionGrant> {
  const declaredNames = new Set(declared.map((permission) => permission.permission));
  for (const name of Object.keys(requested)) {
    if (!declaredNames.has(name)) throw new Error(`App installation includes undeclared permission ${name}.`);
  }
  return Object.fromEntries(declared.map((permission) => {
    const grant = requested[permission.permission] ?? "denied";
    if (permission.required && grant !== "granted") {
      throw new Error(`Required App permission ${permission.permission} must be granted.`);
    }
    return [permission.permission, grant];
  }));
}

function manifestPermissionsMatch(
  manifest: ReadonlyArray<{ name: string; required: boolean; reason: string }>,
  registry: ReadonlyArray<{ permission: string; required: boolean; rationale: string }>,
): boolean {
  const normalize = (values: Array<{ permission: string; required: boolean; rationale: string }>) =>
    values.sort((left, right) => left.permission.localeCompare(right.permission));
  return JSON.stringify(normalize(manifest.map((permission) => ({
    permission: permission.name,
    required: permission.required,
    rationale: permission.reason,
  })))) === JSON.stringify(normalize([...registry]));
}

function assertPackageMatchesRegistry(
  installedPackage: Awaited<ReturnType<AppPackageIngestor["ingestRegistryArchive"]>>,
  app: Awaited<ReturnType<AppRegistryClient["get"]>>,
  version: Awaited<ReturnType<AppRegistryClient["get"]>>["versions"][number],
): void {
  if (
    installedPackage.manifest.id !== app.identifier ||
    installedPackage.manifest.slug !== app.slug ||
    installedPackage.manifest.version !== version.version ||
    installedPackage.manifest.compatibility.penkra !== version.compatibilityRange ||
    !manifestPermissionsMatch(installedPackage.manifest.permissions ?? [], version.permissions)
  ) {
    throw new Error("Verified App package metadata does not match the selected registry release.");
  }
}
