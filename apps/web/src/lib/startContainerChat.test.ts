import { FolderId, ThreadId } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  startContainerChat,
  startFreshChatForActiveSurface,
  type StartContainerChatResult,
} from "./startContainerChat";

function successfulHandler() {
  return vi.fn(async (): Promise<StartContainerChatResult> => ({ ok: true, threadId: null }));
}

describe("startFreshChatForActiveSurface", () => {
  it("starts a fresh managed chat", async () => {
    const handleNewChat = successfulHandler();

    await startFreshChatForActiveSurface({ handleNewChat });

    expect(handleNewChat).toHaveBeenCalledOnce();
    expect(handleNewChat).toHaveBeenCalledWith({ fresh: true });
  });
});

describe("startContainerChat", () => {
  it("returns the created thread so callers can attach context deterministically", async () => {
    const folderId = FolderId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const handleNewThread = vi.fn(async () => threadId);

    await expect(
      startContainerChat({
        ensureFolderId: async () => folderId,
        handleNewThread,
        fresh: true,
        errorLabel: "failed",
      }),
    ).resolves.toEqual({ ok: true, threadId });

    expect(handleNewThread).toHaveBeenCalledWith(folderId, {
      fresh: true,
    });
  });

  it("starts a stored Folder draft without extra overrides", async () => {
    const folderId = FolderId.makeUnsafe("folder-project");
    const threadId = ThreadId.makeUnsafe("folder-thread");
    const handleNewThread = vi.fn(async () => threadId);

    await startContainerChat({
      ensureFolderId: async () => folderId,
      handleNewThread,
      errorLabel: "failed",
    });

    expect(handleNewThread).toHaveBeenCalledWith(folderId, undefined);
  });
});
