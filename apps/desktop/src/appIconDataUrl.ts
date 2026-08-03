// FILE: appIconDataUrl.ts
// Purpose: Reads a small verified App icon for trusted-shell loading UI.
// Layer: Desktop App package adapter

import * as FS from "node:fs";

import type { InstalledAppPackage } from "./appInstallationState";
import { createAppDocumentUrl, resolveAppPackagePath } from "./appRuntimePolicy";

export const APP_ICON_MAX_BYTES = 256 * 1024;

const SUPPORTED_ICON_TYPES = new Set(["image/jpeg", "image/png", "image/svg+xml", "image/webp"]);

export async function resolveInstalledAppIconDataUrl(
  app: InstalledAppPackage,
): Promise<string | null> {
  for (const icon of app.manifest.icons) {
    const contentType = icon.type.toLowerCase();
    if (!SUPPORTED_ICON_TYPES.has(contentType)) continue;
    try {
      const iconPath = resolveAppPackagePath(
        app.packagePath,
        app.appId,
        createAppDocumentUrl(app.appId, icon.src),
      );
      const bytes = await FS.promises.readFile(iconPath);
      if (bytes.byteLength === 0 || bytes.byteLength > APP_ICON_MAX_BYTES) continue;
      return `data:${contentType};base64,${bytes.toString("base64")}`;
    } catch {
      // A later manifest icon may still be usable. Package validation normally
      // guarantees these files, but loading UI must never block App startup.
    }
  }
  return null;
}
