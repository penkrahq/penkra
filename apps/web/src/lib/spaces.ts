// FILE: spaces.ts
// Purpose: The Spaces domain for the web client — which folders Spaces organize, plus the
//          durable commands that move them around.
// Layer: Web domain helper

import { THREADS_PAGE_SIZE } from "@penkra/contracts";
import {
  FOLDER_MOVE_MAX_COUNT,
  type NativeApi,
  type CleanCoreGetNavigationResult,
  type FolderId,
  type SpaceIconName,
  type SpaceId,
} from "@penkra/contracts";

import type { Project } from "~/types";
import type { ServerWorkspacePaths } from "~/lib/serverWorkspacePaths";
import { newSpaceId } from "~/lib/utils";

/**
 * Spaces organize ordinary folders only: managed chat containers are reachable
 * from every Space and so belong to none. This is the membership rule the whole feature
 * turns on — the sidebar list, the tab activity dots, the pickers, and the shortcut
 * targets all have to agree on it, so it lives here rather than being spelled out again
 * at each call site.
 */
export function isOrdinarySpaceProject(
  project: Project | null | undefined,
  _paths: ServerWorkspacePaths,
): project is Project {
  return project !== null && project !== undefined;
}

export async function createSpace(input: {
  api: NativeApi;
  name: string;
  icon: SpaceIconName;
}): Promise<{ spaceId: SpaceId; createdAt: string; navigation: CleanCoreGetNavigationResult }> {
  const spaceId = newSpaceId();
  const createdAt = new Date().toISOString();
  const navigation = await input.api.cleanCore.updateNavigation({
    update: {
      action: "space.create",
      spaceId,
      name: input.name,
      icon: input.icon,
      createdAt,
    },
  });
  return { spaceId, createdAt, navigation };
}

/**
 * Fields left undefined are not sent, so an icon-only edit cannot collide with a
 * concurrent rename from another window (and vice versa).
 */
export async function updateSpace(input: {
  api: NativeApi;
  spaceId: SpaceId;
  name?: string | undefined;
  icon?: SpaceIconName | undefined;
}): Promise<void> {
  await input.api.cleanCore.updateNavigation({
    update: {
      action: "space.update",
      spaceId: input.spaceId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
    },
  });
}

export async function deleteSpace(input: { api: NativeApi; spaceId: SpaceId }): Promise<void> {
  await input.api.cleanCore.updateNavigation({
    update: {
      action: "space.delete",
      spaceId: input.spaceId,
    },
  });
}

export async function archiveSpace(input: { api: NativeApi; spaceId: SpaceId }): Promise<void> {
  await input.api.cleanCore.updateNavigation({
    update: {
      action: "space.archive",
      spaceId: input.spaceId,
    },
  });
}

export async function restoreSpace(input: {
  api: NativeApi;
  spaceId: SpaceId;
  name?: string | undefined;
}): Promise<void> {
  await input.api.cleanCore.updateNavigation({
    update: {
      action: "space.restore",
      spaceId: input.spaceId,
      ...(input.name !== undefined ? { name: input.name } : {}),
    },
  });
}

export async function reorderSpaces(input: {
  api: NativeApi;
  movedSpaceId: SpaceId;
  orderedSpaceIds: ReadonlyArray<SpaceId>;
}): Promise<void> {
  const movedIndex = input.orderedSpaceIds.indexOf(input.movedSpaceId);
  if (movedIndex < 0) return;
  const previous = input.orderedSpaceIds[movedIndex - 1];
  await input.api.cleanCore.updateNavigation({
    update: {
      action: "space.move",
      spaceId: input.movedSpaceId,
      position: previous === undefined ? { type: "start" } : { type: "after", itemId: previous },
    },
  });
}

export async function moveProjectToSpace(input: {
  api: NativeApi;
  folderId: FolderId;
  spaceId: SpaceId;
}): Promise<void> {
  await input.api.cleanCore.updateNavigation({
    update: {
      action: "folder.move",
      folderIds: [input.folderId],
      spaceId: input.spaceId,
    },
  });
}

/**
 * Files folders into a space as one atomic command per chunk (the command payload is
 * capped, so oversized selections split). A chunk either fully applies or fully fails;
 * on the first failure the remaining chunks are not attempted and everything not yet
 * processed is reported back for retry. The server may skip folders that are already
 * settled (assigned to the target or deleted), so a successful chunk must not be used
 * to infer an exact count of folders whose assignment changed.
 */
export async function moveFoldersToSpace(input: {
  api: NativeApi;
  folderIds: ReadonlyArray<FolderId>;
  spaceId: SpaceId;
}): Promise<{ failedFolderIds: FolderId[] }> {
  for (let offset = 0; offset < input.folderIds.length; offset += FOLDER_MOVE_MAX_COUNT) {
    const chunk = input.folderIds.slice(offset, offset + FOLDER_MOVE_MAX_COUNT);
    try {
      await input.api.cleanCore.updateNavigation({
        update: {
          action: "folder.move",
          spaceId: input.spaceId,
          folderIds: chunk,
        },
      });
    } catch {
      const remainingFolderIds = input.folderIds.slice(offset);
      // A transport error can race a committed command. Re-read the authoritative shell
      // before offering a retry so we do not report folders that already reached the target.
      try {
        const projectById = new Map<
          FolderId,
          Awaited<ReturnType<NativeApi["cleanCore"]["getFolders"]>>[number]
        >();
        for (let index = 0; index < remainingFolderIds.length; index += THREADS_PAGE_SIZE) {
          const folders = await input.api.cleanCore.getFolders({
            folderIds: remainingFolderIds.slice(index, index + THREADS_PAGE_SIZE),
          });
          for (const folder of folders) projectById.set(folder.id, folder);
        }
        return {
          failedFolderIds: remainingFolderIds.filter((folderId) => {
            const project = projectById.get(folderId);
            // Missing shell rows were deleted concurrently and are settled just like rows
            // already assigned to the target; neither should be offered for a doomed retry.
            return project !== undefined && project.spaceId !== input.spaceId;
          }),
        };
      } catch {
        return { failedFolderIds: remainingFolderIds };
      }
    }
  }
  return { failedFolderIds: [] };
}
