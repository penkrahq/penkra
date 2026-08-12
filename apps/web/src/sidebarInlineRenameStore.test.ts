import { ContainerId, ThreadId } from "@penkra/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useSidebarInlineRenameStore } from "./sidebarInlineRenameStore";

describe("sidebarInlineRenameStore", () => {
  beforeEach(() => useSidebarInlineRenameStore.getState().cancel());

  it("keeps the active target and draft outside the Sidebar component lifecycle", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    useSidebarInlineRenameStore.getState().startThread(threadId, "Original");
    useSidebarInlineRenameStore.getState().updateValue("Unsaved draft");

    expect(useSidebarInlineRenameStore.getState().editor).toEqual({
      kind: "thread",
      threadId,
      value: "Unsaved draft",
    });
  });

  it("only finishes the editor that completed its save", () => {
    const projectId = ContainerId.makeUnsafe("project-1");
    useSidebarInlineRenameStore.getState().startFolder(projectId, "Product");

    useSidebarInlineRenameStore
      .getState()
      .finish({ kind: "thread", threadId: ThreadId.makeUnsafe("thread-1") });
    expect(useSidebarInlineRenameStore.getState().editor).not.toBeNull();

    useSidebarInlineRenameStore.getState().finish({ kind: "folder", projectId });
    expect(useSidebarInlineRenameStore.getState().editor).toBeNull();
  });
});
