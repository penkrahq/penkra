// FILE: requiredAppsRelease.ts
// Purpose: Defines the release-time identity and lock contract for Penkra's required Apps package.
// Layer: Shared desktop/runtime and release-build contract

export const REQUIRED_APPS_APP_ID = "com.penkra.apps";
export const REQUIRED_APPS_SLUG = "apps";
export const REQUIRED_APPS_BUNDLE_DIRECTORY = "required-apps";
export const REQUIRED_APPS_ARCHIVE_FILE_NAME = "apps.penkra";
export const REQUIRED_APPS_LOCK_FILE_NAME = "apps.lock.json";
export const REQUIRED_APPS_SOURCE_PATH_ENV = "PENKRA_REQUIRED_APPS_SOURCE_PATH";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export interface RequiredAppsReleaseLock {
  schemaVersion: 1;
  appId: typeof REQUIRED_APPS_APP_ID;
  slug: typeof REQUIRED_APPS_SLUG;
  version: string;
  packageDigest: string;
  sourceRepository: "penkrahq/penkra-apps";
  sourceCommit: string;
}

export function parseRequiredAppsReleaseLock(value: unknown): RequiredAppsReleaseLock {
  if (!isRecord(value)) throw new Error("Required Apps release lock must be an object.");
  if (
    value.schemaVersion !== 1 ||
    value.appId !== REQUIRED_APPS_APP_ID ||
    value.slug !== REQUIRED_APPS_SLUG ||
    typeof value.version !== "string" ||
    value.version.trim().length === 0 ||
    typeof value.packageDigest !== "string" ||
    !SHA256.test(value.packageDigest) ||
    value.sourceRepository !== "penkrahq/penkra-apps" ||
    typeof value.sourceCommit !== "string" ||
    !COMMIT.test(value.sourceCommit)
  ) {
    throw new Error("Required Apps release lock is invalid.");
  }
  return value as unknown as RequiredAppsReleaseLock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
