/** Durable projection repository for custom Spaces. Void remains virtual (`spaceId = null`). */
import { IsoDateTime, NonNegativeInt, SpaceIconName, SpaceId, SpaceName } from "@penkra/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionSpace = Schema.Struct({
  spaceId: SpaceId,
  name: SpaceName,
  icon: SpaceIconName,
  sortOrder: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionSpace = typeof ProjectionSpace.Type;

export const GetProjectionSpaceInput = Schema.Struct({ spaceId: SpaceId });
export type GetProjectionSpaceInput = typeof GetProjectionSpaceInput.Type;

export interface ProjectionSpaceRepositoryShape {
  readonly upsert: (row: ProjectionSpace) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionSpaceInput,
  ) => Effect.Effect<Option.Option<ProjectionSpace>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionSpace>, ProjectionRepositoryError>;
}

export class ProjectionSpaceRepository extends ServiceMap.Service<
  ProjectionSpaceRepository,
  ProjectionSpaceRepositoryShape
>()("penkra/persistence/Services/ProjectionSpaces/ProjectionSpaceRepository") {}
