import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";

import { ModelSelection, ProjectScript } from "@penkra/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionFolderInput,
  GetProjectionFolderInput,
  ProjectionFolder,
  ProjectionFolderRepository,
  type ProjectionFolderRepositoryShape,
} from "../Services/ProjectionFolders.ts";

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== 0),
    encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
  }),
);

const ProjectionFolderDbRow = ProjectionFolder.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
    isPinned: SqliteBoolean,
  }),
);
type ProjectionFolderDbRow = typeof ProjectionFolderDbRow.Type;

const makeProjectionFolderRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionFolderRow = SqlSchema.void({
    Request: ProjectionFolder,
    execute: (row) =>
      sql`
        INSERT INTO projection_folders (
          folder_id,
          kind,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          icon_data_url,
          is_pinned,
          space_id,
          sidebar_sort_order,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          ${row.folderId},
          'project',
          ${row.title},
          ${row.workspaceRoot},
          ${row.defaultModelSelection !== null ? JSON.stringify(row.defaultModelSelection) : null},
          ${JSON.stringify(row.scripts)},
          ${row.iconDataUrl ?? null},
          ${row.isPinned ? 1 : 0},
          ${row.spaceId},
          ${row.sidebarSortOrder ?? 0},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt ?? null},
          ${row.deletedAt}
        )
        ON CONFLICT (folder_id)
        DO UPDATE SET
          title = excluded.title,
          workspace_root = excluded.workspace_root,
          default_model_selection_json = excluded.default_model_selection_json,
          scripts_json = excluded.scripts_json,
          icon_data_url = excluded.icon_data_url,
          is_pinned = excluded.is_pinned,
          space_id = excluded.space_id,
          sidebar_sort_order = excluded.sidebar_sort_order,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionFolderRow = SqlSchema.findOneOption({
    Request: GetProjectionFolderInput,
    Result: ProjectionFolderDbRow,
    execute: ({ folderId }) =>
      sql`
        SELECT
          folder_id AS "folderId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          icon_data_url AS "iconDataUrl",
          is_pinned AS "isPinned",
          COALESCE(space_id, 'penkra-personal') AS "spaceId",
          sidebar_sort_order AS "sidebarSortOrder",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_folders
        WHERE folder_id = ${folderId}
      `,
  });

  const listProjectionFolderRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionFolderDbRow,
    execute: () =>
      sql`
        SELECT
          folder_id AS "folderId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          icon_data_url AS "iconDataUrl",
          is_pinned AS "isPinned",
          COALESCE(space_id, 'penkra-personal') AS "spaceId",
          sidebar_sort_order AS "sidebarSortOrder",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_folders
        ORDER BY created_at ASC, folder_id ASC
      `,
  });

  const deleteProjectionFolderRow = SqlSchema.void({
    Request: DeleteProjectionFolderInput,
    execute: ({ folderId }) =>
      sql`
        DELETE FROM projection_folders
        WHERE folder_id = ${folderId}
      `,
  });

  const upsert: ProjectionFolderRepositoryShape["upsert"] = (row) =>
    upsertProjectionFolderRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionFolderRepository.upsert:query")),
    );

  const getById: ProjectionFolderRepositoryShape["getById"] = (input) =>
    getProjectionFolderRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionFolderRepository.getById:query")),
    );

  const listAll: ProjectionFolderRepositoryShape["listAll"] = () =>
    listProjectionFolderRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionFolderRepository.listAll:query")),
    );

  const deleteById: ProjectionFolderRepositoryShape["deleteById"] = (input) =>
    deleteProjectionFolderRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionFolderRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
  } satisfies ProjectionFolderRepositoryShape;
});

export const ProjectionFolderRepositoryLive = Layer.effect(
  ProjectionFolderRepository,
  makeProjectionFolderRepository,
);
