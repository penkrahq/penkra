// FILE: archivedThreadDelete.test.ts
// Purpose: Verifies archived-thread delete coordination without rendering settings UI.
// Layer: Web orchestration helper tests

import { ThreadId } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  deleteArchivedThreadFromClient,
  deleteArchivedThreadsFromClient,
} from "./archivedThreadDelete";

describe("deleteArchivedThreadFromClient", () => {
  it("dispatches delete, then removes the local row", async () => {
    const threadId = ThreadId.make("thread-archived");
    const updateThread = vi.fn().mockResolvedValue({ sequence: 11 });
    const removeDeletedThreadFromClientState = vi.fn();

    await deleteArchivedThreadFromClient({
      api: { updateThread },
      threadId,
      removeDeletedThreadFromClientState,
    });

    expect(updateThread).toHaveBeenCalledWith({
      update: {
        action: "delete",
        threadId,
        deletedAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    expect(removeDeletedThreadFromClientState).toHaveBeenCalledOnce();
    expect(removeDeletedThreadFromClientState).toHaveBeenCalledWith(threadId);
    const dispatchOrder = updateThread.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const removeOrder =
      removeDeletedThreadFromClientState.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(dispatchOrder).toBeLessThan(removeOrder);
  });

  it("deletes multiple archived threads and removes each locally once", async () => {
    const threadA = ThreadId.make("thread-archived-a");
    const threadB = ThreadId.make("thread-archived-b");
    const updateThread = vi.fn().mockResolvedValue({ sequence: 11 });
    const removeDeletedThreadFromClientState = vi.fn();

    await deleteArchivedThreadsFromClient({
      api: { updateThread },
      threadIds: [threadA, threadA, threadB],
      removeDeletedThreadFromClientState,
    });

    expect(updateThread).toHaveBeenCalledTimes(2);
    expect(updateThread).toHaveBeenNthCalledWith(1, {
      update: {
        action: "delete",
        threadId: threadA,
        deletedAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    expect(updateThread).toHaveBeenNthCalledWith(2, {
      update: {
        action: "delete",
        threadId: threadB,
        deletedAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([[threadA], [threadB]]);
  });

  it("reconciles successful archived deletes when a later bulk delete fails", async () => {
    const threadA = ThreadId.make("thread-archived-a");
    const threadB = ThreadId.make("thread-archived-b");
    const dispatchError = new Error("delete failed");
    const updateThread = vi
      .fn()
      .mockResolvedValueOnce({ sequence: 11 })
      .mockRejectedValueOnce(dispatchError);
    const removeDeletedThreadFromClientState = vi.fn();

    await expect(
      deleteArchivedThreadsFromClient({
        api: { updateThread },
        threadIds: [threadA, threadB],
        removeDeletedThreadFromClientState,
      }),
    ).rejects.toThrow(dispatchError);

    expect(updateThread).toHaveBeenCalledTimes(2);
    expect(removeDeletedThreadFromClientState.mock.calls).toEqual([[threadA]]);
  });
});
