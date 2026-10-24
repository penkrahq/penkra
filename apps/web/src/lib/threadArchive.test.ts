import { describe, expect, it, vi } from "vitest";
import { ThreadId } from "@penkra/contracts";
import { archiveThreadFromClient, unarchiveThreadFromClient } from "./threadArchive";
describe("clean-core archive", () => {
  it("sets archive and unarchive through the same clean-core operation", async () => {
    const threadId = ThreadId.make("thread-archive");
    const updateThread = vi.fn().mockResolvedValue(undefined);
    await archiveThreadFromClient({ updateThread }, threadId);
    await unarchiveThreadFromClient({ updateThread }, threadId);
    expect(updateThread).toHaveBeenNthCalledWith(1, {
      update: {
        action: "archive",
        threadId,
        archivedAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    expect(updateThread).toHaveBeenNthCalledWith(2, {
      update: { action: "archive", threadId, archivedAt: null, updatedAt: expect.any(String) },
    });
  });
  it("propagates write failures", async () => {
    const error = new Error("write failed");
    await expect(
      unarchiveThreadFromClient(
        { updateThread: vi.fn().mockRejectedValue(error) },
        ThreadId.make("thread-archive"),
      ),
    ).rejects.toBe(error);
  });
});
