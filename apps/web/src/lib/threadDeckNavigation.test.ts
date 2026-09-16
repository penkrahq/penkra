import { ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  canCreateAnotherDeckThread,
  findNearestVisibleDeckThread,
  removeDeckThreadPreservingNavigation,
} from "./threadDeckNavigation";

const ids = ["first", "archived", "active", "next", "last"].map((id) => ThreadId.makeUnsafe(id));

describe("findNearestVisibleDeckThread", () => {
  it("prefers the nearest visible thread on the right, then the left", () => {
    expect(
      findNearestVisibleDeckThread({
        threadIds: ids,
        removedThreadId: ids[2]!,
        isVisible: (threadId) => threadId !== ids[1],
      }),
    ).toBe(ids[3]);

    expect(
      findNearestVisibleDeckThread({
        threadIds: ids,
        removedThreadId: ids[4]!,
        isVisible: (threadId) => threadId !== ids[1],
      }),
    ).toBe(ids[3]);
  });

  it("skips archived members and returns null for a missing or empty deck", () => {
    expect(
      findNearestVisibleDeckThread({
        threadIds: ids,
        removedThreadId: ids[2]!,
        isVisible: () => false,
      }),
    ).toBeNull();
    expect(
      findNearestVisibleDeckThread({
        threadIds: ids,
        removedThreadId: ThreadId.makeUnsafe("missing"),
        isVisible: () => true,
      }),
    ).toBeNull();
  });
});

describe("canCreateAnotherDeckThread", () => {
  it("allows creation only when every existing member has a turn", () => {
    expect(canCreateAnotherDeckThread([{ hasTurn: true }, { hasTurn: true }])).toBe(true);
    expect(canCreateAnotherDeckThread([{ hasTurn: true }, { hasTurn: false }])).toBe(false);
  });
});

describe("removeDeckThreadPreservingNavigation", () => {
  it("activates the nearest sibling before removing the active member", async () => {
    const operations: string[] = [];

    await removeDeckThreadPreservingNavigation({
      threadIds: ids,
      removedThreadId: ids[2]!,
      activeThreadId: ids[2]!,
      isVisible: (threadId) => threadId !== ids[1],
      activate: async (threadId) => {
        operations.push(`activate:${threadId ?? "none"}`);
      },
      remove: async (threadId) => {
        operations.push(`remove:${threadId}`);
      },
    });

    expect(operations).toEqual([`activate:${ids[3]}`, `remove:${ids[2]}`]);
  });

  it("removes an inactive member without changing the active route", async () => {
    const operations: string[] = [];

    await removeDeckThreadPreservingNavigation({
      threadIds: ids,
      removedThreadId: ids[4]!,
      activeThreadId: ids[2]!,
      isVisible: () => true,
      activate: async (threadId) => {
        operations.push(`activate:${threadId ?? "none"}`);
      },
      remove: async (threadId) => {
        operations.push(`remove:${threadId}`);
      },
    });

    expect(operations).toEqual([`remove:${ids[4]}`]);
  });
});
