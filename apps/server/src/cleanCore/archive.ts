// FILE: archive.ts
// Purpose: Archive navigation, indexed chat pages, and single-chat restoration.
import type {
  CleanCoreArchivedChat,
  CleanCoreListArchivedNavigationResult,
  CleanCoreListArchivedThreadsInput,
  CleanCoreRestoreThreadInput,
} from "@penkra/contracts";
import { THREADS_PAGE_SIZE } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { archivedDaysRemainingSql } from "../threadRetention.ts";

export const listArchivedNavigation = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const spaces = yield* sql<CleanCoreListArchivedNavigationResult["spaces"][number]>`
    SELECT s.space_id AS id, s.name, s.archived_at AS "archivedAt",
      (SELECT COUNT(*) FROM projection_folders f WHERE f.space_id = s.space_id AND f.deleted_at IS NULL) AS folders,
      (SELECT COUNT(*) FROM threads t WHERE t.space_id = s.space_id AND t.deleted_at IS NULL) AS chats
    FROM projection_spaces s WHERE s.archived_at IS NOT NULL AND s.deleted_at IS NULL
    ORDER BY s.archived_at DESC, s.space_id`;
    const folders = yield* sql<CleanCoreListArchivedNavigationResult["folders"][number]>`
    SELECT f.folder_id AS id, f.title AS name, s.name AS space, f.archived_at AS "archivedAt", f.icon_data_url AS "iconDataUrl",
      (SELECT COUNT(*) FROM threads t WHERE t.folder_id = f.folder_id AND t.deleted_at IS NULL) AS chats
    FROM projection_folders f JOIN projection_spaces s ON s.space_id = f.space_id
    WHERE f.archived_at IS NOT NULL AND f.deleted_at IS NULL AND s.deleted_at IS NULL
    ORDER BY f.archived_at DESC, f.folder_id`;
    const count = yield* sql<{
      total: number;
    }>`SELECT COUNT(*) AS total FROM threads t JOIN projection_folders f ON f.folder_id=t.folder_id JOIN projection_spaces s ON s.space_id=t.space_id WHERE t.archived_at IS NOT NULL AND t.deleted_at IS NULL AND f.deleted_at IS NULL AND s.deleted_at IS NULL`;
    return { spaces, folders, totalChats: count[0]!.total };
  });

export const buildArchivedThreadsQuery = (input: CleanCoreListArchivedThreadsInput) => ({
  sql: `SELECT t.id, t.folder_id AS "folderId", t.space_id AS "spaceId", t.title, t.provider, ${archivedDaysRemainingSql("t.archived_at")} AS "deletesInActiveDays",
    t.archived_at AS "archivedAt", f.title AS folder, s.name AS space,
    (f.archived_at IS NOT NULL) AS "restoresFolder", (s.archived_at IS NOT NULL) AS "restoresSpace"
    FROM threads t INDEXED BY idx_threads_archived JOIN projection_folders f ON f.folder_id = t.folder_id JOIN projection_spaces s ON s.space_id = t.space_id
    WHERE t.deleted_at IS NULL AND t.archived_at IS NOT NULL AND f.deleted_at IS NULL AND s.deleted_at IS NULL
    ${input.cursor === null ? "" : "AND (t.archived_at, t.id) < (?, ?)"}
    ORDER BY t.archived_at DESC, t.id DESC LIMIT ?`,
  params:
    input.cursor === null
      ? [THREADS_PAGE_SIZE + 1]
      : [input.cursor.archivedAt, input.cursor.id, THREADS_PAGE_SIZE + 1],
});
export const listArchivedThreads = (input: CleanCoreListArchivedThreadsInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = buildArchivedThreadsQuery(input);
    const rows = yield* sql.unsafe<
      Omit<CleanCoreArchivedChat, "restoresFolder" | "restoresSpace"> & {
        restoresFolder: number;
        restoresSpace: number;
      }
    >(query.sql, query.params);
    const threads = rows.slice(0, THREADS_PAGE_SIZE).map((row) => ({
      ...row,
      restoresFolder: row.restoresFolder !== 0,
      restoresSpace: row.restoresSpace !== 0,
    }));
    const last = threads.at(-1);
    return {
      threads,
      nextCursor:
        rows.length > THREADS_PAGE_SIZE && last !== undefined
          ? { archivedAt: last.archivedAt, id: last.id }
          : null,
    };
  });

export const restoreThread = (input: CleanCoreRestoreThreadInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`UPDATE threads SET archived_at=NULL, updated_at=${input.updatedAt} WHERE id=${input.threadId} AND deleted_at IS NULL AND archived_at IS NOT NULL RETURNING id`;
    return rows.length !== 0;
  });
