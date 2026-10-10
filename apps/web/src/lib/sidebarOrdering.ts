// FILE: sidebarOrdering.ts
// Purpose: Dispatches atomic sidebar ownership and manual-order changes.

import type {
  NativeApi,
  SidebarItemMovePosition,
  SidebarItemParent,
  SidebarItemReference,
} from "@penkra/contracts";

export function resolveSidebarInsertionIndex(input: {
  item: SidebarItemReference;
  destinationItems: ReadonlyArray<SidebarItemReference>;
  requestedIndex: number;
  isPinned: (item: SidebarItemReference) => boolean;
}): number {
  const pinned = input.isPinned(input.item);
  const pinnedCount = input.destinationItems.filter(input.isPinned).length;
  return pinned
    ? Math.max(0, Math.min(input.requestedIndex, pinnedCount))
    : Math.max(pinnedCount, Math.min(input.requestedIndex, input.destinationItems.length));
}

export function resolveSidebarMovePosition(input: {
  item: SidebarItemReference;
  destinationItems: ReadonlyArray<SidebarItemReference>;
  requestedIndex: number;
  isPinned: (item: SidebarItemReference) => boolean;
}): SidebarItemMovePosition {
  const pinned = input.isPinned(input.item);
  const pinnedCount = input.destinationItems.filter(input.isPinned).length;
  const insertionIndex = resolveSidebarInsertionIndex(input);
  const crossesPinnedBoundary = pinned
    ? input.requestedIndex >= pinnedCount
    : input.requestedIndex < pinnedCount;
  if (crossesPinnedBoundary) return { type: "pinned-boundary" };

  const nextItem = input.destinationItems[insertionIndex];
  if (nextItem && input.isPinned(nextItem) === pinned) {
    return { type: "before", item: nextItem };
  }
  const previousItem = input.destinationItems[insertionIndex - 1];
  if (previousItem && input.isPinned(previousItem) === pinned) {
    return { type: "after", item: previousItem };
  }
  return { type: "pinned-boundary" };
}

export async function moveSidebarItem(input: {
  api: NativeApi;
  item: SidebarItemReference;
  target: SidebarItemParent;
  position: SidebarItemMovePosition;
}): Promise<void> {
  const position =
    input.position.type === "pinned-boundary"
      ? { type: "pinned-boundary" as const }
      : { type: input.position.type, itemId: input.position.item.id };
  const updatedAt = new Date().toISOString();
  if (input.item.kind === "folder" && input.target.kind === "space") {
    await input.api.cleanCore.updateThread({
      update: {
        action: "moveFolder",
        folderId: input.item.id,
        spaceId: input.target.spaceId,
        position,
        updatedAt,
      },
    });
  } else if (input.item.kind === "thread" && input.target.kind === "folder") {
    await input.api.cleanCore.updateThread({
      update: {
        action: "moveSidebarItem",
        threadId: input.item.id,
        folderId: input.target.folderId,
        position,
        updatedAt,
      },
    });
  } else {
    throw new Error("Folders belong to spaces and threads belong to folders.");
  }
}
