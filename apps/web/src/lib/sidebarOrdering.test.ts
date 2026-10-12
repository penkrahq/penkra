// FILE: sidebarOrdering.test.ts
// Purpose: Covers stable anchor intent and list-start insertion.

import type { NativeApi, SidebarItemReference } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  moveSidebarItem,
  resolveSidebarInsertionIndex,
  resolveSidebarMovePosition,
} from "./sidebarOrdering";

const project = (id: string): SidebarItemReference => ({ kind: "folder", id: id as never });

describe("resolveSidebarMovePosition", () => {
  const destinationItems = [project("one"), project("two")];
  it("uses the same insertion index for live feedback and stable edge anchors", () => {
    for (const [requestedIndex, index, position] of [
      [-1, 0, { type: "before", item: project("one") }],
      [99, 2, { type: "after", item: project("two") }],
    ] as const) {
      const input = { item: project("moved"), destinationItems, requestedIndex };
      expect(resolveSidebarInsertionIndex(input)).toBe(index);
      expect(resolveSidebarMovePosition(input)).toEqual(position);
    }
    expect(
      resolveSidebarMovePosition({
        item: project("moved"),
        destinationItems: [],
        requestedIndex: 0,
      }),
    ).toEqual({ type: "start" });
  });

  it("anchors valid moves to a stable neighboring item", () => {
    expect(
      resolveSidebarMovePosition({
        item: project("moved"),
        destinationItems,
        requestedIndex: 1,
      }),
    ).toEqual({ type: "before", item: project("two") });
  });

  it("anchors the first position of the list", () => {
    const items = [project("one"), project("two")];
    expect(
      resolveSidebarMovePosition({
        item: project("moved"),
        destinationItems: items,
        requestedIndex: 0,
      }),
    ).toEqual({ type: "before", item: project("one") });
  });
});

it("writes each sidebar action through its clean-core input", async () => {
  const updateThread = vi.fn().mockResolvedValue(undefined);
  const updateNavigation = vi.fn().mockResolvedValue(undefined);
  const api = { cleanCore: { updateThread, updateNavigation } } as unknown as NativeApi;
  await moveSidebarItem({
    api,
    item: { kind: "folder", id: "folder" as never },
    target: { kind: "space", spaceId: "space" as never },
    position: { type: "start" },
  });
  expect(updateNavigation).toHaveBeenLastCalledWith({
    update: {
      action: "folder.move",
      folderId: "folder",
      spaceId: "space",
      position: { type: "start" },
    },
  });
  await moveSidebarItem({
    api,
    item: { kind: "thread", id: "thread" as never },
    target: { kind: "folder", folderId: "folder" as never },
    position: { type: "before", item: { kind: "thread", id: "anchor" as never } },
  });
  expect(updateThread).toHaveBeenLastCalledWith({
    update: {
      action: "moveSidebarItem",
      threadId: "thread",
      folderId: "folder",
      position: { type: "before", itemId: "anchor" },
      updatedAt: expect.any(String),
    },
  });
});
