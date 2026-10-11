import { FolderId, ThreadId } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  startContainerChat,
  startChatForActiveSurface,
  type StartContainerChatResult,
} from "./startContainerChat";

function successfulHandler() {
  return vi.fn(async (): Promise<StartContainerChatResult> => ({ ok: true, threadId: null }));
}

describe("startChatForActiveSurface", () => {
  it("selects a managed chat draft", async () => {
    const handleNewChat = successfulHandler();

    await startChatForActiveSurface({ handleNewChat });

    expect(handleNewChat).toHaveBeenCalledOnce();
    expect(handleNewChat).toHaveBeenCalledWith();
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
        errorLabel: "failed",
      }),
    ).resolves.toEqual({ ok: true, threadId });

    expect(handleNewThread).toHaveBeenCalledWith(folderId, undefined);
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
