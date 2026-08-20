import { ContainerId, ThreadId } from "@penkra/contracts";
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
    const projectId = ContainerId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const handleNewThread = vi.fn(async () => threadId);

    await expect(
      startContainerChat({
        ensureProjectId: async () => projectId,
        handleNewThread,
        fresh: true,
        errorLabel: "failed",
      }),
    ).resolves.toEqual({ ok: true, threadId });

    expect(handleNewThread).toHaveBeenCalledWith(projectId, {
      fresh: true,
    });
  });

  it("starts a stored Folder draft without extra overrides", async () => {
    const projectId = ContainerId.makeUnsafe("folder-project");
    const threadId = ThreadId.makeUnsafe("folder-thread");
    const handleNewThread = vi.fn(async () => threadId);

    await startContainerChat({
      ensureProjectId: async () => projectId,
      handleNewThread,
      errorLabel: "failed",
    });

    expect(handleNewThread).toHaveBeenCalledWith(projectId, undefined);
  });
});
