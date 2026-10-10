// FILE: sidebarOrdering.test.ts
// Purpose: Covers stable anchor intent and the pinned sidebar boundary.

import type { NativeApi, SidebarItemReference } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  moveSidebarItem,
  resolveSidebarInsertionIndex,
  resolveSidebarMovePosition,
} from "./sidebarOrdering";

const project = (id: string): SidebarItemReference => ({ kind: "folder", id: id as never });

describe("resolveSidebarMovePosition", () => {
  const pinnedIds = new Set(["pin-a", "pin-b"]);
  const isPinned = (item: SidebarItemReference) => pinnedIds.has(item.id);
  const destinationItems = [project("pin-a"), project("pin-b"), project("one"), project("two")];

  it("clamps an unpinned drop above pins to the pinned boundary", () => {
    expect(
      resolveSidebarMovePosition({
        item: project("moved"),
        destinationItems,
        requestedIndex: 0,
        isPinned,
      }),
    ).toEqual({ type: "pinned-boundary" });
  });

  it("anchors valid moves to a stable neighboring item", () => {
    expect(
      resolveSidebarMovePosition({
        item: project("moved"),
        destinationItems,
        requestedIndex: 3,
        isPinned,
      }),
    ).toEqual({ type: "before", item: project("two") });
  });

  it("anchors the first position when the list has no pinned items", () => {
    const unpinnedItems = [project("one"), project("two")];
    expect(
      resolveSidebarMovePosition({
        item: project("moved"),
        destinationItems: unpinnedItems,
        requestedIndex: 0,
        isPinned: () => false,
      }),
    ).toEqual({ type: "before", item: project("one") });
  });

  it("exposes the same pin-clamped insertion index for live drag feedback", () => {
    expect(
      resolveSidebarInsertionIndex({
        item: project("moved"),
        destinationItems,
        requestedIndex: 0,
        isPinned,
      }),
    ).toBe(2);
    expect(
      resolveSidebarInsertionIndex({
        item: project("moved"),
        destinationItems: [project("one"), project("two")],
        requestedIndex: 0,
        isPinned: () => false,
      }),
    ).toBe(0);
  });

  it("keeps pinned moves inside the pinned block", () => {
    expect(
      resolveSidebarMovePosition({
        item: project("pin-moved"),
        destinationItems,
        requestedIndex: 99,
        isPinned: (item) => item.id.startsWith("pin-"),
      }),
    ).toEqual({ type: "pinned-boundary" });
  });
});

it("writes each sidebar action through its clean-core input", async () => {
  const updateThread = vi.fn().mockResolvedValue(undefined);
  const api = { cleanCore: { updateThread } } as unknown as NativeApi;
  await moveSidebarItem({
    api,
    item: { kind: "folder", id: "folder" as never },
    target: { kind: "space", spaceId: "space" as never },
    position: { type: "pinned-boundary" },
  });
  expect(updateThread).toHaveBeenLastCalledWith({
    update: {
      action: "moveFolder",
      folderId: "folder",
      spaceId: "space",
      position: { type: "pinned-boundary" },
      updatedAt: expect.any(String),
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
