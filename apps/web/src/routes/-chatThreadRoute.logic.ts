// FILE: chatThreadRoute.logic.ts
// Purpose: Keep Thread route state transitions and workspace resolution deterministic.
// Layer: Route UI logic helpers.
// Exports: Thread title fallback and working-directory resolution.

import type { FolderId } from "@penkra/contracts";
import { resolveThreadWorkspaceCwd } from "@penkra/shared/threadEnvironment";

export function resolveThreadPickerTitle(title: string | null): string {
  return title || "New chat";
}

export function resolveThreadWorkingDirectory(input: {
  projectCwd?: string | null | undefined;
  threadWorkingDirectory?: string | null | undefined;
}): string | null {
  return resolveThreadWorkspaceCwd({
    projectCwd: input.projectCwd,
    workingDirectory: input.threadWorkingDirectory,
  });
}

export function resolveSingleFolderId(input: {
  threadFolderId: FolderId | null;
  draftFolderId: FolderId | null;
}): FolderId | null {
  return input.threadFolderId ?? input.draftFolderId ?? null;
}
