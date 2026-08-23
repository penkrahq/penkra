/**
 * ProjectionFolderRepository - Projection repository interface for folders.
 *
 * Owns persistence operations for project rows in the orchestration projection
 * read model.
 *
 * @module ProjectionFolderRepository
 */
import {
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  FolderId,
  ProjectScript,
  SpaceId,
} from "@penkra/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionFolder = Schema.Struct({
  folderId: FolderId,
  title: Schema.String,
  workspaceRoot: Schema.NullOr(Schema.String),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  iconDataUrl: Schema.optional(Schema.NullOr(Schema.String)),
  isPinned: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  spaceId: SpaceId,
  sidebarSortOrder: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionFolder = typeof ProjectionFolder.Type;

export const GetProjectionFolderInput = Schema.Struct({
  folderId: FolderId,
});
export type GetProjectionFolderInput = typeof GetProjectionFolderInput.Type;

export const DeleteProjectionFolderInput = Schema.Struct({
  folderId: FolderId,
});
export type DeleteProjectionFolderInput = typeof DeleteProjectionFolderInput.Type;

/**
 * ProjectionFolderRepositoryShape - Service API for projected project records.
 */
export interface ProjectionFolderRepositoryShape {
  /**
   * Insert or replace a projected project row.
   *
   * Upserts by `folderId` and persists scripts through JSON encoding.
   */
  readonly upsert: (row: ProjectionFolder) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected project row by id.
   */
  readonly getById: (
    input: GetProjectionFolderInput,
  ) => Effect.Effect<Option.Option<ProjectionFolder>, ProjectionRepositoryError>;

  /**
   * List all projected project rows.
   *
   * Returned in deterministic creation order.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionFolder>, ProjectionRepositoryError>;

  /**
   * Soft-delete a projected project row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionFolderInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionFolderRepository - Service tag for project projection persistence.
 */
export class ProjectionFolderRepository extends ServiceMap.Service<
  ProjectionFolderRepository,
  ProjectionFolderRepositoryShape
>()("penkra/persistence/Services/ProjectionFolders/ProjectionFolderRepository") {}
