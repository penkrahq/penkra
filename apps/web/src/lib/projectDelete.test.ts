// FILE: projectDelete.test.ts
// Purpose: Verifies project deletion reconciles local state only after server acceptance.

import { FolderId } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import { deleteProjectFromClient } from "./projectDelete";

describe("deleteProjectFromClient", () => {
  it("reconciles local state after the delete command succeeds", async () => {
    const folderId = FolderId.makeUnsafe("project-delete");
    const order: string[] = [];
    const dispatchCommand = vi.fn(async () => {
      order.push("dispatch");
      return { sequence: 12 };
    });
    const removeDeletedProjectFromClientState = vi.fn(() => {
      order.push("remove");
    });

    await deleteProjectFromClient({
      api: { dispatchCommand },
      folderId,
      removeDeletedProjectFromClientState,
    });

    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "folder.delete",
      commandId: expect.any(String),
      folderId,
    });
    expect(removeDeletedProjectFromClientState).toHaveBeenCalledWith(folderId);
    expect(order).toEqual(["dispatch", "remove"]);
  });

  it("keeps local state when the delete command fails", async () => {
    const folderId = FolderId.makeUnsafe("project-delete-failed");
    const dispatchCommand = vi.fn(async () => {
      throw new Error("delete rejected");
    });
    const removeDeletedProjectFromClientState = vi.fn();

    await expect(
      deleteProjectFromClient({
        api: { dispatchCommand },
        folderId,
        removeDeletedProjectFromClientState,
      }),
    ).rejects.toThrow("delete rejected");

    expect(removeDeletedProjectFromClientState).not.toHaveBeenCalled();
  });
});
