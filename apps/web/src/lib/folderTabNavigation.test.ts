import { ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  findNearestVisibleFolderThread,
  removeFolderThreadPreservingNavigation,
} from "./folderTabNavigation";

const ids = ["first", "archived", "active", "next", "last"].map((id) => ThreadId.make(id));

describe("findNearestVisibleFolderThread", () => {
  it("prefers the nearest visible thread on the right, then the left", () => {
    expect(
      findNearestVisibleFolderThread({
        threadIds: ids,
        removedThreadId: ids[2]!,
        isVisible: (threadId) => threadId !== ids[1],
      }),
    ).toBe(ids[3]);

    expect(
      findNearestVisibleFolderThread({
        threadIds: ids,
        removedThreadId: ids[4]!,
        isVisible: (threadId) => threadId !== ids[1],
      }),
    ).toBe(ids[3]);
  });

  it("skips archived members and returns null for a missing or empty folder", () => {
    expect(
      findNearestVisibleFolderThread({
        threadIds: ids,
        removedThreadId: ids[2]!,
        isVisible: () => false,
      }),
    ).toBeNull();
    expect(
      findNearestVisibleFolderThread({
        threadIds: ids,
        removedThreadId: ThreadId.make("missing"),
        isVisible: () => true,
      }),
    ).toBeNull();
  });
});

describe("removeFolderThreadPreservingNavigation", () => {
  it("activates the nearest sibling before removing the active member", async () => {
    const operations: string[] = [];

    await removeFolderThreadPreservingNavigation({
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

    await removeFolderThreadPreservingNavigation({
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

  it("restores the active thread when archive is rejected after navigation", async () => {
    const operations: string[] = [];
    const rejection = new Error("This thread is still running. Stop it before archiving.");

    await expect(
      removeFolderThreadPreservingNavigation({
        threadIds: ids,
        removedThreadId: ids[2]!,
        activeThreadId: ids[2]!,
        isVisible: () => true,
        activate: async (threadId) => {
          operations.push(`activate:${threadId ?? "none"}`);
        },
        remove: async () => {
          operations.push("archive:rejected");
          throw rejection;
        },
      }),
    ).rejects.toBe(rejection);
    expect(operations).toEqual([`activate:${ids[3]}`, "archive:rejected", `activate:${ids[2]}`]);
  });
});
