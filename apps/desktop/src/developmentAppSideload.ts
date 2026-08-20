// FILE: developmentAppSideload.ts
// Purpose: Loads one explicit unpacked App into development through normal trusted ingestion.
// Layer: Desktop development runtime

import * as Path from "node:path";

import type { DesktopAppRuntime } from "./desktopAppRuntime";
import { getInstalledAppPackage } from "./appInstallationState";

export interface DevelopmentAppSideloadResult {
  appId: string;
  sourcePath: string;
  spaceId: string;
  status: "installed" | "current" | "updated";
}

export async function bootstrapDevelopmentSideload(
  runtime: Pick<DesktopAppRuntime, "packages" | "installations">,
  sourcePath: string,
  spaceId: string,
): Promise<DevelopmentAppSideloadResult> {
  const resolvedSourcePath = Path.resolve(sourcePath);
  const verified = await runtime.packages.ingestDirectory({
    sourcePath: resolvedSourcePath,
    source: "sideload",
  });
  const existing = getInstalledAppPackage(
    runtime.installations.snapshot(),
    verified.manifest.id,
    spaceId,
  );
  if (!existing) {
    await runtime.installations.install(verified, spaceId);
    await ensureDevelopmentSideloadEnabled(runtime, verified.manifest, spaceId);
    return result("installed");
  }
  if (existing.source !== "sideload") {
    await runtime.installations.updateSideloadForSpace({
      package: { ...verified, source: "sideload" },
      spaceId,
    });
    await ensureDevelopmentSideloadEnabled(runtime, verified.manifest, spaceId);
    return result("updated");
  }
  const status = existing.sha256 === verified.sha256 ? "current" : "updated";
  if (status === "updated") {
    await runtime.installations.updateSideloadForSpace({
      package: { ...verified, source: "sideload" },
      spaceId,
    });
  }
  await ensureDevelopmentSideloadEnabled(runtime, verified.manifest, spaceId);
  return result(status);

  function result(status: DevelopmentAppSideloadResult["status"]): DevelopmentAppSideloadResult {
    return { appId: verified.manifest.id, sourcePath: resolvedSourcePath, spaceId, status };
  }
}

async function ensureDevelopmentSideloadEnabled(
  runtime: Pick<DesktopAppRuntime, "installations">,
  manifest: { id: string; permissions?: ReadonlyArray<{ name: string; required: boolean }> },
  spaceId: string,
): Promise<void> {
  const key = `${spaceId}\u0000${manifest.id}`;
  for (const permission of manifest.permissions ?? []) {
    if (
      permission.required &&
      runtime.installations.snapshot().spaceStateByKey[key]?.permissions[permission.name] !==
        "granted"
    ) {
      await runtime.installations.setPermission({
        appId: manifest.id,
        spaceId,
        permission: permission.name,
        grant: "granted",
      });
    }
  }
  if (runtime.installations.snapshot().spaceStateByKey[key]?.enabled !== true) {
    await runtime.installations.setEnabled({ appId: manifest.id, spaceId, enabled: true });
  }
}
