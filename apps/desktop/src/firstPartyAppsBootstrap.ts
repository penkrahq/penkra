// FILE: firstPartyAppsBootstrap.ts
// Purpose: Resolves and installs the bundled first-party Apps package through normal ingestion.
// Layer: Desktop App bootstrap

import * as FS from "node:fs";
import * as Path from "node:path";

import type { DesktopAppRuntime } from "./desktopAppRuntime";

export const FIRST_PARTY_APPS_ID = "com.penkra.apps";
export const PENKRA_APPS_PACKAGE_PATH_ENV = "PENKRA_APPS_PACKAGE_PATH";

export function resolveFirstPartyAppsPackagePath(input: {
  configuredPath?: string;
  resourcesPath: string;
  desktopBundleDirectory: string;
  packaged: boolean;
}): string | null {
  const configured = input.configuredPath?.trim();
  const candidates = [
    ...(configured ? [Path.resolve(configured)] : []),
    ...(input.packaged ? [Path.join(input.resourcesPath, "penkra-apps", "apps")] : []),
    Path.resolve(input.desktopBundleDirectory, "../../../..", "penkra-apps", "apps"),
  ];
  return (
    candidates.find((candidate) => FS.existsSync(Path.join(candidate, "penkra-app.json"))) ?? null
  );
}

export async function bootstrapFirstPartyAppsPackage(
  runtime: Pick<DesktopAppRuntime, "packages" | "installations">,
  sourcePath: string,
): Promise<"installed" | "current" | "updated"> {
  const verified = await runtime.packages.ingestDirectory({
    sourcePath,
    source: "registry",
  });
  if (verified.manifest.id !== FIRST_PARTY_APPS_ID) {
    throw new Error(`Bundled Apps package must use ${FIRST_PARTY_APPS_ID}.`);
  }
  const existing = runtime.installations.snapshot().packagesByAppId[FIRST_PARTY_APPS_ID];
  if (!existing) {
    await runtime.installations.install(verified);
    return "installed";
  }
  if (existing.sha256 === verified.sha256) return "current";
  await runtime.installations.update({ ...verified, source: "registry" });
  return "updated";
}
