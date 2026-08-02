// FILE: developmentAppSideload.ts
// Purpose: Loads one explicit unpacked App into development through normal trusted ingestion.
// Layer: Desktop development bootstrap

import * as Path from "node:path";

import type { DesktopAppRuntime } from "./desktopAppRuntime";

export const PENKRA_SIDELOAD_APP_PATH_ENV = "PENKRA_SIDELOAD_APP_PATH";

export async function bootstrapDevelopmentSideload(
  runtime: Pick<DesktopAppRuntime, "packages" | "installations">,
  sourcePath: string,
): Promise<"installed" | "current" | "updated"> {
  const verified = await runtime.packages.ingestDirectory({
    sourcePath: Path.resolve(sourcePath),
    source: "sideload",
  });
  const existing = runtime.installations.snapshot().packagesByAppId[verified.manifest.id];
  if (!existing) {
    await runtime.installations.install(verified);
    return "installed";
  }
  if (existing.source !== "sideload") {
    throw new Error(
      `${verified.manifest.id} is already installed from the registry; remove it before sideloading.`,
    );
  }
  if (existing.sha256 === verified.sha256) return "current";
  await runtime.installations.updateSideloadForSpaces({
    package: { ...verified, source: "sideload" },
  });
  return "updated";
}
