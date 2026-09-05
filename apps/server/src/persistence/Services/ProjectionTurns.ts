/**
 * ProjectionTurnRepository - Projection repository interface for unified turn state.
 *
 * Owns persistence operations for pending starts, running/completed turn lifecycle,
 * in a single projection table.
 *
 * @module ProjectionTurnRepository
 */
import { IsoDateTime, MessageId, ThreadId, TurnId } from "@penkra/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTurnState = Schema.Literals([
  "queued",
  "running",
  "interrupted",
  "completed",
  "error",
  "cancelled",
]);
export type ProjectionTurnState = typeof ProjectionTurnState.Type;

export const ProjectionTurn = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  providerTurnId: Schema.NullOr(TurnId),
  pendingMessageId: Schema.NullOr(MessageId),
  assistantMessageId: Schema.NullOr(MessageId),
  state: ProjectionTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTurn = typeof ProjectionTurn.Type;

export const ProjectionTurnById = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  providerTurnId: Schema.NullOr(TurnId),
  pendingMessageId: Schema.NullOr(MessageId),
  assistantMessageId: Schema.NullOr(MessageId),
  state: ProjectionTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTurnById = typeof ProjectionTurnById.Type;

export const ProjectionUnboundTurnStart = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  messageId: MessageId,
  requestedAt: IsoDateTime,
});
export type ProjectionUnboundTurnStart = typeof ProjectionUnboundTurnStart.Type;

export const ListProjectionTurnsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionTurnsByThreadInput = typeof ListProjectionTurnsByThreadInput.Type;

export const GetProjectionTurnByTurnIdInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type GetProjectionTurnByTurnIdInput = typeof GetProjectionTurnByTurnIdInput.Type;

export const ProjectionTurnIdentityInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type ProjectionTurnIdentityInput = typeof ProjectionTurnIdentityInput.Type;

export interface ProjectionTurnWaitSnapshot {
  readonly existingThreadIds: ReadonlyArray<GetProjectionTurnByTurnIdInput["threadId"]>;
  readonly turns: ReadonlyArray<{
    readonly threadId: GetProjectionTurnByTurnIdInput["threadId"];
    readonly turnId: GetProjectionTurnByTurnIdInput["turnId"];
    readonly assistantMessageId: MessageId | null;
    readonly state: ProjectionTurnState;
  }>;
}

export const GetProjectionUnboundTurnStartInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionUnboundTurnStartInput = typeof GetProjectionUnboundTurnStartInput.Type;

export const DeleteProjectionTurnsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionTurnsByThreadInput = typeof DeleteProjectionTurnsByThreadInput.Type;

export interface ProjectionTurnRepositoryShape {
  /**
   * Inserts or updates the canonical row for a concrete `{threadId, turnId}` turn lifecycle state.
   */
  readonly upsertByTurnId: (
    row: ProjectionTurnById,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Reopens one interrupted logical turn for an invisible restart continuation. */
  readonly reopenForRestart: (
    input: ProjectionTurnIdentityInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Lists every provider-native turn identity that has carried this logical turn. */
  readonly listProviderTurnIds: (
    input: ProjectionTurnIdentityInput,
  ) => Effect.Effect<ReadonlyArray<TurnId>, ProjectionRepositoryError>;

  /** Returns the newest admitted start that has not received a provider turn id. */
  readonly getUnboundTurnStartByThreadId: (
    input: GetProjectionUnboundTurnStartInput,
  ) => Effect.Effect<Option.Option<ProjectionUnboundTurnStart>, ProjectionRepositoryError>;

  /**
   * Lists all projection rows for a thread.
   */
  readonly listByThreadId: (
    input: ListProjectionTurnsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurn>, ProjectionRepositoryError>;

  /** Lists canonical turn rows for several threads in one query. */
  readonly listByThreadIds: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurn>, ProjectionRepositoryError>;

  /**
   * Looks up a turn row by its Penkra-owned `{threadId, turnId}` identity.
   */
  readonly getByTurnId: (
    input: GetProjectionTurnByTurnIdInput,
  ) => Effect.Effect<Option.Option<ProjectionTurnById>, ProjectionRepositoryError>;

  /** Batch lookup used by long-poll status readers to avoid one query per turn. */
  readonly getManyByTurnId: (
    input: ReadonlyArray<GetProjectionTurnByTurnIdInput>,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurnById>, ProjectionRepositoryError>;

  /** One lightweight query for pinned turn states plus current thread existence. */
  readonly getManyWaitSnapshot: (input: {
    readonly threadIds: ReadonlyArray<GetProjectionTurnByTurnIdInput["threadId"]>;
    readonly turns: ReadonlyArray<GetProjectionTurnByTurnIdInput>;
  }) => Effect.Effect<ProjectionTurnWaitSnapshot, ProjectionRepositoryError>;

  /**
   * Hard-deletes all projection rows for a thread, including pending-start placeholders.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionTurnsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionTurnRepository extends ServiceMap.Service<
  ProjectionTurnRepository,
  ProjectionTurnRepositoryShape
>()("penkra/persistence/Services/ProjectionTurns/ProjectionTurnRepository") {}
