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
}): number {
  return Math.max(0, Math.min(input.requestedIndex, input.destinationItems.length));
}

export function resolveSidebarMovePosition(input: {
  item: SidebarItemReference;
  destinationItems: ReadonlyArray<SidebarItemReference>;
  requestedIndex: number;
}): SidebarItemMovePosition {
  const insertionIndex = resolveSidebarInsertionIndex(input);
  const nextItem = input.destinationItems[insertionIndex];
  if (nextItem) return { type: "before", item: nextItem };
  const previousItem = input.destinationItems[insertionIndex - 1];
  if (previousItem) return { type: "after", item: previousItem };
  return { type: "start" };
}

export async function moveSidebarItem(input: {
  api: NativeApi;
  item: SidebarItemReference;
  target: SidebarItemParent;
  position: SidebarItemMovePosition;
}): Promise<void> {
  const position =
    input.position.type === "start"
      ? { type: "start" as const }
      : { type: input.position.type, itemId: input.position.item.id };
  const updatedAt = new Date().toISOString();
  if (input.item.kind === "folder" && input.target.kind === "space") {
    await input.api.cleanCore.updateNavigation({
      update: {
        action: "folder.move",
        folderId: input.item.id,
        spaceId: input.target.spaceId,
        position,
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
