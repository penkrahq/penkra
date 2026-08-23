// FILE: projectArchive.ts
// Purpose: Archives/restores virtual folders without mutating their threads.

import type { FolderId, NativeApi } from "@penkra/contracts";

import { dispatchShellCommand } from "~/lib/shellMutation";
import { newCommandId } from "~/lib/utils";

export async function archiveProject(api: NativeApi, folderId: FolderId): Promise<void> {
  await dispatchShellCommand(api, {
    type: "folder.update",
    commandId: newCommandId(),
    folderId,
    archivedAt: new Date().toISOString(),
  });
}

export async function restoreProject(api: NativeApi, folderId: FolderId): Promise<void> {
  await dispatchShellCommand(api, {
    type: "folder.update",
    commandId: newCommandId(),
    folderId,
    archivedAt: null,
  });
}
