// FILE: registryAppInstaller.ts
// Purpose: Orchestrates verified registry download, package ingestion, grants, and activation.
// Layer: Trusted Electron main process

import { satisfies } from "semver";

import type { AppInstallationService } from "./appInstallationService";
import type { AppInstallationState, AppPermissionGrant } from "./appInstallationState";
import type { AppPackageIngestor } from "./appPackageIngestor";
import type { AppRegistryClient } from "./appRegistryClient";

export async function installRegistryApp(input: {
  request: {
    slug: string;
    version: string;
    spaceId: string;
    permissions: Readonly<Record<string, AppPermissionGrant>>;
  };
  hostVersion: string;
  registry: Pick<AppRegistryClient, "get" | "downloadVerifiedRelease" | "recordSuccessfulInstall">;
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
  const verified = await input.registry.downloadVerifiedRelease({ app, version });
  const installedPackage = await input.packages.ingestRegistryArchive({
    packageBytes: verified.packageBytes,
    expectedArchiveDigest: verified.release.packageDigest,
  });
  if (
    installedPackage.manifest.id !== app.identifier ||
    installedPackage.manifest.slug !== app.slug ||
    installedPackage.manifest.version !== version.version ||
    installedPackage.manifest.compatibility.penkra !== version.compatibilityRange ||
    !manifestPermissionsMatch(installedPackage.manifest.permissions ?? [], version.permissions)
  ) {
    throw new Error("Verified App package metadata does not match the selected registry release.");
  }
  const state = await input.installations.installForSpace({
    package: {
      ...installedPackage,
      source: "registry",
      registryRelease: {
        appId: app.id,
        versionId: version.id,
        packageDigest: verified.release.packageDigest,
        keyId: verified.release.keyId,
        publishedAt: verified.release.publishedAt,
      },
    },
    spaceId: input.request.spaceId,
    permissions: grants,
  });
  try {
    await input.registry.recordSuccessfulInstall({ appId: app.id, versionId: version.id });
  } catch (error) {
    console.warn("[penkra-app] Installed App receipt could not be recorded.", error);
  }
  return state;
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
