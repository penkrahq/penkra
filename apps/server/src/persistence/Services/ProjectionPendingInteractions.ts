/** Durable settlement authority shared by approvals and structured user input. */
import {
  CommandId,
  IsoDateTime,
  ProjectionPendingInteractionKind,
  ProjectionPendingInteractionStatus,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@penkra/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionPendingInteraction = Schema.Struct({
  interactionKind: ProjectionPendingInteractionKind,
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  lifecycleGeneration: Schema.NullOr(Schema.String),
  status: ProjectionPendingInteractionStatus,
  responseCommandId: Schema.NullOr(CommandId),
  responseRequestedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionPendingInteraction = typeof ProjectionPendingInteraction.Type;

export const ListProjectionPendingInteractionsInput = Schema.Struct({
  threadId: ThreadId,
});

export const GetProjectionPendingInteractionInput = Schema.Struct({
  threadId: ThreadId,
  interactionKind: ProjectionPendingInteractionKind,
  requestId: TrimmedNonEmptyString,
});

export const DeleteProjectionPendingInteractionInput = GetProjectionPendingInteractionInput;

export interface ProjectionPendingInteractionRepositoryShape {
  readonly upsert: (
    row: ProjectionPendingInteraction,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: typeof ListProjectionPendingInteractionsInput.Type,
  ) => Effect.Effect<ReadonlyArray<ProjectionPendingInteraction>, ProjectionRepositoryError>;
  /** Every interaction that still projects as unresolved across a process boundary. */
  readonly listUnresolved: () => Effect.Effect<
    ReadonlyArray<ProjectionPendingInteraction>,
    ProjectionRepositoryError
  >;
  readonly getByIdentity: (
    input: typeof GetProjectionPendingInteractionInput.Type,
  ) => Effect.Effect<Option.Option<ProjectionPendingInteraction>, ProjectionRepositoryError>;
  readonly deleteByIdentity: (
    input: typeof DeleteProjectionPendingInteractionInput.Type,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionPendingInteractionRepository extends ServiceMap.Service<
  ProjectionPendingInteractionRepository,
  ProjectionPendingInteractionRepositoryShape
>()(
  "penkra/persistence/Services/ProjectionPendingInteractions/ProjectionPendingInteractionRepository",
) {}
