import { FolderId, ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveSingleFolderId,
  resolveSplitPaneCloseDecision,
  resolveSplitPaneMaximizeDecision,
  resolveThreadPickerTitle,
  resolveThreadWorkingDirectory,
} from "./-chatThreadRoute.logic";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("Thread route logic", () => {
  it("resolves the Thread's effective working directory", () => {
    expect(
      resolveThreadWorkingDirectory({
        projectCwd: "/project",
        threadWorkingDirectory: "/worktree",
      }),
    ).toBe("/worktree");
    expect(
      resolveThreadWorkingDirectory({
        projectCwd: "/project",
        threadWorkingDirectory: "/chosen",
      }),
    ).toBe("/chosen");
  });

  it("uses draft project identity only when the server Thread has none", () => {
    const server = FolderId.makeUnsafe("server-project");
    const draft = FolderId.makeUnsafe("draft-project");
    expect(resolveSingleFolderId({ threadFolderId: server, draftFolderId: draft })).toBe(server);
    expect(resolveSingleFolderId({ threadFolderId: null, draftFolderId: draft })).toBe(draft);
  });

  it("normalizes empty Thread picker titles", () => {
    expect(resolveThreadPickerTitle(null)).toBe("New chat");
    expect(resolveThreadPickerTitle("Design review")).toBe("Design review");
  });

  it("maximizes the focused split Thread", () => {
    expect(
      resolveSplitPaneMaximizeDecision({ splitViewId: "split-1", focusedThreadId: THREAD_B }),
    ).toEqual({ splitViewIdToRemove: "split-1", threadId: THREAD_B });
    expect(
      resolveSplitPaneMaximizeDecision({ splitViewId: "split-1", focusedThreadId: null }),
    ).toBeNull();
  });

  it("closes a secondary Thread back to the source Thread", () => {
    expect(
      resolveSplitPaneCloseDecision({
        splitViewId: "split-1",
        sourceThreadId: THREAD_A,
        closingThreadId: THREAD_B,
        nextFocusedThreadId: THREAD_A,
        nextLeafCount: 1,
      }),
    ).toEqual({ kind: "single-thread", threadId: THREAD_A, splitViewIdToRemove: "split-1" });
  });
});
