/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  OrchestrationFolder,
  OrchestrationFolderShell,
  OrchestrationSpaceShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  OrchestrationGetThreadTurnsPageInput,
  OrchestrationGetThreadTurnsPageResult,
  OrchestrationThread,
  OrchestrationThreadShell,
  FolderId,
  MessageId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly folderCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionGeneratedImageActivityRecord {
  readonly kind: string;
  readonly payload: unknown;
}

export interface ProjectionOpenTurnCount {
  readonly threadId: ThreadId;
  readonly count: number;
}

export interface ProjectionStreamingAssistantMessage {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly turnId: TurnId | null;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Find only stale threads whose projected session/turn still appears in
   * flight. Used by the runtime reconciler to avoid hydrating the full shell
   * snapshot on every polling interval.
   */
  readonly listStaleInFlightThreadIds: (input: {
    readonly updatedBefore: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;

  /** Count every non-terminal turn per thread for restart-time settlement. */
  readonly listOpenTurnCounts: () => Effect.Effect<
    ReadonlyArray<ProjectionOpenTurnCount>,
    ProjectionRepositoryError
  >;

  /** Exact assistant messages whose producer cannot survive a server restart. */
  readonly listStreamingAssistantMessages: () => Effect.Effect<
    ReadonlyArray<ProjectionStreamingAssistantMessage>,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only folder rows plus thread shell summaries so clients can
   * bootstrap navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read the active folder for an exact workspace root match.
   */
  readonly getActiveFolderByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationFolder>, ProjectionRepositoryError>;

  /**
   * Read a single active folder shell row by id.
   */
  readonly getFolderShellById: (
    folderId: FolderId,
  ) => Effect.Effect<Option.Option<OrchestrationFolderShell>, ProjectionRepositoryError>;

  /** Read a single active custom space shell row by id. */
  readonly getSpaceShellById: (
    spaceId: SpaceId,
  ) => Effect.Effect<Option.Option<OrchestrationSpaceShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a folder.
   */
  readonly getFirstActiveThreadIdByFolderId: (
    folderId: FolderId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the durable generated-image records for one turn. This narrow query is
   * intentionally independent of the bounded thread-detail activity window so
   * long turns and server restarts can still materialize transcript references.
   */
  readonly listGeneratedImageActivitiesByTurn: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionGeneratedImageActivityRecord>,
    ProjectionRepositoryError
  >;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Recover the parent thread for legacy synthetic subagent IDs.
   */
  readonly findSyntheticSubagentParentThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id with the full message history.
   */
  readonly getThreadDetailForExportById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot and its projection cursor in one transaction.
   */
  readonly getThreadDetailSnapshotById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;

  /** Read one cursor page of complete turns for transcript history. */
  readonly getThreadTurnsPage: (
    input: OrchestrationGetThreadTurnsPageInput,
  ) => Effect.Effect<OrchestrationGetThreadTurnsPageResult, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends ServiceMap.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("penkra/orchestration/Services/ProjectionSnapshotQuery") {}
