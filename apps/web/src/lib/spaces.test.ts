// FILE: spaces.test.ts
// Purpose: Verifies web-client Space command batching and partial-failure reporting.

import {
  THREADS_PAGE_SIZE,
  FOLDER_MOVE_MAX_COUNT,
  type NativeApi,
  type FolderId,
  SpaceId,
} from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import { moveFoldersToSpace, reorderSpaces } from "./spaces";

function makeApi(
  dispatchCommand: ReturnType<typeof vi.fn>,
  getFolders: ReturnType<typeof vi.fn> = vi.fn().mockRejectedValue(new Error("offline")),
): NativeApi {
  return {
    cleanCore: { updateNavigation: dispatchCommand, getFolders },
    orchestration: {
      dispatchCommand,
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
      spaceId: SpaceId.make("space-target"),
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
        spaceId: SpaceId.make("space-target"),
      }),
    ).resolves.toEqual({ failedFolderIds: [] });
  });

  it("does not report folders that committed before a transport failure", async () => {
    const targetSpaceId = SpaceId.make("space-target");
    const folderIds = ["project-1", "project-2"] as FolderId[];
    const dispatchCommand = vi.fn().mockRejectedValue(new Error("connection closed"));
    const getFolders = vi.fn().mockResolvedValue([
      { id: folderIds[0], spaceId: targetSpaceId },
      { id: folderIds[1], spaceId: null },
    ]);

    await expect(
      moveFoldersToSpace({
        api: makeApi(dispatchCommand, getFolders),
        folderIds,
        spaceId: targetSpaceId,
      }),
    ).resolves.toEqual({ failedFolderIds: [folderIds[1]] });
    expect(getFolders).toHaveBeenCalledOnce();
  });

  it("does not report folders deleted concurrently with an ambiguous dispatch", async () => {
    const targetSpaceId = SpaceId.make("space-target");
    const folderIds = ["project-deleted", "project-still-active"] as FolderId[];
    const dispatchCommand = vi.fn().mockRejectedValue(new Error("connection closed"));
    const getFolders = vi.fn().mockResolvedValue([{ id: folderIds[1], spaceId: null }]);

    await expect(
      moveFoldersToSpace({
        api: makeApi(dispatchCommand, getFolders),
        folderIds,
        spaceId: targetSpaceId,
      }),
    ).resolves.toEqual({ failedFolderIds: [folderIds[1]] });
  });

  it("recovers the entire failed selection in bounded ID batches", async () => {
    const targetSpaceId = SpaceId.make("space-target");
    const folderIds = Array.from(
      { length: THREADS_PAGE_SIZE + 3 },
      (_, i) => `project-${i}` as FolderId,
    );
    const dispatchCommand = vi.fn().mockRejectedValue(new Error("connection closed"));
    const getFolders = vi.fn(async ({ folderIds: ids }: { folderIds: FolderId[] }) =>
      ids.map((id) => ({ id, spaceId: id === folderIds.at(-1) ? null : targetSpaceId })),
    );
    await expect(
      moveFoldersToSpace({
        api: makeApi(dispatchCommand, getFolders),
        folderIds,
        spaceId: targetSpaceId,
      }),
    ).resolves.toEqual({ failedFolderIds: [folderIds.at(-1)] });
    expect(getFolders.mock.calls.map(([input]) => input.folderIds)).toEqual([
      folderIds.slice(0, THREADS_PAGE_SIZE),
      folderIds.slice(THREADS_PAGE_SIZE),
    ]);
  });
});

describe("reorderSpaces", () => {
  it("updates the moved Space's resulting sort order", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 0 });
    const first = SpaceId.make("first");
    const second = SpaceId.make("second");
    const third = SpaceId.make("third");

    await reorderSpaces({
      api: makeApi(dispatchCommand),
      movedSpaceId: third,
      orderedSpaceIds: [third, first, second],
    });

    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          action: "space.move",
          spaceId: third,
          position: { type: "start" },
        },
      }),
    );
    expect(dispatchCommand.mock.calls[0]?.[0]).not.toHaveProperty("orderedSpaceIds");
  });
});
