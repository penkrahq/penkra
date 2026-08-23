import { describe, expect, it, vi } from "vitest";

const dispatchCommand = vi.fn<(command: unknown) => Promise<{ sequence: number }>>();
const getShellSnapshot = vi.fn(async () => ({
  snapshotSequence: 1,
  spaces: [],
  folders: [
    {
      id: "project-chat",
      kind: "folder" as const,
      title: "Project",
      workspaceRoot: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:00.000Z",
    },
  ],
  threads: [
    {
      id: "thread-draft",
      folderId: "project-chat",
      title: "Inbox cleanup",
      modelSelection: { provider: "codex" as const, model: "gpt-5" },
      runtimeMode: "full-access" as const,
      parentThreadId: null,
      subagentAgentId: null,
      subagentNickname: null,
      subagentRole: null,
      forkSourceThreadId: null,
      latestTurn: null,
      createdAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:00.000Z",
      archivedAt: null,
      session: null,
    },
  ],
  updatedAt: "2026-04-18T00:00:00.000Z",
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand,
      getShellSnapshot,
    },
  }),
}));

import { dispatchThreadRename } from "./threadRename";

describe("dispatchThreadRename", () => {
  it("updates existing server threads", async () => {
    dispatchCommand.mockReset().mockResolvedValue({ sequence: 1 });

    const outcome = await dispatchThreadRename({
      threadId: "thread-server" as never,
      newTitle: "Renamed server thread",
      unchangedTitles: ["New thread"],
    });

    expect(outcome).toBe("renamed");
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.update",
      threadId: "thread-server",
      title: "Renamed server thread",
    });
  });

  it("promotes local drafts by creating the thread with the chosen title", async () => {
    dispatchCommand.mockReset().mockResolvedValue({ sequence: 1 });
    getShellSnapshot.mockClear();

    const outcome = await dispatchThreadRename({
      threadId: "thread-draft" as never,
      newTitle: "Inbox cleanup",
      unchangedTitles: ["New thread"],
      createIfMissing: {
        folderId: "project-chat" as never,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        workingDirectory: null,
        createdAt: "2026-04-18T00:00:00.000Z",
      },
    });

    expect(outcome).toBe("renamed");
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(getShellSnapshot).toHaveBeenCalledTimes(1);
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.create",
      threadId: "thread-draft",
      folderId: "project-chat",
      title: "Inbox cleanup",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
  });
});
