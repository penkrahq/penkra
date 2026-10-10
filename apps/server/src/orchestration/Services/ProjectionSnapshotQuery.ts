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
  OrchestrationGetPendingStartOutcomeInput,
  OrchestrationGetPendingStartOutcomeResult,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProviderKind,
  FolderId,
  MessageId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export type ProjectionTranscriptSearchOrder = "recent" | "oldest";

export interface ProjectionTranscriptSearchAnchor {
  readonly createdAt: string;
  readonly threadId: string;
  readonly messageId: string;
}

export interface ProjectionTranscriptSearchInput {
  readonly spaceId: SpaceId;
  readonly folderId: FolderId | null;
  readonly threadId: ThreadId | null;
  readonly queries: ReadonlyArray<string>;
  readonly queryMode: "any" | "all";
  readonly roles?: ReadonlyArray<string>;
  readonly turnId?: TurnId;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly order: ProjectionTranscriptSearchOrder;
  readonly anchor?: ProjectionTranscriptSearchAnchor;
  readonly limit: number;
}

export interface ProjectionTranscriptSearchMessage {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly turnId: TurnId | null;
  readonly role: string;
  readonly threadTitle: string;
  readonly threadProvider: ProviderKind;
  readonly text: string;
  readonly createdAt: string;
}

export interface ProjectionTranscriptSearchResult {
  readonly messages: ReadonlyArray<ProjectionTranscriptSearchMessage>;
  readonly hasMore: boolean;
  readonly path: "indexed" | "short-query-fallback";
}

export interface ProjectionThreadMessageContextInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly beforeTurns: number;
  readonly afterTurns: number;
}

export interface ProjectionSnapshotCounts {
  readonly folderCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
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

export interface ProjectionFolderPageCursor {
  readonly createdAt: string;
  readonly folderId: FolderId;
}

export interface ProjectionThreadShellPageInput {
  readonly spaceId: SpaceId;
  readonly threadIds: ReadonlyArray<string> | null;
  readonly folderId: string | null;
  readonly parentThreadId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly createdBy: string | null;
  readonly updatedAfter: string | null;
  readonly updatedBefore: string | null;
  readonly titleContains: string | null;
  readonly status: string | null;
  readonly includeArchived: boolean;
  readonly after: { readonly updatedAt: string; readonly threadId: string } | null;
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

  readonly listFolderShellPage: (after: ProjectionFolderPageCursor | null) => Effect.Effect<
    {
      readonly folders: ReadonlyArray<
        OrchestrationFolderShell & { readonly spaceTitle: string | null }
      >;
      readonly nextCursor: ProjectionFolderPageCursor | null;
    },
    ProjectionRepositoryError
  >;

  readonly listThreadShellPage: (input: ProjectionThreadShellPageInput) => Effect.Effect<
    {
      readonly threads: ReadonlyArray<OrchestrationThreadShell>;
      readonly nextCursor: ProjectionThreadShellPageInput["after"];
    },
    ProjectionRepositoryError
  >;

  /** Indexed existence check retaining provider-update session admission rules. */
  readonly hasActiveProviderThread: (
    provider: ProviderKind,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /** Read aggregate projection counts without hydrating the full read model. */
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

  /** Count the complete durable message projection for one Thread. */
  readonly countThreadMessages?: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /** Indexed, deterministic literal search over projected message text. */
  readonly searchThreadMessages: (
    input: ProjectionTranscriptSearchInput,
  ) => Effect.Effect<ProjectionTranscriptSearchResult, ProjectionRepositoryError>;

  /** Read complete transcript rows surrounding the turn that owns one message. */
  readonly getThreadMessageContext: (
    input: ProjectionThreadMessageContextInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationGetThreadTurnsPageResult>,
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

  /** Read up to THREADS_PAGE_SIZE active (not archived, not deleted) folder shell rows by id in one SELECT; rejects larger batches. */
  readonly getFolderShellsByIds: (
    folderIds: ReadonlyArray<FolderId>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationFolderShell>, ProjectionRepositoryError>;
  /** Read a single active folder shell row by id. */
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
  readonly getPendingStartOutcome: (
    input: OrchestrationGetPendingStartOutcomeInput,
  ) => Effect.Effect<OrchestrationGetPendingStartOutcomeResult, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends ServiceMap.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("penkra/orchestration/Services/ProjectionSnapshotQuery") {}
