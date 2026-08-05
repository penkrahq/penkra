// FILE: sidebarOrdering.ts
// Purpose: Dispatches atomic sidebar ownership and manual-order changes.

import type { NativeApi, SidebarItemParent, SidebarItemReference } from "@penkra/contracts";

import { newCommandId } from "~/lib/utils";

export async function moveSidebarItem(input: {
  api: NativeApi;
  item: SidebarItemReference;
  target: SidebarItemParent;
  orderedItems: ReadonlyArray<SidebarItemReference>;
}): Promise<void> {
  await input.api.orchestration.dispatchCommand({
    type: "sidebar.item.move",
    commandId: newCommandId(),
    item: input.item,
    target: input.target,
    orderedItems: [...input.orderedItems],
  });
}
