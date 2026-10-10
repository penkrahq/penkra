import { describe, expect, it, vi } from "vitest";

const updateThread = vi.fn();
const createThread = vi.fn();
const getShellSnapshot = vi.fn(async () => ({
  snapshotSequence: 1,
  spaces: [],
  decks: [
    {
      id: "deck:thread-draft",
      spaceId: "space-1",
      threadIds: ["thread-draft"],
      createdAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:00.000Z",
    },
  ],
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
      deckId: "deck:thread-draft",
      deckSortOrder: 0,
      folderId: "project-chat",
      title: "Inbox cleanup",
      modelSelection: { provider: "codex" as const, model: "gpt-5" },
      runtimeMode: "full-access" as const,
      parentThreadId: null,
      subagentAgentId: null,
      subagentNickname: null,
      subagentRole: null,
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
    cleanCore: { updateThread, createThread },
    orchestration: {
      getShellSnapshot,
    },
  }),
}));

import { dispatchThreadRename } from "./threadRename";

describe("dispatchThreadRename", () => {
  it("updates existing server threads", async () => {
    updateThread.mockReset().mockResolvedValue(undefined);
    createThread.mockReset().mockResolvedValue({
      thread: { id: "thread-draft" },
      created: true,
      shell: (await getShellSnapshot()).threads[0],
    });

    const outcome = await dispatchThreadRename({
      threadId: "thread-server" as never,
      newTitle: "Renamed server thread",
      unchangedTitles: ["New thread"],
    });

    expect(outcome).toBe("renamed");
    expect(updateThread).toHaveBeenCalledTimes(1);
    expect(updateThread.mock.calls[0]?.[0]).toMatchObject({
      update: {
        action: "rename",
        threadId: "thread-server",
        title: "Renamed server thread",
      },
    });
  });

  it("promotes local drafts by creating the thread with the chosen title", async () => {
    updateThread.mockReset().mockResolvedValue(undefined);
    createThread.mockReset().mockResolvedValue({
      thread: { id: "thread-draft" },
      created: true,
      shell: (await getShellSnapshot()).threads[0],
    });
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
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(getShellSnapshot).not.toHaveBeenCalled();
    expect(createThread.mock.calls[0]?.[0]).toMatchObject({
      threadId: "thread-draft",
      deckId: "deck:thread-draft",
      folderId: "project-chat",
      title: "Inbox cleanup",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
  });
});
