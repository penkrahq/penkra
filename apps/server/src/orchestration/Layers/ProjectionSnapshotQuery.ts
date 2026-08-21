import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ORCHESTRATION_THREAD_HYDRATION_LIMITS,
  OrchestrationPendingInteraction,
  OrchestrationProjectShell,
  OrchestrationSpaceShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ThreadPinnedMessages,
  ThreadMarkers,
  ProjectScript,
  ContainerId,
  ContainerKind,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProject,
  type OrchestrationSession,
  OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestrationThreadActivity,
  ModelSelection,
} from "@penkra/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlOrDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { normalizePersistedModelSelection } from "../../persistence/modelSelectionCompatibility.ts";
import { deriveThreadSummaryMetadata } from "@penkra/shared/threadSummary";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionSpace } from "../../persistence/Services/ProjectionSpaces.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  ProjectionThreadMessageDbRowSchema,
  orchestrationMessageFromProjectionRow,
  type ProjectionThreadMessageDbRow,
} from "../../persistence/projectionThreadMessageRow.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionGeneratedImageActivityRecord,
  type ProjectionOpenTurnCount,
  type ProjectionSnapshotCounts,
  type ProjectionSnapshotSequence,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);
const decodeThreadDetail = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeThreadDetailSnapshot = Schema.decodeUnknownEffect(OrchestrationThreadDetailSnapshot);
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const ModelSelectionJsonUnknown = Schema.fromJsonString(Schema.Unknown);
const MAX_THREAD_MESSAGES = ORCHESTRATION_THREAD_HYDRATION_LIMITS.messages;
// Bulk read-model snapshot: stays aligned with the in-memory projector window
// (`orchestration/projector.ts`), which trims every live thread to the same cap.
const MAX_SNAPSHOT_THREAD_ACTIVITIES = ORCHESTRATION_THREAD_HYDRATION_LIMITS.summaryActivities;
// A single opened thread keeps a much deeper window: providers emit hundreds of
// activity rows per turn, so a 500-row tail dropped the previous turns' work log.
const MAX_THREAD_DETAIL_ACTIVITIES = ORCHESTRATION_THREAD_HYDRATION_LIMITS.detailActivities;
const MAX_TURN_GENERATED_IMAGE_ACTIVITY_RECORDS = 64;
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(ModelSelectionJsonUnknown),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
    isPinned: Schema.Number,
  }),
);
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    isPinned: Schema.Number,
    pinnedMessages: Schema.NullOr(Schema.fromJsonString(ThreadPinnedMessages)),
    threadMarkers: Schema.NullOr(Schema.fromJsonString(ThreadMarkers)),
    modelSelection: ModelSelectionJsonUnknown,
  }),
);
const {
  pinnedMessages: _projectionThreadPinnedMessagesField,
  threadMarkers: _projectionThreadMarkersField,
  notes: _projectionThreadNotesField,
  ...ProjectionThreadShellFields
} = ProjectionThread.fields;
const ProjectionThreadShellDbRowSchema = Schema.Struct(ProjectionThreadShellFields).mapFields(
  Struct.assign({
    isPinned: Schema.Number,
    modelSelection: ModelSelectionJsonUnknown,
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
type PendingInteractionRow = typeof OrchestrationPendingInteraction.Type;
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionGeneratedImageActivityDbRowSchema = Schema.Struct({
  kind: Schema.String,
  payload: Schema.fromJsonString(Schema.Unknown),
});
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
});
const ProjectionPendingTurnStartDbRowSchema = Schema.Struct({
  messageId: MessageId,
});
const ProjectionOpenTurnCountRowSchema = Schema.Struct({
  threadId: ThreadId,
  count: NonNegativeInt,
});
const ProjectionQueuedMessageDbRowSchema = Schema.Struct({
  messageId: MessageId,
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ContainerId,
});
const SpaceIdLookupInput = Schema.Struct({
  spaceId: SpaceId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const StaleInFlightThreadLookupInput = Schema.Struct({
  updatedBefore: IsoDateTime,
  limit: Schema.Number,
});
const ThreadTurnLookupInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
const ThreadMessagesByThreadLookupInput = Schema.Struct({
  threadId: ThreadId,
  maxMessages: Schema.NullOr(Schema.Number),
});
const SyntheticSubagentParentLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});

type ProjectionThreadDbRowRaw = Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>;
type ProjectionThreadShellDbRowRaw = Schema.Schema.Type<typeof ProjectionThreadShellDbRowSchema>;
type ProjectionProjectDbRowRaw = Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>;
type ProjectionSpaceDbRow = Schema.Schema.Type<typeof ProjectionSpace>;
type ProjectionThreadDbRow = Omit<ProjectionThreadDbRowRaw, "modelSelection"> & {
  readonly modelSelection: typeof ModelSelection.Type;
};
type ProjectionThreadShellDbRow = Omit<ProjectionThreadShellDbRowRaw, "modelSelection"> & {
  readonly modelSelection: typeof ModelSelection.Type;
};
type ProjectionProjectDbRow = Omit<ProjectionProjectDbRowRaw, "defaultModelSelection"> & {
  readonly defaultModelSelection: typeof ModelSelection.Type | null;
};
type ProjectionThreadActivityDbRow = Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>;
type ProjectionLatestTurnDbRow = Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>;
type ProjectionThreadSessionDbRow = Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>;
type ProjectionStateDbRow = Schema.Schema.Type<typeof ProjectionStateDbRowSchema>;

function decodeProjectionProjectRow(
  row: ProjectionProjectDbRowRaw,
): Effect.Effect<ProjectionProjectDbRow, Schema.SchemaError> {
  if (row.defaultModelSelection === null) {
    return Effect.succeed({ ...row, defaultModelSelection: null });
  }
  return decodeModelSelection(normalizePersistedModelSelection(row.defaultModelSelection)).pipe(
    Effect.map((defaultModelSelection) => ({ ...row, defaultModelSelection })),
  );
}

function decodeProjectionThreadRow(
  row: ProjectionThreadDbRowRaw,
): Effect.Effect<ProjectionThreadDbRow, Schema.SchemaError> {
  return decodeModelSelection(normalizePersistedModelSelection(row.modelSelection)).pipe(
    Effect.map((modelSelection) => ({ ...row, modelSelection })),
  );
}

function decodeProjectionThreadShellRow(
  row: ProjectionThreadShellDbRowRaw,
): Effect.Effect<ProjectionThreadShellDbRow, Schema.SchemaError> {
  return decodeModelSelection(normalizePersistedModelSelection(row.modelSelection)).pipe(
    Effect.map((modelSelection) => ({ ...row, modelSelection })),
  );
}

function decodeProjectionProjectRows(
  rows: ReadonlyArray<ProjectionProjectDbRowRaw>,
  operation: string,
): Effect.Effect<ReadonlyArray<ProjectionProjectDbRow>, ProjectionRepositoryError> {
  return Effect.forEach(rows, decodeProjectionProjectRow).pipe(
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

function decodeProjectionThreadRows(
  rows: ReadonlyArray<ProjectionThreadDbRowRaw>,
  operation: string,
): Effect.Effect<ReadonlyArray<ProjectionThreadDbRow>, ProjectionRepositoryError> {
  return Effect.forEach(rows, decodeProjectionThreadRow).pipe(
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

function decodeProjectionThreadShellRows(
  rows: ReadonlyArray<ProjectionThreadShellDbRowRaw>,
  operation: string,
): Effect.Effect<ReadonlyArray<ProjectionThreadShellDbRow>, ProjectionRepositoryError> {
  return Effect.forEach(rows, decodeProjectionThreadShellRow).pipe(
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

function decodeProjectionProjectOption(
  option: Option.Option<ProjectionProjectDbRowRaw>,
  operation: string,
): Effect.Effect<Option.Option<ProjectionProjectDbRow>, ProjectionRepositoryError> {
  if (Option.isNone(option)) {
    return Effect.succeed(Option.none());
  }
  return decodeProjectionProjectRow(option.value).pipe(
    Effect.map(Option.some),
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

function decodeProjectionThreadOption(
  option: Option.Option<ProjectionThreadDbRowRaw>,
  operation: string,
): Effect.Effect<Option.Option<ProjectionThreadDbRow>, ProjectionRepositoryError> {
  if (Option.isNone(option)) {
    return Effect.succeed(Option.none());
  }
  return decodeProjectionThreadRow(option.value).pipe(
    Effect.map(Option.some),
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.hot,
  ORCHESTRATION_PROJECTOR_NAMES.threadShellSummaries,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function maxOptionalIso(left: string | null, right: string | null | undefined): string | null {
  return right ? maxIso(left, right) : left;
}

function pushGrouped<T>(map: Map<string, T[]>, threadId: string, value: T): void {
  const existing = map.get(threadId);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(threadId, [value]);
}

function toProjectedActivity(row: ProjectionThreadActivityDbRow): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload as OrchestrationThreadActivity["payload"],
    turnId: row.turnId,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  };
}

function toProjectedLatestTurn(row: ProjectionLatestTurnDbRow): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
  };
}

function toProjectedSession(row: ProjectionThreadSessionDbRow): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function toProjectedProject(row: ProjectionProjectDbRow): OrchestrationProject {
  return {
    id: row.projectId,
    kind: row.kind,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    iconDataUrl: row.iconDataUrl ?? null,
    isPinned: row.isPinned > 0,
    spaceId: row.spaceId,
    sidebarSortOrder: row.sidebarSortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function toProjectedSpace(row: ProjectionSpaceDbRow) {
  return {
    id: row.spaceId,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
    deletedAt: row.deletedAt,
  } as const;
}

function toProjectedSpaceShell(row: ProjectionSpaceDbRow): OrchestrationSpaceShell {
  return {
    id: row.spaceId,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function collectBaseUpdatedAt(input: {
  readonly spaceRows: ReadonlyArray<ProjectionSpaceDbRow>;
  readonly projectRows: ReadonlyArray<ProjectionProjectDbRow>;
  readonly threadRows: ReadonlyArray<{ readonly updatedAt: string }>;
  readonly stateRows: ReadonlyArray<ProjectionStateDbRow>;
}): string | null {
  let updatedAt: string | null = null;
  for (const row of input.spaceRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of input.projectRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of input.threadRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of input.stateRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  return updatedAt;
}

function collectProjectedMessages(rows: ReadonlyArray<ProjectionThreadMessageDbRow>): {
  readonly byThread: Map<string, Array<OrchestrationMessage>>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, Array<OrchestrationMessage>>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
    pushGrouped(byThread, row.threadId, orchestrationMessageFromProjectionRow(row));
  }
  return { byThread, updatedAt };
}

function collectProjectedActivities(rows: ReadonlyArray<ProjectionThreadActivityDbRow>): {
  readonly byThread: Map<string, Array<OrchestrationThreadActivity>>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, Array<OrchestrationThreadActivity>>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.createdAt);
    pushGrouped(byThread, row.threadId, toProjectedActivity(row));
  }
  return { byThread, updatedAt };
}

function collectPendingInteractions(rows: ReadonlyArray<PendingInteractionRow>): {
  readonly byThread: Map<string, Array<PendingInteractionRow>>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, Array<PendingInteractionRow>>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.createdAt);
    updatedAt = maxOptionalIso(updatedAt, row.responseRequestedAt);
    updatedAt = maxOptionalIso(updatedAt, row.resolvedAt);
    pushGrouped(byThread, row.threadId, row);
  }
  return { byThread, updatedAt };
}

function collectProjectedLatestTurns(rows: ReadonlyArray<ProjectionLatestTurnDbRow>): {
  readonly byThread: Map<string, OrchestrationLatestTurn>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, OrchestrationLatestTurn>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.requestedAt);
    updatedAt = maxOptionalIso(updatedAt, row.startedAt);
    updatedAt = maxOptionalIso(updatedAt, row.completedAt);
    if (byThread.has(row.threadId)) {
      continue;
    }
    byThread.set(row.threadId, toProjectedLatestTurn(row));
  }
  return { byThread, updatedAt };
}

function collectProjectedSessions(rows: ReadonlyArray<ProjectionThreadSessionDbRow>): {
  readonly byThread: Map<string, OrchestrationSession>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, OrchestrationSession>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
    byThread.set(row.threadId, toProjectedSession(row));
  }
  return { byThread, updatedAt };
}

function toProjectedProjectShell(row: ProjectionProjectDbRow): OrchestrationProjectShell {
  return {
    id: row.projectId,
    kind: row.kind,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    iconDataUrl: row.iconDataUrl ?? null,
    isPinned: row.isPinned > 0,
    spaceId: row.spaceId,
    sidebarSortOrder: row.sidebarSortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProjectedThreadShellFromStoredSummary(input: {
  readonly threadRow: ProjectionThreadShellDbRow;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: OrchestrationSession | null;
}): OrchestrationThreadShell {
  const { threadRow } = input;
  return {
    id: threadRow.threadId,
    projectId: threadRow.projectId,
    spaceId: threadRow.spaceId ?? null,
    sidebarSortOrder: threadRow.sidebarSortOrder,
    title: threadRow.title,
    modelSelection: threadRow.modelSelection,
    runtimeMode: threadRow.runtimeMode,
    workingDirectory: threadRow.workingDirectory,
    isPinned: threadRow.isPinned > 0,
    parentThreadId: threadRow.parentThreadId ?? null,
    creationSource: threadRow.creationSource ?? null,
    sourceThreadId: threadRow.sourceThreadId ?? null,
    sourceTurnId: threadRow.sourceTurnId ?? null,
    gatewayOperationId: threadRow.gatewayOperationId ?? null,
    gatewayOperationIndex: threadRow.gatewayOperationIndex ?? null,
    subagentAgentId: threadRow.subagentAgentId ?? null,
    subagentNickname: threadRow.subagentNickname ?? null,
    subagentRole: threadRow.subagentRole ?? null,
    forkSourceThreadId: threadRow.forkSourceThreadId ?? null,
    latestTurn: input.latestTurn,
    latestUserMessageAt: threadRow.latestUserMessageAt,
    hasPendingApprovals: threadRow.pendingApprovalCount > 0,
    hasPendingUserInput: threadRow.pendingUserInputCount > 0,
    workStatus: threadRow.workStatus,
    lastMessagePreview: threadRow.lastMessagePreview,
    lastActivityAt: threadRow.lastActivityAt,
    createdAt: threadRow.createdAt,
    updatedAt: threadRow.updatedAt,
    archivedAt: threadRow.archivedAt ?? null,
    session: input.session,
  };
}

function toProjectedThread(input: {
  readonly threadRow: ProjectionThreadDbRow;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly pendingInteractions: ReadonlyArray<PendingInteractionRow>;
  readonly session: OrchestrationSession | null;
  readonly pendingTurnStartMessageId?: MessageId | null;
  readonly queuedMessageIds?: ReadonlyArray<MessageId>;
}): OrchestrationThread {
  const { threadRow } = input;
  const summary = deriveThreadSummaryMetadata(input);
  return {
    id: threadRow.threadId,
    projectId: threadRow.projectId,
    spaceId: threadRow.spaceId ?? null,
    sidebarSortOrder: threadRow.sidebarSortOrder,
    title: threadRow.title,
    modelSelection: threadRow.modelSelection,
    runtimeMode: threadRow.runtimeMode,
    workingDirectory: threadRow.workingDirectory,
    isPinned: threadRow.isPinned > 0,
    parentThreadId: threadRow.parentThreadId ?? null,
    creationSource: threadRow.creationSource ?? null,
    sourceThreadId: threadRow.sourceThreadId ?? null,
    sourceTurnId: threadRow.sourceTurnId ?? null,
    gatewayOperationId: threadRow.gatewayOperationId ?? null,
    gatewayOperationIndex: threadRow.gatewayOperationIndex ?? null,
    subagentAgentId: threadRow.subagentAgentId ?? null,
    subagentNickname: threadRow.subagentNickname ?? null,
    subagentRole: threadRow.subagentRole ?? null,
    forkSourceThreadId: threadRow.forkSourceThreadId,
    latestTurn: input.latestTurn,
    pendingTurnStartMessageId: input.pendingTurnStartMessageId ?? null,
    createdAt: threadRow.createdAt,
    updatedAt: threadRow.updatedAt,
    archivedAt: threadRow.archivedAt ?? null,
    deletedAt: threadRow.deletedAt,
    latestUserMessageAt: summary.latestUserMessageAt,
    hasPendingApprovals: summary.hasPendingApprovals,
    hasPendingUserInput: summary.hasPendingUserInput,
    workStatus: threadRow.workStatus,
    lastMessagePreview: threadRow.lastMessagePreview,
    lastActivityAt: threadRow.lastActivityAt,
    messages: input.messages,
    queuedMessageIds: input.queuedMessageIds ?? [],
    activities: input.activities,
    pendingInteractions: input.pendingInteractions,
    ...(threadRow.pinnedMessages !== null ? { pinnedMessages: threadRow.pinnedMessages } : {}),
    ...(threadRow.threadMarkers !== null ? { threadMarkers: threadRow.threadMarkers } : {}),
    ...(threadRow.notes !== null ? { notes: threadRow.notes } : {}),
    session: input.session,
  };
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Thread retention soft-deletes and never purges (see ThreadDeletionReactor), so the
  // projection tables keep every row of every deleted thread forever. `getSnapshot` is the
  // only reader that hydrates message/activity bodies for the whole database at once, and
  // every consumer of its read model drops soft-deleted threads before use. Ranking those
  // rows was therefore ~95% pure waste on a mature database.
  //
  // Filtering by thread removes whole `PARTITION BY thread_id` partitions, so the
  // ROW_NUMBER() ranks of the threads that survive are bit-for-bit unchanged.
  const liveThreadScope = sql`
    thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL)
  `;

  const listSpaceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionSpace,
    execute: () =>
      sql`
        SELECT
          space_id AS "spaceId",
          name,
          icon,
          sort_order AS "sortOrder",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_spaces
        ORDER BY sort_order ASC, space_id ASC
      `,
  });

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          icon_data_url AS "iconDataUrl",
          is_pinned AS "isPinned",
          sidebar_sort_order AS "sidebarSortOrder",
          space_id AS "spaceId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          space_id AS "spaceId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          working_directory AS "workingDirectory",
          is_pinned AS "isPinned",
          sidebar_sort_order AS "sidebarSortOrder",
          pinned_messages_json AS "pinnedMessages",
          thread_markers_json AS "threadMarkers",
          notes,
          parent_thread_id AS "parentThreadId",
          creation_source AS "creationSource",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          gateway_operation_id AS "gatewayOperationId",
          gateway_operation_index AS "gatewayOperationIndex",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          latest_turn_id AS "latestTurnId",
          latest_user_message_at AS "latestUserMessageAt",
          last_visited_at AS "lastVisitedAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          work_status AS "workStatus",
          last_message_preview AS "lastMessagePreview",
          last_activity_at AS "lastActivityAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listThreadShellRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadShellDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          space_id AS "spaceId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          working_directory AS "workingDirectory",
          is_pinned AS "isPinned",
          sidebar_sort_order AS "sidebarSortOrder",
          parent_thread_id AS "parentThreadId",
          creation_source AS "creationSource",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          gateway_operation_id AS "gatewayOperationId",
          gateway_operation_index AS "gatewayOperationIndex",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          latest_turn_id AS "latestTurnId",
          latest_user_message_at AS "latestUserMessageAt",
          last_visited_at AS "lastVisitedAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          work_status AS "workStatus",
          last_message_preview AS "lastMessagePreview",
          last_activity_at AS "lastActivityAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listStaleInFlightThreadIdRows = SqlSchema.findAll({
    Request: StaleInFlightThreadLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ updatedBefore, limit }) =>
      sql`
        SELECT threads.thread_id AS "threadId"
        FROM projection_threads AS threads
        -- LEFT, not INNER: a thread whose runtime binding row was already
        -- removed is exactly the thread most likely to be stuck running with
        -- nothing left to settle it. Archived threads are included for the same
        -- reason - archiving does not stop a turn.
        LEFT JOIN provider_session_runtime AS runtime
          ON runtime.thread_id = threads.thread_id
        LEFT JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        LEFT JOIN projection_turns AS latest_turn
          ON latest_turn.thread_id = threads.thread_id
         AND latest_turn.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND (
            (
              sessions.active_turn_id IS NOT NULL
              AND sessions.status <> 'error'
            )
            OR latest_turn.state = 'running'
            OR json_extract(runtime.runtime_payload_json, '$.activeTurnId') IS NOT NULL
          )
          -- Use the latest lifecycle or projected-output timestamp. Streaming
          -- output advances threads.updated_at even when the session row stays
          -- unchanged for the full turn.
          AND MAX(COALESCE(sessions.updated_at, threads.updated_at), threads.updated_at) <= ${updatedBefore}
        ORDER BY MAX(COALESCE(sessions.updated_at, threads.updated_at), threads.updated_at) ASC, threads.thread_id ASC
        LIMIT ${Math.max(1, Math.min(1_000, Math.floor(limit)))}
      `,
  });

  const listOpenTurnCountRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionOpenTurnCountRowSchema,
    execute: () =>
      sql`
        SELECT thread_id AS "threadId", COUNT(*) AS "count"
        FROM projection_turns
        WHERE state IN ('pending', 'running')
        GROUP BY thread_id
        ORDER BY thread_id ASC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          skills_json AS "skills",
          mentions_json AS "mentions",
          dispatch_mode AS "dispatchMode",
          dispatch_origin AS "dispatchOrigin",
          delivery_state AS "deliveryState",
          delivery_queued AS "deliveryQueued",
          delivery_sequence AS "deliverySequence",
          is_streaming AS "isStreaming",
          source,
          sequence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                message_id DESC
            ) AS message_rank
          FROM projection_thread_messages
          WHERE ${liveThreadScope}
        )
        WHERE message_rank <= ${MAX_THREAD_MESSAGES}
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          message_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                created_at DESC,
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                activity_id DESC
            ) AS activity_rank
          FROM thread_activities_read
          WHERE ${liveThreadScope}
        ) AS ranked
        WHERE activity_rank <= ${MAX_SNAPSHOT_THREAD_ACTIVITIES}
          OR (
            kind IN ('approval.requested', 'user-input.requested')
            AND json_extract(payload_json, '$.requestId') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM thread_activities_read AS later
              WHERE later.thread_id = ranked.thread_id
                AND json_extract(later.payload_json, '$.requestId') =
                  json_extract(ranked.payload_json, '$.requestId')
                AND (
                  (ranked.kind = 'approval.requested' AND later.kind = 'approval.resolved')
                  OR (
                    ranked.kind = 'approval.requested'
                    AND later.kind = 'provider.approval.respond.failed'
                    AND (
                      lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%stale pending approval request%'
                      OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%unknown pending approval request%'
                      OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%unknown pending permission request%'
                    )
                  )
                  OR (ranked.kind = 'user-input.requested' AND later.kind = 'user-input.resolved')
                  OR (
                    ranked.kind = 'user-input.requested'
                    AND later.kind = 'provider.user-input.respond.failed'
                    AND (
                      lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%stale pending user-input request%'
                      OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%unknown pending user-input request%'
                    )
                  )
                )
                AND (
                  later.created_at > ranked.created_at
                  OR (
                    later.created_at = ranked.created_at
                    AND CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END >
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                  )
                  OR (
                    later.created_at = ranked.created_at
                    AND CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    AND COALESCE(later.sequence, -1) > COALESCE(ranked.sequence, -1)
                  )
                  OR (
                    later.created_at = ranked.created_at
                    AND CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    AND COALESCE(later.sequence, -1) = COALESCE(ranked.sequence, -1)
                    AND later.activity_id > ranked.activity_id
                  )
                )
            )
          )
        ORDER BY
          thread_id ASC,
          created_at ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          activity_id ASC
      `,
  });

  const listPendingInteractionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OrchestrationPendingInteraction,
    execute: () => sql`
      SELECT
        interaction_kind AS "interactionKind",
        request_id AS "requestId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        lifecycle_generation AS "lifecycleGeneration",
        status,
        decision,
        response_command_id AS "responseCommandId",
        response_requested_at AS "responseRequestedAt",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt"
      FROM projection_pending_interactions
      WHERE status <> 'confirmed'
      ORDER BY thread_id ASC, created_at ASC, interaction_kind ASC, request_id ASC
    `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  // Cheap targeted reads avoid hydrating the full snapshot for startup and diff lookups.
  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          icon_data_url AS "iconDataUrl",
          is_pinned AS "isPinned",
          sidebar_sort_order AS "sidebarSortOrder",
          space_id AS "spaceId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY CASE kind WHEN 'project' THEN 0 ELSE 1 END, created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getSpaceRowById = SqlSchema.findOneOption({
    Request: SpaceIdLookupInput,
    Result: ProjectionSpace,
    execute: ({ spaceId }) =>
      sql`
        SELECT
          space_id AS "spaceId",
          name,
          icon,
          sort_order AS "sortOrder",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_spaces
        WHERE space_id = ${spaceId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          icon_data_url AS "iconDataUrl",
          is_pinned AS "isPinned",
          sidebar_sort_order AS "sidebarSortOrder",
          space_id AS "spaceId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          space_id AS "spaceId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          working_directory AS "workingDirectory",
          is_pinned AS "isPinned",
          sidebar_sort_order AS "sidebarSortOrder",
          pinned_messages_json AS "pinnedMessages",
          thread_markers_json AS "threadMarkers",
          notes,
          parent_thread_id AS "parentThreadId",
          creation_source AS "creationSource",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          gateway_operation_id AS "gatewayOperationId",
          gateway_operation_index AS "gatewayOperationIndex",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          latest_turn_id AS "latestTurnId",
          latest_user_message_at AS "latestUserMessageAt",
          last_visited_at AS "lastVisitedAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          work_status AS "workStatus",
          last_message_preview AS "lastMessagePreview",
          last_activity_at AS "lastActivityAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getSyntheticSubagentParentThreadRow = SqlSchema.findOneOption({
    Request: SyntheticSubagentParentLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          space_id AS "spaceId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          working_directory AS "workingDirectory",
          is_pinned AS "isPinned",
          sidebar_sort_order AS "sidebarSortOrder",
          pinned_messages_json AS "pinnedMessages",
          thread_markers_json AS "threadMarkers",
          notes,
          parent_thread_id AS "parentThreadId",
          creation_source AS "creationSource",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          gateway_operation_id AS "gatewayOperationId",
          gateway_operation_index AS "gatewayOperationIndex",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          latest_turn_id AS "latestTurnId",
          latest_user_message_at AS "latestUserMessageAt",
          last_visited_at AS "lastVisitedAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          work_status AS "workStatus",
          last_message_preview AS "lastMessagePreview",
          last_activity_at AS "lastActivityAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE ${threadId} LIKE ('subagent:' || thread_id || ':%')
          AND deleted_at IS NULL
        ORDER BY length(thread_id) DESC, created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadMessagesByThreadLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, maxMessages }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          skills_json AS "skills",
          mentions_json AS "mentions",
          dispatch_mode AS "dispatchMode",
          dispatch_origin AS "dispatchOrigin",
          delivery_state AS "deliveryState",
          delivery_queued AS "deliveryQueued",
          delivery_sequence AS "deliverySequence",
          is_streaming AS "isStreaming",
          source,
          sequence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                message_id DESC
            ) AS message_rank
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
        )
        WHERE thread_id = ${threadId}
          AND (${maxMessages} IS NULL OR message_rank <= ${maxMessages})
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          message_id ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH ranked AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                created_at DESC,
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                activity_id DESC
            ) AS activity_rank
          FROM thread_activities_read
          WHERE thread_id = ${threadId}
        ),
        window_boundary_turn AS (
          -- Turn-less activity (for example account/rate-limit metadata) is
          -- retained inside the raw row budget, but it never defines a turn
          -- boundary. Pick the oldest scoped turn represented in the window.
          SELECT
            turn_id AS boundary_turn_id,
            activity_rank AS boundary_activity_rank
          FROM ranked
          WHERE activity_rank <= ${MAX_THREAD_DETAIL_ACTIVITIES}
            AND turn_id IS NOT NULL
          ORDER BY activity_rank DESC
          LIMIT 1
        ),
        window_boundary_state AS (
          SELECT
            boundary_turn_id,
            boundary_activity_rank,
            EXISTS (
              SELECT 1
              FROM ranked
              WHERE activity_rank > ${MAX_THREAD_DETAIL_ACTIVITIES}
                AND turn_id = boundary_turn_id
            ) AS is_split,
            EXISTS (
              SELECT 1
              FROM ranked
              WHERE activity_rank < boundary_activity_rank
                AND turn_id IS NOT NULL
                AND turn_id <> boundary_turn_id
            ) AS has_newer_scoped_turn
          FROM window_boundary_turn
        )
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM ranked
        WHERE thread_id = ${threadId}
          AND (
            (
              activity_rank <= ${MAX_THREAD_DETAIL_ACTIVITIES}
              -- Drop a split oldest scoped turn instead of extending the query
              -- beyond its cap. Unscoped rows never masquerade as newer turns.
              -- If one turn fills the window, retain the raw capped tail so an
              -- oversized turn does not hide all activity.
              AND NOT (
                EXISTS (SELECT 1 FROM window_boundary_state)
                AND turn_id IS NOT NULL
                AND turn_id = (SELECT boundary_turn_id FROM window_boundary_state)
                AND (SELECT is_split FROM window_boundary_state)
                AND (SELECT has_newer_scoped_turn FROM window_boundary_state)
              )
            )
            OR (
              kind IN ('approval.requested', 'user-input.requested')
              AND json_extract(payload_json, '$.requestId') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM thread_activities_read AS later
                WHERE later.thread_id = ranked.thread_id
                  AND json_extract(later.payload_json, '$.requestId') =
                    json_extract(ranked.payload_json, '$.requestId')
                  AND (
                    (ranked.kind = 'approval.requested' AND later.kind = 'approval.resolved')
                    OR (
                      ranked.kind = 'approval.requested'
                      AND later.kind = 'provider.approval.respond.failed'
                      AND (
                        lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%stale pending approval request%'
                        OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%unknown pending approval request%'
                        OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%unknown pending permission request%'
                      )
                    )
                    OR (ranked.kind = 'user-input.requested' AND later.kind = 'user-input.resolved')
                    OR (
                      ranked.kind = 'user-input.requested'
                      AND later.kind = 'provider.user-input.respond.failed'
                      AND (
                        lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%stale pending user-input request%'
                        OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%unknown pending user-input request%'
                      )
                    )
                  )
                  AND (
                    later.created_at > ranked.created_at
                    OR (
                      later.created_at = ranked.created_at
                      AND CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END >
                        CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    )
                    OR (
                      later.created_at = ranked.created_at
                      AND CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                        CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                      AND COALESCE(later.sequence, -1) > COALESCE(ranked.sequence, -1)
                    )
                    OR (
                      later.created_at = ranked.created_at
                      AND CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                        CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                      AND COALESCE(later.sequence, -1) = COALESCE(ranked.sequence, -1)
                      AND later.activity_id > ranked.activity_id
                    )
                  )
              )
            )
          )
        ORDER BY
          created_at ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          activity_id ASC
      `,
  });

  const listPendingInteractionRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: OrchestrationPendingInteraction,
    execute: ({ threadId }) => sql`
      SELECT
        interaction_kind AS "interactionKind",
        request_id AS "requestId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        lifecycle_generation AS "lifecycleGeneration",
        status,
        decision,
        response_command_id AS "responseCommandId",
        response_requested_at AS "responseRequestedAt",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt"
      FROM projection_pending_interactions
      WHERE thread_id = ${threadId}
        AND status <> 'confirmed'
      ORDER BY created_at ASC, interaction_kind ASC, request_id ASC
    `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY requested_at DESC, turn_id DESC
        LIMIT 1
      `,
  });

  const getPendingTurnStartRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionPendingTurnStartDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT pending_message_id AS "messageId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
        ORDER BY requested_at DESC
        LIMIT 1
      `,
  });

  const listQueuedMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionQueuedMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT message_id AS "messageId"
        FROM queued_turn_promotions
        WHERE thread_id = ${threadId}
          AND state IN ('queued', 'promoting')
        ORDER BY
          CASE dispatch_mode WHEN 'steer' THEN 0 ELSE 1 END ASC,
          CASE WHEN dispatch_mode = 'steer' THEN queued_event_sequence END DESC,
          queued_event_sequence ASC
      `,
  });

  // Generated-image references are recovered at turn settlement. Keep this query
  // independent of the 500-row thread-detail activity window: a long-running turn
  // can emit far more tool activities before its terminal event arrives.
  const listGeneratedImageActivityRowsByTurn = SqlSchema.findAll({
    Request: ThreadTurnLookupInput,
    Result: ProjectionGeneratedImageActivityDbRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT kind, payload_json AS "payload"
        FROM thread_activities_read
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND kind = 'tool.completed'
          AND json_extract(payload_json, '$.itemType') = 'image_generation'
        -- Provider replay can project the same completion more than once. Collapse
        -- exact payload duplicates before applying the two-records-per-image cap.
        GROUP BY kind, payload_json
        ORDER BY MIN(created_at) ASC, MIN(activity_id) ASC
        LIMIT ${MAX_TURN_GENERATED_IMAGE_ACTIVITY_RECORDS}
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            spaceRows,
            projectRows,
            threadRows,
            messageRows,
            activityRows,
            pendingInteractionRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listSpaceRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listSpaces:query",
                  "ProjectionSnapshotQuery.getSnapshot:listSpaces:decodeRows",
                ),
              ),
            ),
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionProjectRows(
                  rows,
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeModelSelections",
                ),
              ),
            ),
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionThreadRows(
                  rows,
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeModelSelections",
                ),
              ),
            ),
            listThreadMessageRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
                ),
              ),
            ),
            listThreadActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
                ),
              ),
            ),
            listPendingInteractionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listPendingInteractions:query",
                  "ProjectionSnapshotQuery.getSnapshot:listPendingInteractions:decodeRows",
                ),
              ),
            ),
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const messages = collectProjectedMessages(messageRows);
          const activities = collectProjectedActivities(activityRows);
          const pendingInteractions = collectPendingInteractions(pendingInteractionRows);
          const latestTurns = collectProjectedLatestTurns(latestTurnRows);
          const sessions = collectProjectedSessions(sessionRows);

          let updatedAt = collectBaseUpdatedAt({ spaceRows, projectRows, threadRows, stateRows });
          updatedAt = maxOptionalIso(updatedAt, messages.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, activities.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, pendingInteractions.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, latestTurns.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, sessions.updatedAt);

          const projects: ReadonlyArray<OrchestrationProject> = projectRows.map(toProjectedProject);

          const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => {
            const threadMessages = messages.byThread.get(row.threadId) ?? [];
            const session = sessions.byThread.get(row.threadId) ?? null;
            return toProjectedThread({
              threadRow: row,
              latestTurn: latestTurns.byThread.get(row.threadId) ?? null,
              messages: threadMessages,
              activities: activities.byThread.get(row.threadId) ?? [],
              pendingInteractions: pendingInteractions.byThread.get(row.threadId) ?? [],
              session,
              pendingTurnStartMessageId:
                session?.status === "starting"
                  ? (threadMessages.findLast((message) => message.role === "user")?.id ?? null)
                  : null,
            });
          });

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            spaces: spaceRows.map(toProjectedSpace),
            projects,
            threads,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeReadModel(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [spaceRows, projectRows, threadRows, sessionRows, latestTurnRows, stateRows] =
            yield* Effect.all([
              listSpaceRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getCommandReadModel:listSpaces:query",
                    "ProjectionSnapshotQuery.getCommandReadModel:listSpaces:decodeRows",
                  ),
                ),
              ),
              listProjectRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                    "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
                  ),
                ),
                Effect.flatMap((rows) =>
                  decodeProjectionProjectRows(
                    rows,
                    "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeModelSelections",
                  ),
                ),
              ),
              listThreadRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                    "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
                  ),
                ),
                Effect.flatMap((rows) =>
                  decodeProjectionThreadRows(
                    rows,
                    "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeModelSelections",
                  ),
                ),
              ),
              listThreadSessionRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                    "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
                  ),
                ),
              ),
              listLatestTurnRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                    "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
                  ),
                ),
              ),
              listProjectionStateRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                    "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
                  ),
                ),
              ),
            ]);

          const sessions = collectProjectedSessions(sessionRows);
          const latestTurns = collectProjectedLatestTurns(latestTurnRows);

          let updatedAt = collectBaseUpdatedAt({ spaceRows, projectRows, threadRows, stateRows });
          updatedAt = maxOptionalIso(updatedAt, sessions.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, latestTurns.updatedAt);

          const projects: ReadonlyArray<OrchestrationProject> = projectRows.map(toProjectedProject);

          const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) =>
            toProjectedThread({
              threadRow: row,
              latestTurn: latestTurns.byThread.get(row.threadId) ?? null,
              messages: [],
              activities: [],
              pendingInteractions: [],
              session: sessions.byThread.get(row.threadId) ?? null,
            }),
          );

          return yield* decodeReadModel({
            snapshotSequence: computeSnapshotSequence(stateRows),
            spaces: spaceRows.map(toProjectedSpace),
            projects,
            threads,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          }).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:decodeReadModel",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [spaceRows, projectRows, threadRows, sessionRows, latestTurnRows, stateRows] =
            yield* Effect.all([
              listSpaceRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listSpaces:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listSpaces:decodeRows",
                  ),
                ),
              ),
              listProjectRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
                  ),
                ),
                Effect.flatMap((rows) =>
                  decodeProjectionProjectRows(
                    rows,
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeModelSelections",
                  ),
                ),
              ),
              listThreadShellRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
                  ),
                ),
                Effect.flatMap((rows) =>
                  decodeProjectionThreadShellRows(
                    rows,
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeModelSelections",
                  ),
                ),
              ),
              listThreadSessionRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
                  ),
                ),
              ),
              listLatestTurnRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
                  ),
                ),
              ),
              listProjectionStateRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
                  ),
                ),
              ),
            ]);

          const latestTurns = collectProjectedLatestTurns(latestTurnRows);
          const sessions = collectProjectedSessions(sessionRows);

          let updatedAt = collectBaseUpdatedAt({ spaceRows, projectRows, threadRows, stateRows });
          updatedAt = maxOptionalIso(updatedAt, latestTurns.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, sessions.updatedAt);

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            spaces: spaceRows
              .filter((row) => row.deletedAt === null && row.archivedAt === null)
              .map(toProjectedSpaceShell),
            archivedSpaces: spaceRows
              .filter((row) => row.deletedAt === null && row.archivedAt !== null)
              .map(toProjectedSpaceShell),
            projects: projectRows
              .filter((row) => row.deletedAt === null)
              .map((row) => toProjectedProjectShell(row)),
            threads: threadRows
              .filter((row) => row.deletedAt === null)
              .map((row) =>
                toProjectedThreadShellFromStoredSummary({
                  threadRow: row,
                  latestTurn: latestTurns.byThread.get(row.threadId) ?? null,
                  session: sessions.byThread.get(row.threadId) ?? null,
                }),
              ),
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeShellSnapshot(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const listStaleInFlightThreadIds: ProjectionSnapshotQueryShape["listStaleInFlightThreadIds"] = (
    input,
  ) =>
    listStaleInFlightThreadIdRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listStaleInFlightThreadIds:query",
          "ProjectionSnapshotQuery.listStaleInFlightThreadIds:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map(
        (stateRows): ProjectionSnapshotSequence => ({
          snapshotSequence: computeSnapshotSequence(stateRows),
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          decodeProjectionProjectOption(
            option,
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeModelSelection",
          ),
        ),
        Effect.map((option) =>
          Option.map(
            option,
            (row): OrchestrationProject => ({
              id: row.projectId,
              kind: row.kind,
              title: row.title,
              workspaceRoot: row.workspaceRoot,
              defaultModelSelection: row.defaultModelSelection,
              scripts: row.scripts,
              iconDataUrl: row.iconDataUrl ?? null,
              isPinned: row.isPinned > 0,
              spaceId: row.spaceId,
              sidebarSortOrder: row.sidebarSortOrder,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              deletedAt: row.deletedAt,
            }),
          ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        decodeProjectionProjectOption(
          option,
          "ProjectionSnapshotQuery.getProjectShellById:decodeModelSelection",
        ),
      ),
      Effect.map((option) => Option.map(option, (row) => toProjectedProjectShell(row))),
    );

  const getSpaceShellById: ProjectionSnapshotQueryShape["getSpaceShellById"] = (spaceId) =>
    getSpaceRowById({ spaceId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSpaceShellById:query",
          "ProjectionSnapshotQuery.getSpaceShellById:decodeRow",
        ),
      ),
      Effect.map(Option.map(toProjectedSpaceShell)),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const listGeneratedImageActivitiesByTurn: ProjectionSnapshotQueryShape["listGeneratedImageActivitiesByTurn"] =
    (threadId, turnId) =>
      listGeneratedImageActivityRowsByTurn({ threadId, turnId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.listGeneratedImageActivitiesByTurn:query",
            "ProjectionSnapshotQuery.listGeneratedImageActivitiesByTurn:decodeRows",
          ),
        ),
        Effect.map(
          (rows): ReadonlyArray<ProjectionGeneratedImageActivityRecord> =>
            rows.map((row) => ({ kind: row.kind, payload: row.payload })),
        ),
      );

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const threadRow = yield* getThreadRowById({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
                "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
              ),
            ),
            Effect.flatMap((option) =>
              decodeProjectionThreadOption(
                option,
                "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeModelSelection",
              ),
            ),
          );
          if (Option.isNone(threadRow)) {
            return Option.none<OrchestrationThreadShell>();
          }

          const [latestTurnRow, sessionRow] = yield* Effect.all([
            getLatestTurnRowByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
                ),
              ),
            ),
            getThreadSessionRowByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
                ),
              ),
            ),
          ]);

          return Option.some(
            toProjectedThreadShellFromStoredSummary({
              threadRow: threadRow.value,
              latestTurn: Option.match(latestTurnRow, {
                onNone: () => null,
                onSome: (row) => toProjectedLatestTurn(row),
              }),
              session: Option.match(sessionRow, {
                onNone: () => null,
                onSome: (row) => toProjectedSession(row),
              }),
            }),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadShellById:query")(error);
        }),
      );

  const listOpenTurnCounts: ProjectionSnapshotQueryShape["listOpenTurnCounts"] = () =>
    listOpenTurnCountRows(undefined).pipe(
      Effect.map((rows) => rows satisfies ReadonlyArray<ProjectionOpenTurnCount>),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listOpenTurnCounts:query",
          "ProjectionSnapshotQuery.listOpenTurnCounts:decodeRows",
        ),
      ),
    );

  const findSyntheticSubagentParentThread: ProjectionSnapshotQueryShape["findSyntheticSubagentParentThread"] =
    (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const parentRow = yield* getSyntheticSubagentParentThreadRow({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:query",
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:decodeRow",
                ),
              ),
              Effect.flatMap((option) =>
                decodeProjectionThreadOption(
                  option,
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:decodeModelSelection",
                ),
              ),
            );
            if (Option.isNone(parentRow)) {
              return Option.none<OrchestrationThread>();
            }
            return yield* loadThreadDetail(parentRow.value.threadId);
          }),
        )
        .pipe(
          Effect.mapError((error) => {
            if (isPersistenceError(error)) {
              return error;
            }
            return toPersistenceSqlError(
              "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:query",
            )(error);
          }),
        );

  // Hydrate a full thread detail projection without opening its own transaction.
  const loadThreadDetail = (
    threadId: ThreadId,
    options: { readonly messageLimit: number | null; readonly tracePrefix: string } = {
      messageLimit: MAX_THREAD_MESSAGES,
      tracePrefix: "ProjectionSnapshotQuery.getThreadDetailById",
    },
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadRowById({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            `${options.tracePrefix}:getThread:query`,
            `${options.tracePrefix}:getThread:decodeRow`,
          ),
        ),
        Effect.flatMap((option) =>
          decodeProjectionThreadOption(
            option,
            `${options.tracePrefix}:getThread:decodeModelSelection`,
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const [
        messageRows,
        activityRows,
        pendingInteractionRows,
        latestTurnRow,
        sessionRow,
        pendingTurnStartRow,
        queuedMessageRows,
      ] = yield* Effect.all([
        listThreadMessageRowsByThread({ threadId, maxMessages: options.messageLimit }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:listMessages:query`,
              `${options.tracePrefix}:listMessages:decodeRows`,
            ),
          ),
        ),
        listThreadActivityRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:listActivities:query`,
              `${options.tracePrefix}:listActivities:decodeRows`,
            ),
          ),
        ),
        listPendingInteractionRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:listPendingInteractions:query`,
              `${options.tracePrefix}:listPendingInteractions:decodeRows`,
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:getLatestTurn:query`,
              `${options.tracePrefix}:getLatestTurn:decodeRow`,
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:getSession:query`,
              `${options.tracePrefix}:getSession:decodeRow`,
            ),
          ),
        ),
        getPendingTurnStartRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:getPendingTurnStart:query`,
              `${options.tracePrefix}:getPendingTurnStart:decodeRow`,
            ),
          ),
        ),
        listQueuedMessageRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:listQueuedMessages:query`,
              `${options.tracePrefix}:listQueuedMessages:decodeRows`,
            ),
          ),
        ),
      ]);

      const session = Option.match(sessionRow, {
        onNone: () => null,
        onSome: (row) => toProjectedSession(row),
      });
      const messages = messageRows.map(orchestrationMessageFromProjectionRow);
      const pendingTurnStartMessageId =
        Option.getOrNull(pendingTurnStartRow)?.messageId ??
        (session?.status === "starting"
          ? (messages.findLast((message) => message.role === "user")?.id ?? null)
          : null);
      const thread = toProjectedThread({
        threadRow: threadRow.value,
        latestTurn: Option.match(latestTurnRow, {
          onNone: () => null,
          onSome: (row) => toProjectedLatestTurn(row),
        }),
        messages,
        activities: activityRows.map((row) => toProjectedActivity(row)),
        pendingInteractions: pendingInteractionRows,
        session,
        pendingTurnStartMessageId,
        queuedMessageIds: queuedMessageRows.map((row) => row.messageId),
      });

      return yield* decodeThreadDetail(thread).pipe(
        Effect.map((decodedThread) => Option.some(decodedThread)),
        Effect.mapError(toPersistenceDecodeError(`${options.tracePrefix}:decodeThread`)),
      );
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    sql.withTransaction(loadThreadDetail(threadId)).pipe(
      Effect.mapError((error) => {
        if (isPersistenceError(error)) {
          return error;
        }
        return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailById:query")(error);
      }),
    );

  const getThreadDetailForExportById: ProjectionSnapshotQueryShape["getThreadDetailForExportById"] =
    (threadId) =>
      sql
        .withTransaction(
          loadThreadDetail(threadId, {
            messageLimit: null,
            tracePrefix: "ProjectionSnapshotQuery.getThreadDetailForExportById",
          }),
        )
        .pipe(
          Effect.mapError((error) => {
            if (isPersistenceError(error)) {
              return error;
            }
            return toPersistenceSqlError(
              "ProjectionSnapshotQuery.getThreadDetailForExportById:query",
            )(error);
          }),
        );

  // Capture the projection cursor and thread detail in one transaction so the
  // snapshot fence cannot advance past the detail payload the client receives.
  const getThreadDetailSnapshotById: ProjectionSnapshotQueryShape["getThreadDetailSnapshotById"] = (
    threadId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [threadDetail, stateRows] = yield* Effect.all([
            loadThreadDetail(threadId),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listProjectionState:query",
                  "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);
          if (Option.isNone(threadDetail)) {
            return Option.none<OrchestrationThreadDetailSnapshot>();
          }

          return yield* decodeThreadDetailSnapshot({
            snapshotSequence: computeSnapshotSequence(stateRows),
            thread: threadDetail.value,
          }).pipe(
            Effect.map((snapshot) => Option.some(snapshot)),
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshotById:decodeSnapshot",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshotById:query")(
            error,
          );
        }),
      );

  return {
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getCounts,
    getSnapshotSequence,
    listStaleInFlightThreadIds,
    listOpenTurnCounts,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getSpaceShellById,
    getFirstActiveThreadIdByProjectId,
    listGeneratedImageActivitiesByTurn,
    getThreadShellById,
    findSyntheticSubagentParentThread,
    getThreadDetailById,
    getThreadDetailForExportById,
    getThreadDetailSnapshotById,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
