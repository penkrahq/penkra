// FILE: projectArchive.ts
// Purpose: Archives/restores virtual folders without mutating their threads.

import type { FolderId, NativeApi } from "@penkra/contracts";

export async function archiveProject(api: NativeApi, folderId: FolderId): Promise<void> {
  await api.cleanCore.updateNavigation({
    update: {
      action: "folder.update",
      folderId,
      archivedAt: new Date().toISOString(),
    },
  });
}

export async function restoreProject(api: NativeApi, folderId: FolderId): Promise<void> {
  await api.cleanCore.updateNavigation({
    update: {
      action: "folder.update",
      folderId,
      archivedAt: null,
    },
  });
}
