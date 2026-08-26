// FILE: appBrowserDownload.ts
// Purpose: Defines the App-owned destination contract for hosted Browser downloads.
// Layer: Trusted desktop App capability boundary

import * as Path from "node:path";

import type { AppStorageOwner, AppStorageService } from "./appStorage";

export interface AppBrowserDownloadDestination {
  /** Absolute host path for Electron and an App's Node operation controller. */
  path: string;
  /** App-storage key for the owning visual tab. */
  storagePath: string;
}

export function prepareAppBrowserDownload(
  storage: Pick<AppStorageService, "prepareDownloadSync">,
  owner: AppStorageOwner,
  suggestedName: string,
): AppBrowserDownloadDestination {
  const path = storage.prepareDownloadSync(owner, {
    directory: "downloads",
    suggestedName,
  });
  return {
    path,
    storagePath: Path.posix.join("downloads", Path.basename(path)),
  };
}
