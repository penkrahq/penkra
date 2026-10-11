// FILE: chatThreadRoute.logic.ts
// Purpose: Keep Thread route state transitions and workspace resolution deterministic.
// Layer: Route UI logic helpers.
// Exports: Thread title, folder identity, and archive navigation helpers.

import type { FolderId } from "@penkra/contracts";

export function resolveThreadPickerTitle(title: string | null): string {
  return title || "New chat";
}

export function resolveSingleFolderId(input: {
  threadFolderId: FolderId | null;
  draftFolderId: FolderId | null;
}): FolderId | null {
  return input.threadFolderId ?? input.draftFolderId ?? null;
}
export function shouldRedirectArchivedThreadRoute(input: {
  archived: boolean;
  localArchiveNavigationPending: boolean;
}): boolean {
  return input.archived && !input.localArchiveNavigationPending;
}
