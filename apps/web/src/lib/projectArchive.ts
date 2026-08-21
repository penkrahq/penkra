// FILE: projectArchive.ts
// Purpose: Archives/restores virtual folders without mutating their threads.

import type { ContainerId, NativeApi } from "@penkra/contracts";

import { dispatchShellCommand } from "~/lib/shellMutation";
import { newCommandId } from "~/lib/utils";

export async function archiveProject(api: NativeApi, projectId: ContainerId): Promise<void> {
  await dispatchShellCommand(api, {
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId,
    archivedAt: new Date().toISOString(),
  });
}

export async function restoreProject(api: NativeApi, projectId: ContainerId): Promise<void> {
  await dispatchShellCommand(api, {
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId,
    archivedAt: null,
  });
}
