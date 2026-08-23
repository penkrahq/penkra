// FILE: spaces.test.ts
// Purpose: Verifies web-client Space command batching and partial-failure reporting.

import { FOLDER_MOVE_MAX_COUNT, type NativeApi, type FolderId, SpaceId } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import { moveFoldersToSpace, reorderSpaces } from "./spaces";

function makeApi(
  dispatchCommand: ReturnType<typeof vi.fn>,
  getShellSnapshot: ReturnType<typeof vi.fn> = vi.fn().mockRejectedValue(new Error("offline")),
): NativeApi {
  return {
    orchestration: {
      dispatchCommand,
      getShellSnapshot,
    },
  } as unknown as NativeApi;
}

describe("moveFoldersToSpace", () => {
  it("reports only the failed and unattempted chunks without inventing a moved count", async () => {
    const folderIds = Array.from(
      { length: FOLDER_MOVE_MAX_COUNT + 2 },
      (_, index) => `project-${index}` as FolderId,
    );
    const dispatchCommand = vi
      .fn()
      .mockResolvedValueOnce({ sequence: 1 })
      .mockRejectedValueOnce(new Error("dispatch failed"));

    const result = await moveFoldersToSpace({
      api: makeApi(dispatchCommand),
      folderIds,
      spaceId: SpaceId.makeUnsafe("space-target"),
    });

    expect(result).toEqual({
      failedFolderIds: folderIds.slice(FOLDER_MOVE_MAX_COUNT),
    });
    expect(result).not.toHaveProperty("movedFolderIds");
    expect(dispatchCommand).toHaveBeenCalledTimes(2);
  });

  it("returns no failures when every chunk is accepted", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 1 });

    await expect(
      moveFoldersToSpace({
        api: makeApi(dispatchCommand),
        folderIds: ["project-1" as FolderId, "project-2" as FolderId],
        spaceId: SpaceId.makeUnsafe("space-target"),
      }),
    ).resolves.toEqual({ failedFolderIds: [] });
  });

  it("does not report folders that committed before a transport failure", async () => {
    const targetSpaceId = SpaceId.makeUnsafe("space-target");
    const folderIds = ["project-1", "project-2"] as FolderId[];
    const dispatchCommand = vi.fn().mockRejectedValue(new Error("connection closed"));
    const getShellSnapshot = vi.fn().mockResolvedValue({
      folders: [
        { id: folderIds[0], spaceId: targetSpaceId },
        { id: folderIds[1], spaceId: null },
      ],
    });

    await expect(
      moveFoldersToSpace({
        api: makeApi(dispatchCommand, getShellSnapshot),
        folderIds,
        spaceId: targetSpaceId,
      }),
    ).resolves.toEqual({ failedFolderIds: [folderIds[1]] });
    expect(getShellSnapshot).toHaveBeenCalledOnce();
  });

  it("does not report folders deleted concurrently with an ambiguous dispatch", async () => {
    const targetSpaceId = SpaceId.makeUnsafe("space-target");
    const folderIds = ["project-deleted", "project-still-active"] as FolderId[];
    const dispatchCommand = vi.fn().mockRejectedValue(new Error("connection closed"));
    const getShellSnapshot = vi.fn().mockResolvedValue({
      folders: [{ id: folderIds[1], spaceId: null }],
    });

    await expect(
      moveFoldersToSpace({
        api: makeApi(dispatchCommand, getShellSnapshot),
        folderIds,
        spaceId: targetSpaceId,
      }),
    ).resolves.toEqual({ failedFolderIds: [folderIds[1]] });
  });
});

describe("reorderSpaces", () => {
  it("updates the moved Space's resulting sort order", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 0 });
    const first = SpaceId.makeUnsafe("first");
    const second = SpaceId.makeUnsafe("second");
    const third = SpaceId.makeUnsafe("third");

    await reorderSpaces({
      api: makeApi(dispatchCommand),
      movedSpaceId: third,
      orderedSpaceIds: [third, first, second],
    });

    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "space.update",
        spaceId: third,
        sortOrder: 0,
      }),
    );
    expect(dispatchCommand.mock.calls[0]?.[0]).not.toHaveProperty("orderedSpaceIds");
  });
});
