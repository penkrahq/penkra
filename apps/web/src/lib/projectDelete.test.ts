// FILE: projectDelete.test.ts
// Purpose: Verifies project deletion reconciles local state only after server acceptance.

import { FolderId } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import { deleteProjectFromClient } from "./projectDelete";

describe("deleteProjectFromClient", () => {
  it("reconciles local state after the delete command succeeds", async () => {
    const folderId = FolderId.make("project-delete");
    const order: string[] = [];
    const updateNavigation = vi.fn(async () => {
      order.push("dispatch");
      return { spaces: [], folders: [] };
    });
    const removeDeletedProjectFromClientState = vi.fn(() => {
      order.push("remove");
    });

    await deleteProjectFromClient({
      api: { updateNavigation },
      folderId,
      removeDeletedProjectFromClientState,
    });

    expect(updateNavigation).toHaveBeenCalledWith({
      update: { action: "folder.delete", folderId },
    });
    expect(removeDeletedProjectFromClientState).toHaveBeenCalledWith(folderId);
    expect(order).toEqual(["dispatch", "remove"]);
  });

  it("keeps local state when the delete command fails", async () => {
    const folderId = FolderId.make("project-delete-failed");
    const updateNavigation = vi.fn(async () => {
      throw new Error("delete rejected");
    });
    const removeDeletedProjectFromClientState = vi.fn();

    await expect(
      deleteProjectFromClient({
        api: { updateNavigation },
        folderId,
        removeDeletedProjectFromClientState,
      }),
    ).rejects.toThrow("delete rejected");

    expect(removeDeletedProjectFromClientState).not.toHaveBeenCalled();
  });
});
