// FILE: registryAppInstaller.ts
// Purpose: Orchestrates verified registry download, package ingestion, grants, and activation.
// Layer: Trusted Electron main process

import { gt, lt, satisfies } from "semver";

import type { AppInstallationService } from "./appInstallationService";
import {
  getInstalledAppPackage,
  type AppInstallationState,
  type AppPermissionGrant,
} from "./appInstallationState";
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
  registry: Pick<
    AppRegistryClient,
    "get" | "downloadVerifiedRelease" | "getSecurityPolicy" | "recordSuccessfulInstallDurably"
  >;
  packages: Pick<AppPackageIngestor, "ingestRegistryArchive">;
  installations: Pick<AppInstallationService, "installForSpace">;
}): Promise<AppInstallationState> {
  const trace = new RegistryInstallTrace("install", input.request.slug, input.request.version);
  return trace.run(async () => {
    trace.stage("listing");
    const app = await input.registry.get({ slug: input.request.slug });
    const version = app.versions.find((candidate) => candidate.version === input.request.version);
    if (!version) throw new Error("The selected App version is no longer available.");
    if (!satisfies(input.hostVersion, version.compatibilityRange, { includePrerelease: true })) {
      throw new Error(
        `App ${app.displayName} ${version.version} is not compatible with Penkra ${input.hostVersion}.`,
      );
    }
    const grants = resolvePermissionGrants(version.permissions, input.request.permissions);
    trace.stage("download-and-policy");
    const [verified, policy] = await downloadReleaseAndPolicy(
      input.registry.downloadVerifiedRelease({ app, version }),
      input.registry.getSecurityPolicy(),
    );
    await assertDownloadedReleaseAllowed(verified, policy);
    trace.stage("ingestion");
    const installedPackage = await ingestVerifiedRelease(input.packages, verified);
    assertPackageMatchesRegistry(installedPackage, app, version);
    trace.stage("commit");
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
  });
}

export async function updateRegistryApp(input: {
  request: {
    slug: string;
    version: string;
    spaceId: string;
    permissions: Readonly<Record<string, AppPermissionGrant>>;
  };
  hostVersion: string;
  registry: Pick<AppRegistryClient, "get" | "downloadVerifiedRelease" | "getSecurityPolicy">;
  packages: Pick<AppPackageIngestor, "ingestRegistryArchive">;
  installations: Pick<AppInstallationService, "snapshot" | "updateForSpace">;
}): Promise<AppInstallationState> {
  return replaceRegistryApp(input, "update");
}

export async function rollbackRegistryApp(input: {
  request: {
    slug: string;
    version: string;
    spaceId: string;
    permissions: Readonly<Record<string, AppPermissionGrant>>;
  };
  hostVersion: string;
  registry: Pick<AppRegistryClient, "get" | "downloadVerifiedRelease" | "getSecurityPolicy">;
  packages: Pick<AppPackageIngestor, "ingestRegistryArchive">;
  installations: Pick<AppInstallationService, "snapshot" | "updateForSpace">;
}): Promise<AppInstallationState> {
  return replaceRegistryApp(input, "rollback");
}

async function replaceRegistryApp(
  input: {
    request: {
      slug: string;
      version: string;
      spaceId: string;
      permissions: Readonly<Record<string, AppPermissionGrant>>;
    };
    hostVersion: string;
    registry: Pick<AppRegistryClient, "get" | "downloadVerifiedRelease" | "getSecurityPolicy">;
    packages: Pick<AppPackageIngestor, "ingestRegistryArchive">;
    installations: Pick<AppInstallationService, "snapshot" | "updateForSpace">;
  },
  direction: "update" | "rollback",
): Promise<AppInstallationState> {
  const trace = new RegistryInstallTrace(direction, input.request.slug, input.request.version);
  return trace.run(async () => {
    trace.stage("listing");
    const app = await input.registry.get({ slug: input.request.slug });
    const version = app.versions.find((candidate) => candidate.version === input.request.version);
    if (!version) throw new Error("The selected App version is no longer available.");
    const current = getInstalledAppPackage(
      input.installations.snapshot(),
      app.identifier,
      input.request.spaceId,
    );
    if (!current || current.source !== "registry")
      throw new Error(`${app.displayName} is not installed from the registry.`);
    const correctDirection =
      direction === "update"
        ? gt(version.version, current.version)
        : lt(version.version, current.version);
    if (!correctDirection) {
      throw new Error(
        direction === "update"
          ? `App updates must move forward from ${current.version} to a newer version.`
          : `App rollback must select a version older than ${current.version}.`,
      );
    }
    if (!satisfies(input.hostVersion, version.compatibilityRange, { includePrerelease: true })) {
      throw new Error(
        `App ${app.displayName} ${version.version} is not compatible with Penkra ${input.hostVersion}.`,
      );
    }
    trace.stage("download-and-policy");
    const [verified, policy] = await downloadReleaseAndPolicy(
      input.registry.downloadVerifiedRelease({ app, version }),
      input.registry.getSecurityPolicy(),
    );
    await assertDownloadedReleaseAllowed(verified, policy);
    trace.stage("ingestion");
    const installedPackage = await ingestVerifiedRelease(input.packages, verified);
    assertPackageMatchesRegistry(installedPackage, app, version);
    trace.stage("commit");
    return input.installations.updateForSpace({
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
      permissions: input.request.permissions,
    });
  });
}

class RegistryInstallTrace {
  readonly #startedAt = Date.now();
  #stage = "starting";

  constructor(
    readonly operation: "install" | "update" | "rollback",
    readonly appSlug: string,
    readonly version: string,
  ) {}

  stage(stage: string): void {
    this.#stage = stage;
    this.#log("stage");
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.#log("started");
    try {
      const result = await operation();
      this.#stage = "completed";
      this.#log("completed");
      return result;
    } catch (error) {
      this.#log("failed", error);
      throw error;
    }
  }

  #log(event: "started" | "stage" | "completed" | "failed", error?: unknown): void {
    const details = {
      event,
      operation: this.operation,
      appSlug: this.appSlug,
      version: this.version,
      stage: this.#stage,
      elapsedMs: Date.now() - this.#startedAt,
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    };
    const method = event === "failed" ? console.warn : console.info;
    method("[penkra-app-install] Registry installation", details);
  }
}

async function assertDownloadedReleaseAllowed(
  verified: Awaited<ReturnType<AppRegistryClient["downloadVerifiedRelease"]>>,
  policy: Parameters<typeof assertRegistryReleaseAllowed>[0],
): Promise<void> {
  try {
    assertRegistryReleaseAllowed(policy, {
      appId: verified.release.appId,
      versionId: verified.release.versionId,
      publisherId: verified.release.publisher.id,
    });
  } catch (error) {
    await verified.package.dispose();
    throw error;
  }
}

async function downloadReleaseAndPolicy(
  download: ReturnType<AppRegistryClient["downloadVerifiedRelease"]>,
  policy: ReturnType<AppRegistryClient["getSecurityPolicy"]>,
): Promise<
  [
    Awaited<ReturnType<AppRegistryClient["downloadVerifiedRelease"]>>,
    Awaited<ReturnType<AppRegistryClient["getSecurityPolicy"]>>,
  ]
> {
  const [downloadResult, policyResult] = await Promise.allSettled([download, policy]);
  if (downloadResult.status === "rejected") throw downloadResult.reason;
  if (policyResult.status === "rejected") {
    await downloadResult.value.package.dispose();
    throw policyResult.reason;
  }
  return [downloadResult.value, policyResult.value];
}

async function ingestVerifiedRelease(
  packages: Pick<AppPackageIngestor, "ingestRegistryArchive">,
  verified: Awaited<ReturnType<AppRegistryClient["downloadVerifiedRelease"]>>,
): Promise<Awaited<ReturnType<AppPackageIngestor["ingestRegistryArchive"]>>> {
  try {
    return await packages.ingestRegistryArchive({
      archivePath: verified.package.archivePath,
      expectedArchiveDigest: verified.release.packageDigest,
    });
  } finally {
    await verified.package.dispose();
  }
}

function resolvePermissionGrants(
  declared: ReadonlyArray<{ permission: string; required: boolean }>,
  requested: Readonly<Record<string, AppPermissionGrant>>,
): Record<string, AppPermissionGrant> {
  const declaredNames = new Set(declared.map((permission) => permission.permission));
  for (const name of Object.keys(requested)) {
    if (!declaredNames.has(name))
      throw new Error(`App installation includes undeclared permission ${name}.`);
  }
  return Object.fromEntries(
    declared.map((permission) => {
      const grant = requested[permission.permission] ?? "denied";
      if (permission.required && grant !== "granted") {
        throw new Error(`Required App permission ${permission.permission} must be granted.`);
      }
      return [permission.permission, grant];
    }),
  );
}

function manifestPermissionsMatch(
  manifest: ReadonlyArray<{ name: string; required: boolean; reason: string; audience?: string }>,
  registry: ReadonlyArray<{
    permission: string;
    required: boolean;
    rationale: string;
    audience?: string;
  }>,
): boolean {
  const normalize = (
    values: Array<{
      permission: string;
      required: boolean;
      rationale: string;
      audience?: string;
    }>,
  ) => values.sort((left, right) => left.permission.localeCompare(right.permission));
  return (
    JSON.stringify(
      normalize(
        manifest.map((permission) => ({
          permission: permission.name,
          required: permission.required,
          rationale: permission.reason,
          ...(permission.audience ? { audience: permission.audience } : {}),
        })),
      ),
    ) === JSON.stringify(normalize([...registry]))
  );
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
