// Purpose: Canonical navigation reads and atomic space/folder writes, without an event log.
import {
  CleanCoreGetNavigationResult,
  ModelSelection,
  SPACES_MAX_COUNT,
  type CleanCoreUpdateNavigationInput,
  type OrchestrationSpaceShell,
  type OrchestrationFolderShell,
} from "@penkra/contracts";
import { normalizeEntityName } from "@penkra/shared/entityNames";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadPublisher } from "./ThreadPublisher";
import { moveFolder, moveSpace } from "./threadStore";

type SpaceRow = OrchestrationSpaceShell & { deletedAt: string | null };
type FolderRow = Omit<OrchestrationFolderShell, "defaultModelSelection"> & {
  defaultModelSelection: string | null;
  deletedAt: string | null;
};
const readNavigationRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* sql<SpaceRow>`SELECT space_id AS id, name, icon,
    sort_order AS "sortOrder", created_at AS "createdAt", updated_at AS "updatedAt",
    archived_at AS "archivedAt", deleted_at AS "deletedAt"
    FROM projection_spaces ORDER BY sort_order, space_id`;
  const folders = yield* sql<FolderRow>`SELECT folder_id AS id, title,
    workspace_root AS "workspaceRoot", default_model_selection_json AS "defaultModelSelection",
    icon_data_url AS "iconDataUrl", space_id AS "spaceId", sidebar_sort_order AS "sidebarSortOrder",
    created_at AS "createdAt", updated_at AS "updatedAt", archived_at AS "archivedAt",
    deleted_at AS "deletedAt" FROM projection_folders ORDER BY created_at, folder_id`;
  return { spaces, folders };
});

const readNavigation = Effect.gen(function* () {
  const rows = yield* readNavigationRows;
  const folders = yield* Effect.forEach(
    rows.folders.filter((row) => row.deletedAt === null && row.archivedAt === null),
    (row) =>
      Effect.gen(function* () {
        const defaultModelSelection =
          row.defaultModelSelection === null
            ? null
            : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection))(
                row.defaultModelSelection,
              );
        return { ...row, defaultModelSelection };
      }),
  );
  return yield* Schema.decodeUnknownEffect(CleanCoreGetNavigationResult)({
    spaces: rows.spaces.filter((row) => row.deletedAt === null && row.archivedAt === null),
    folders,
  });
});

export const getNavigation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(readNavigation);
});

export const updateNavigation = (input: CleanCoreUpdateNavigationInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const publisher = yield* ThreadPublisher;
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const { spaces, folders } = yield* readNavigationRows;
        const changedThreadIds: string[] = [];
        const update = input.update;
        const now = new Date().toISOString();
        const fail = (message: string) => Effect.fail(new Error(message));
        const activeSpaces = spaces.filter(
          (row) => row.deletedAt === null && row.archivedAt === null,
        );
        const requireSpace = (id: string) => {
          const row = activeSpaces.find((row) => row.id === id);
          return row ? Effect.succeed(row) : fail(`Space '${id}' is not available.`);
        };
        const requireFolder = (id: string) => {
          const row = folders.find((row) => row.id === id && row.deletedAt === null);
          return row ? Effect.succeed(row) : fail(`Folder '${id}' is not available.`);
        };
        const requireSpaceName = (name: string, except?: string) =>
          activeSpaces.some(
            (row) =>
              row.id !== except && row.name.trim().toLowerCase() === name.trim().toLowerCase(),
          )
            ? fail(`A space named '${name}' already exists.`)
            : Effect.void;
        const requireFolderName = (name: string, spaceId: string, except?: string) =>
          folders.some(
            (row) =>
              row.deletedAt === null &&
              row.spaceId === spaceId &&
              row.id !== except &&
              normalizeEntityName(row.title) === normalizeEntityName(name),
          )
            ? fail(`A folder named '${name}' already exists in this Space.`)
            : Effect.void;
        switch (update.action) {
          case "space.create": {
            if (spaces.some((row) => row.id === update.spaceId))
              return yield* fail(`Space '${update.spaceId}' already exists.`);
            yield* requireSpaceName(update.name);
            if (activeSpaces.length >= SPACES_MAX_COUNT)
              return yield* fail(`A maximum of ${SPACES_MAX_COUNT} custom spaces is supported.`);
            const order = activeSpaces.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
            yield* sql`INSERT INTO projection_spaces (space_id,name,icon,sort_order,created_at,updated_at)
          VALUES (${update.spaceId},${update.name},${update.icon},${order},${update.createdAt},${update.createdAt})`;
            break;
          }
          case "space.update": {
            const row = yield* requireSpace(update.spaceId);
            if (
              (update.name === undefined || update.name === row.name) &&
              (update.icon === undefined || update.icon === row.icon)
            )
              return yield* fail("Space update must change a name or icon.");
            const name = update.name ?? row.name;
            yield* requireSpaceName(name, row.id);
            yield* sql`UPDATE projection_spaces SET name=${name}, icon=${update.icon ?? row.icon}, updated_at=${now} WHERE space_id=${row.id}`;
            break;
          }
          case "space.archive": {
            yield* requireSpace(update.spaceId);
            if (activeSpaces.length <= 1)
              return yield* fail("At least one active Space must remain.");
            yield* sql`UPDATE projection_spaces SET archived_at=${now}, updated_at=${now} WHERE space_id=${update.spaceId}`;
            break;
          }
          case "space.restore": {
            const row = spaces.find(
              (row) =>
                row.id === update.spaceId && row.deletedAt === null && row.archivedAt !== null,
            );
            if (!row) return yield* fail(`Space '${update.spaceId}' is not available to restore.`);
            if (activeSpaces.length >= SPACES_MAX_COUNT)
              return yield* fail(
                `A maximum of ${SPACES_MAX_COUNT} active custom spaces is supported.`,
              );
            yield* requireSpaceName(update.name ?? row.name, row.id);
            yield* sql`UPDATE projection_spaces SET name=${update.name ?? row.name}, archived_at=NULL, updated_at=${now} WHERE space_id=${row.id}`;
            break;
          }
          case "space.delete": {
            const row = spaces.find((row) => row.id === update.spaceId && row.deletedAt === null);
            if (!row)
              return yield* fail(
                `Space '${update.spaceId}' does not exist or was already deleted.`,
              );
            if (row.archivedAt === null && activeSpaces.length <= 1)
              return yield* fail("At least one active Space must remain.");
            if (folders.some((folder) => folder.spaceId === row.id && folder.deletedAt === null))
              return yield* fail("Move every folder out of this Space before deleting it.");
            yield* sql`UPDATE projection_spaces SET deleted_at=${now},updated_at=${now} WHERE space_id=${row.id}`;
            break;
          }
          case "folder.create": {
            if (folders.some((row) => row.id === update.folderId))
              return yield* fail(`Folder '${update.folderId}' already exists.`);
            yield* requireSpace(update.spaceId);
            yield* requireFolderName(update.title, update.spaceId);
            yield* sql`INSERT INTO projection_folders (folder_id,kind,title,workspace_root,default_model_selection_json,space_id,created_at,updated_at)
          VALUES (${update.folderId},'project',${update.title},${update.workspaceRoot ?? null},${update.defaultModelSelection ? JSON.stringify(update.defaultModelSelection) : null},${update.spaceId},${update.createdAt},${update.createdAt})`;
            break;
          }
          case "folder.update": {
            const row = yield* requireFolder(update.folderId);
            const title = update.title ?? row.title;
            yield* requireFolderName(title, row.spaceId, row.id);
            yield* sql`UPDATE projection_folders SET title=${title},
          workspace_root=${update.workspaceRoot === undefined ? row.workspaceRoot : update.workspaceRoot},
          default_model_selection_json=${update.defaultModelSelection === undefined ? row.defaultModelSelection : update.defaultModelSelection === null ? null : JSON.stringify(update.defaultModelSelection)},
          icon_data_url=${update.iconDataUrl === undefined ? (row.iconDataUrl ?? null) : update.iconDataUrl},
          archived_at=${update.archivedAt === undefined ? (row.archivedAt ?? null) : update.archivedAt},updated_at=${now}
          WHERE folder_id=${row.id}`;
            break;
          }
          case "folder.move": {
            yield* requireSpace(update.spaceId);
            let moved = false;
            for (const id of new Set(
              "folderIds" in update ? update.folderIds : [update.folderId],
            )) {
              const row = folders.find((row) => row.id === id);
              if (!row) return yield* fail(`Folder '${id}' is not available.`);
              if (
                row.deletedAt !== null ||
                (row.spaceId === update.spaceId && update.position === undefined)
              )
                continue;
              const changed = yield* moveFolder({
                folderId: id,
                spaceId: update.spaceId,
                position: update.position ?? { type: "end" },
                updatedAt: now,
              });
              moved ||= changed.folderIds.length > 0;
              changedThreadIds.push(...changed.threadIds);
            }
            if (!moved && update.position === undefined)
              return yield* fail("None of the selected folders need to be assigned to this space.");
            break;
          }
          case "space.move": {
            yield* requireSpace(update.spaceId);
            yield* moveSpace({
              spaceId: update.spaceId,
              position: update.position,
              updatedAt: now,
            });
            break;
          }
          case "folder.delete": {
            yield* requireFolder(update.folderId);
            const [count] = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM threads WHERE folder_id=${update.folderId} AND deleted_at IS NULL`;
            if (count!.count > 0)
              return yield* fail(
                `Folder '${update.folderId}' still has ${count!.count} threads and cannot be deleted.`,
              );
            yield* sql`UPDATE projection_folders SET deleted_at=${now},updated_at=${now} WHERE folder_id=${update.folderId}`;
            break;
          }
        }
        return { navigation: yield* readNavigation, changedThreadIds };
      }),
    );
    publisher.publishSidebar({ kind: "navigation" });
    for (const threadId of result.changedThreadIds) publisher.publish({ threadId });
    return result.navigation;
  });

/** Tombstones count as history: deleting defaults never makes a database new. */
export const ensureDefaultSpaces = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM projection_spaces`;
      if (row!.count !== 0) return;
      const createdAt = new Date().toISOString();
      for (const [id, name, icon, order] of [
        ["penkra-personal", "Personal", "home", 0],
        ["penkra-work", "Work", "bag", 1],
      ] as const) {
        yield* sql`INSERT INTO projection_spaces (space_id,name,icon,sort_order,created_at,updated_at) VALUES (${id},${name},${icon},${order},${createdAt},${createdAt})`;
        yield* sql`INSERT INTO projection_folders (folder_id,kind,title,space_id,created_at,updated_at) VALUES (${`${id}-default`},'project','Default',${id},${createdAt},${createdAt})`;
      }
    }),
  );
});
