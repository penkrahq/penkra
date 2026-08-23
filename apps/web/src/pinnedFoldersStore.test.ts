// FILE: pinnedFoldersStore.test.ts
// Purpose: Verifies the capped pinned-project store mutates ids predictably.
// Layer: UI state store test

import { beforeEach, describe, expect, it } from "vitest";
import { FolderId } from "@penkra/contracts";
import { usePinnedFoldersStore } from "./pinnedFoldersStore";

describe("usePinnedFoldersStore", () => {
  beforeEach(() => {
    usePinnedFoldersStore.setState({ pinnedFolderIds: [] });
  });

  it("pins newest project ids first and rejects a fourth pin", () => {
    expect(usePinnedFoldersStore.getState().pinProject("project-1" as FolderId)).toBe(true);
    expect(usePinnedFoldersStore.getState().pinProject("project-2" as FolderId)).toBe(true);
    expect(usePinnedFoldersStore.getState().pinProject("project-3" as FolderId)).toBe(true);
    expect(usePinnedFoldersStore.getState().pinProject("project-4" as FolderId)).toBe(false);

    expect(usePinnedFoldersStore.getState().pinnedFolderIds).toEqual([
      "project-3",
      "project-2",
      "project-1",
    ]);
  });

  it("unpins and prunes project ids that are no longer present", () => {
    usePinnedFoldersStore.setState({
      pinnedFolderIds: ["project-3" as FolderId, "project-2" as FolderId, "project-1" as FolderId],
    });

    usePinnedFoldersStore.getState().unpinProject("project-2" as FolderId);
    expect(usePinnedFoldersStore.getState().pinnedFolderIds).toEqual(["project-3", "project-1"]);

    usePinnedFoldersStore.getState().prunePinnedFolders(["project-1" as FolderId]);
    expect(usePinnedFoldersStore.getState().pinnedFolderIds).toEqual(["project-1"]);
  });
});
