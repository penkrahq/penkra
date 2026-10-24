import { describe, expect, it } from "vitest";
import { FolderId, ThreadId } from "@penkra/contracts";
import { resolveChatIndexRestoreRoute } from "./routes/-chatIndexRoute.logic";

import { resolveRestorableThreadRoute } from "./chatRouteRestore";

describe("resolveRestorableThreadRoute", () => {
  it("does not reopen an archived remembered thread on launch", () => {
    const threadId = ThreadId.make("thread-archived");
    const folderId = FolderId.make("folder-1");
    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId },
        threadIds: [threadId],
        sidebarThreadSummaryById: {
          [threadId]: { folderId, archivedAt: "2026-09-26T00:00:00.000Z" },
        },
        draftFolderIdByThreadId: new Map(),
        landingSpace: null,
      }),
    ).toBeNull();
  });
  it("returns the last thread route when the thread still exists", () => {
    expect(
      resolveRestorableThreadRoute({
        lastThreadRoute: {
          threadId: "thread-123",
        },
        availableThreadIds: new Set(["thread-123", "thread-789"]),
      }),
    ).toEqual({
      threadId: "thread-123",
    });
  });

  it("returns null when the remembered thread no longer exists", () => {
    expect(
      resolveRestorableThreadRoute({
        lastThreadRoute: {
          threadId: "thread-123",
        },
        availableThreadIds: new Set(["thread-789"]),
      }),
    ).toBeNull();
  });
});
