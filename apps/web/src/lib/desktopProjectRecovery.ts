// FILE: desktopProjectRecovery.ts
// Purpose: Detects desktop startup snapshots that can hide folders while thread rows still exist.
// Exports: snapshot shape guard used by the desktop bootstrap repair path.

import type { OrchestrationReadModel, OrchestrationShellSnapshot } from "@penkra/contracts";

type ProjectRecoverySnapshot = OrchestrationReadModel | OrchestrationShellSnapshot;

export function hasLiveThreadsWithMissingFolders(snapshot: ProjectRecoverySnapshot): boolean {
  const liveFolderIds = new Set(
    snapshot.folders
      .filter((project) => !("deletedAt" in project) || project.deletedAt === null)
      .map((project) => project.id),
  );

  return snapshot.threads.some((thread) => {
    const isLiveThread = !("deletedAt" in thread) || thread.deletedAt === null;
    return isLiveThread && !liveFolderIds.has(thread.folderId);
  });
}
