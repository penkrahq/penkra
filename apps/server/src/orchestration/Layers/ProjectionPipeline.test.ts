import { ThreadPublisherLive } from "../../cleanCore/ThreadPublisher.ts";
import { updateNavigation } from "../../cleanCore/navigation.ts";
import { seedThreadFolderFixture, createThreadFixture } from "../../cleanCore/threadFixtures.ts";
import { createThread, markThreadVisited } from "../../cleanCore/threadStore.ts";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  FolderId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
import { runManagedAttachmentCleanupBatch } from "../../managedAttachmentCleanup.ts";

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ThreadPublisherLive),
    Layer.provideMerge(NodeServices.layer),
  );

const makeObservedEventStoreLayer = (readCursors: Array<number>) =>
  Layer.effect(
    OrchestrationEventStore,
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      return {
        ...eventStore,
        readFromSequence(sequenceExclusive, limit, throughSequenceInclusive) {
          readCursors.push(sequenceExclusive);
          return eventStore.readFromSequence(sequenceExclusive, limit, throughSequenceInclusive);
        },
      } satisfies OrchestrationEventStoreShape;
    }),
  ).pipe(Layer.provide(OrchestrationEventStoreLive));

const makeAppendAndProject =
  (
    eventStore: OrchestrationEventStoreShape,
    projectionPipeline: OrchestrationProjectionPipelineShape,
  ) =>
  (event: Parameters<OrchestrationEventStoreShape["append"]>[0]) =>
    eventStore
      .append(event)
      .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const seedSpace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO projection_spaces (space_id,name,icon,sort_order,created_at,updated_at) VALUES ('penkra-personal','Personal','home',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
});

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("penkra-projection-pipeline-test-");

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId: FolderId.makeUnsafe("project-1"),
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          createdAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(ThreadId.makeUnsafe("thread-1")),
        folderId: FolderId.makeUnsafe(FolderId.makeUnsafe("project-1")),
        title: "Thread 1",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        createdAt: now,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly folderId: string;
        readonly title: string;
      }>`
        SELECT
          folder_id AS "folderId",
          title
        FROM projection_folders
      `;
      assert.deepEqual(projectRows, [{ folderId: "project-1", title: "Project 1" }]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 1);
      }
    }),
  );

  it.effect("persists completion acknowledgement across a cold projection rebuild", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-08-19T12:00:00.000Z";
      const visitedAt = "2026-08-19T12:05:00.000Z";

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId: FolderId.makeUnsafe("project-visit"),
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Project",
          workspaceRoot: "/tmp/project-visit",
          defaultModelSelection: null,
          createdAt,
        },
      });
      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(ThreadId.makeUnsafe("thread-visit")),
        folderId: FolderId.makeUnsafe(FolderId.makeUnsafe("project-visit")),
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });
      yield* createThread({
        id: "thread-visit",
        spaceId: "penkra-personal",
        folderId: "project-visit",
        title: "Thread",
        provider: "codex",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt,
      });
      yield* markThreadVisited({ threadId: "thread-visit", visitedAt, updatedAt: createdAt });

      yield* projectionPipeline.bootstrap;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'thread-visit'`;
      yield* sql`
        DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}
      `;
      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly lastVisitedAt: string | null;
        readonly updatedAt: string;
      }>`
        SELECT last_visited_at AS "lastVisitedAt", updated_at AS "updatedAt"
        FROM threads
        WHERE id = 'thread-visit'
      `;
      assert.deepEqual(rows, [{ lastVisitedAt: visitedAt, updatedAt: createdAt }]);
    }),
  );

  it.effect("keeps a retained runtime-error turn terminal across projection rebuilds", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);
      const threadId = ThreadId.makeUnsafe("thread-retained-error-turn");
      const turnId = TurnId.makeUnsafe("turn-retained-error-turn");
      const createdAt = "2026-07-21T00:00:00.000Z";
      const requestedAt = "2026-07-21T00:00:01.000Z";
      const startedAt = "2026-07-21T00:00:02.000Z";
      const failedAt = "2026-07-21T00:00:03.000Z";

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId: FolderId.makeUnsafe("project-retained-error"),
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Retained error project",
          workspaceRoot: "/tmp/project-retained-error",
          defaultModelSelection: null,
          createdAt,
        },
      });
      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(threadId),
        folderId: FolderId.makeUnsafe(FolderId.makeUnsafe("project-retained-error")),
        title: "Retained error thread",
        modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });
      yield* appendAndProject({
        type: "thread.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-retained-error-start"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: requestedAt,
        commandId: CommandId.makeUnsafe("cmd-retained-error-start"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-retained-error-start"),
        metadata: {},
        payload: {
          threadId,
          turnId,
          messageId: MessageId.makeUnsafe("message-retained-error"),
          modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
          runtimeMode: "full-access",
          dispatchMode: "queue",
          createdAt: requestedAt,
        },
      });
      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-retained-error-running"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: startedAt,
        commandId: CommandId.makeUnsafe("cmd-retained-error-running"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-retained-error-running"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: startedAt,
          },
        },
      });
      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-retained-error-terminal"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: failedAt,
        commandId: CommandId.makeUnsafe("cmd-retained-error-terminal"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-retained-error-terminal"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: "provider failed",
            updatedAt: failedAt,
          },
        },
      });

      const readTerminalRows = () =>
        Effect.all({
          sessions: sql<{
            readonly status: string;
            readonly activeTurnId: string | null;
          }>`
            SELECT status, active_turn_id AS "activeTurnId"
            FROM projection_thread_sessions
            WHERE thread_id = ${threadId}
          `,
          turns: sql<{
            readonly state: string;
            readonly completedAt: string | null;
          }>`
            SELECT state, completed_at AS "completedAt"
            FROM projection_turns
            WHERE thread_id = ${threadId} AND turn_id = ${turnId}
          `,
        });

      const liveRows = yield* readTerminalRows();
      assert.deepEqual(liveRows, {
        sessions: [{ status: "error", activeTurnId: turnId }],
        turns: [{ state: "error", completedAt: failedAt }],
      });

      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`;
      yield* sql`
        DELETE FROM projection_state
        WHERE projector IN (
          ${ORCHESTRATION_PROJECTOR_NAMES.threadSessions},
          ${ORCHESTRATION_PROJECTOR_NAMES.threadTurns}
        )
      `;
      yield* projectionPipeline.bootstrap;

      assert.deepEqual(yield* readTerminalRows(), liveRows);
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("penkra-message-identity-scope-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("keeps reused provider message ids thread-scoped through replay", () =>
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const messageId = MessageId.makeUnsafe("shared-provider-message-id");
        const firstThreadId = ThreadId.makeUnsafe("thread-shared-provider-message-a");
        const secondThreadId = ThreadId.makeUnsafe("thread-shared-provider-message-b");

        const appendMessage = (input: {
          readonly eventId: string;
          readonly commandId: string;
          readonly threadId: ThreadId;
          readonly text: string;
          readonly streaming: boolean;
          readonly attachmentId?: string;
          readonly occurredAt: string;
        }) =>
          eventStore.append({
            type: "thread.message-sent",
            eventId: EventId.makeUnsafe(input.eventId),
            aggregateKind: "thread",
            aggregateId: input.threadId,
            occurredAt: input.occurredAt,
            commandId: CommandId.makeUnsafe(input.commandId),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe(input.commandId),
            metadata: {},
            payload: {
              threadId: input.threadId,
              messageId,
              role: "assistant" as const,
              text: input.text,
              ...(input.attachmentId
                ? {
                    attachments: [
                      {
                        type: "file" as const,
                        id: input.attachmentId,
                        name: `${input.attachmentId}.txt`,
                        mimeType: "text/plain",
                        sizeBytes: 1,
                      },
                    ],
                  }
                : {}),
              turnId: null,
              streaming: input.streaming,
              createdAt: input.occurredAt,
              updatedAt: input.occurredAt,
            },
          });

        yield* appendMessage({
          eventId: "evt-shared-provider-message-a-1",
          commandId: "cmd-shared-provider-message-a-1",
          threadId: firstThreadId,
          text: "first",
          streaming: false,
          attachmentId: "attachment-shared-provider-a",
          occurredAt: "2026-07-14T11:00:00.000Z",
        });
        yield* appendMessage({
          eventId: "evt-shared-provider-message-b-1",
          commandId: "cmd-shared-provider-message-b-1",
          threadId: secondThreadId,
          text: "second",
          streaming: false,
          attachmentId: "attachment-shared-provider-b",
          occurredAt: "2026-07-14T11:00:01.000Z",
        });
        yield* appendMessage({
          eventId: "evt-shared-provider-message-a-2",
          commandId: "cmd-shared-provider-message-a-2",
          threadId: firstThreadId,
          text: " thread",
          streaming: true,
          occurredAt: "2026-07-14T11:00:02.000Z",
        });

        const readRows = () =>
          sql<{ readonly threadId: string; readonly text: string; readonly attachments: string }>`
          SELECT
            thread_id AS "threadId",
            text,
            attachments_json AS attachments
          FROM projection_thread_messages
          WHERE message_id = ${messageId}
          ORDER BY thread_id ASC
        `;
        const expectedRows = [
          {
            threadId: firstThreadId,
            text: "first thread",
            attachments: JSON.stringify([
              {
                type: "file",
                id: "attachment-shared-provider-a",
                name: "attachment-shared-provider-a.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
              },
            ]),
          },
          {
            threadId: secondThreadId,
            text: "second",
            attachments: JSON.stringify([
              {
                type: "file",
                id: "attachment-shared-provider-b",
                name: "attachment-shared-provider-b.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
              },
            ]),
          },
        ];

        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readRows(), expectedRows);

        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`
        DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}
      `;
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readRows(), expectedRows);
      }),
    );
  },
);

it.effect("fast-forwards lagging hot projector cursors before restart replay", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
      Layer.provideMerge(ThreadPublisherLive),
    );
    const readCursors: Array<number> = [];
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(makeObservedEventStoreLayer(readCursors)),
      Layer.provideMerge(persistenceLayer),
      Layer.provideMerge(ThreadPublisherLive),
    );
    const folderId = FolderId.makeUnsafe("project-bootstrap-fast-forward");
    const threadId = ThreadId.makeUnsafe("thread-bootstrap-fast-forward");
    const createdAt = "2026-07-09T10:00:00.000Z";

    const latestSequence = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId,
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Bootstrap fast-forward project",
          workspaceRoot: "/tmp/project-bootstrap-fast-forward",
          defaultModelSelection: null,
          createdAt,
        },
      });
      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(threadId),
        folderId: FolderId.makeUnsafe(folderId),
        title: "Bootstrap fast-forward thread",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-5-20250929",
        },
        runtimeMode: "full-access",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });
      yield* projectionPipeline.bootstrap;

      let latestSequence = 0;
      for (let index = 0; index < 20; index += 1) {
        const occurredAt = `2026-07-09T10:00:${String(index + 1).padStart(2, "0")}.000Z`;
        const savedEvent = yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.makeUnsafe(`evt-bootstrap-fast-forward-activity-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.makeUnsafe(`cmd-bootstrap-fast-forward-activity-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-bootstrap-fast-forward-activity-${index}`),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.makeUnsafe(`activity-bootstrap-fast-forward-${index}`),
              tone: "info",
              kind: "context-window.updated",
              summary: "Context window updated",
              payload: { usedTokens: index + 1, maxTokens: 200_000 },
              turnId: null,
              createdAt: occurredAt,
            },
          },
        });
        latestSequence = savedEvent.sequence;
        yield* projectionPipeline.projectEvent(savedEvent);
      }
      return latestSequence;
    }).pipe(Effect.provide(firstProjectionLayer));

    const projectorStates = yield* Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* projectionPipeline.bootstrap;
      return yield* sql<{ readonly projector: string; readonly lastAppliedSequence: number }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector <> ${ORCHESTRATION_PROJECTOR_NAMES.hot}
        ORDER BY projector ASC
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.equal(readCursors.length, projectorStates.length);
    assert.deepEqual([...new Set(readCursors)], [0, latestSequence]);
    for (const row of projectorStates) {
      assert.equal(row.lastAppliedSequence, latestSequence);
    }
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "penkra-projection-pipeline-fast-forward-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("drains 2,501 file-backed events to a captured high-water fence", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const eventStoreLayer = OrchestrationEventStoreLive.pipe(
      Layer.provideMerge(persistenceLayer),
      Layer.provideMerge(ThreadPublisherLive),
    );
    const folderId = FolderId.makeUnsafe("project-bootstrap-paged");
    const threadId = ThreadId.makeUnsafe("thread-bootstrap-paged");
    const occurredAt = "2026-07-14T01:00:00.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId,
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Project 0",
          workspaceRoot: "/tmp/project-bootstrap-paged",
          defaultModelSelection: null,
          createdAt: occurredAt,
        },
      });
      yield* createThreadFixture(sql, {
        threadId,
        folderId,
        title: "Paged",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        createdAt: occurredAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });
      yield* eventStore.append({
        type: "thread.session-stop-requested",
        eventId: EventId.makeUnsafe("evt-bootstrap-paged-initial"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, createdAt: occurredAt },
      });
      yield* sql`
        WITH RECURSIVE digits(n) AS (
          SELECT 0
          UNION ALL
          SELECT n + 1 FROM digits WHERE n < 49
        ), numbered(n) AS (
          SELECT (high.n * 50) + low.n + 1
          FROM digits AS high
          CROSS JOIN digits AS low
        )
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        SELECT
          'evt-bootstrap-paged-' || n,
          'thread',
          ${threadId},
          n,
          'thread.activity-appended',
          ${occurredAt},
          'cmd-bootstrap-paged-' || n,
          NULL,
          'cmd-bootstrap-paged-' || n,
          'user',
          json_object(
            'threadId', ${threadId},
            'activity', json_object('id', 'activity-bootstrap-paged-' || n, 'tone', 'info', 'kind', 'test', 'summary', 'Activity ' || n, 'payload', json('{}'), 'turnId', NULL, 'createdAt', ${occurredAt})
          ),
          '{}'
        FROM numbered
      `;
    }).pipe(Effect.provide(eventStoreLayer));

    let appendedAfterFence = false;
    const appendAfterFenceLayer = Layer.effect(
      OrchestrationEventStore,
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        return {
          ...eventStore,
          readFromSequence(sequenceExclusive, limit, throughSequenceInclusive) {
            return Stream.unwrap(
              Effect.gen(function* () {
                if (!appendedAfterFence) {
                  appendedAfterFence = true;
                  yield* eventStore.append({
                    type: "thread.activity-appended",
                    eventId: EventId.makeUnsafe("evt-after-fence"),
                    aggregateKind: "thread",
                    aggregateId: threadId,
                    occurredAt,
                    commandId: null,
                    causationEventId: null,
                    correlationId: null,
                    metadata: {},
                    payload: {
                      threadId,
                      activity: {
                        id: EventId.makeUnsafe("activity-after-fence"),
                        tone: "info",
                        kind: "test",
                        summary: "After fence",
                        payload: {},
                        turnId: null,
                        createdAt: occurredAt,
                      },
                    },
                  });
                }
                return eventStore.readFromSequence(
                  sequenceExclusive,
                  limit,
                  throughSequenceInclusive,
                );
              }),
            );
          },
        } satisfies OrchestrationEventStoreShape;
      }),
    ).pipe(Layer.provide(OrchestrationEventStoreLive));
    const projectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(appendAfterFenceLayer),
      Layer.provideMerge(persistenceLayer),
      Layer.provideMerge(ThreadPublisherLive),
    );

    const result = yield* Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* projectionPipeline.bootstrap;
      const activities = yield* sql<{ readonly summary: string }>`
        SELECT summary FROM projection_thread_activities WHERE activity_id='activity-bootstrap-paged-2500'
      `;
      const cursors = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence" FROM projection_state
      `;
      const eventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
      `;
      return { activities, cursors, eventCount: eventCount[0]?.count ?? 0 };
    }).pipe(Effect.provide(projectionLayer));

    assert.deepEqual(result.activities, [{ summary: "Activity 2500" }]);
    assert.equal(result.eventCount, 2_502);
    assert.equal(result.cursors.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
    for (const cursor of result.cursors) {
      assert.equal(cursor.lastAppliedSequence, 2_501);
    }
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "penkra-projection-pipeline-paged-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("penkra-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-attachments"),
            messageId: MessageId.makeUnsafe("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("penkra-projection-attachments-safe-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("preserves mixed image attachment metadata as-is", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-attachments-safe"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-attachments-safe"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-attachments-safe"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-attachments-safe"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-attachments-safe"),
          messageId: MessageId.makeUnsafe("message-attachments-safe"),
          role: "user",
          text: "Inspect this",
          attachments: [
            {
              type: "image",
              id: "thread-attachments-safe-att-1",
              name: "untrusted.exe",
              mimeType: "image/x-unknown",
              sizeBytes: 5,
            },
            {
              type: "image",
              id: "thread-attachments-safe-att-2",
              name: "not-image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-attachments-safe-att-1",
          name: "untrusted.exe",
          mimeType: "image/x-unknown",
          sizeBytes: 5,
        },
        {
          type: "image",
          id: "thread-attachments-safe-att-2",
          name: "not-image.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        const later = new Date(Date.now() + 1_000).toISOString();

        yield* seedSpace;
        yield* updateNavigation({
          update: {
            action: "folder.create",
            folderId: FolderId.makeUnsafe("project-clear-attachments"),
            spaceId: SpaceId.makeUnsafe("penkra-personal"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            createdAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;
        yield* createThreadFixture(sql, {
          threadId: ThreadId.makeUnsafe(ThreadId.makeUnsafe("thread-clear-attachments")),
          folderId: FolderId.makeUnsafe(FolderId.makeUnsafe("project-clear-attachments")),
          title: "Thread Clear Attachments",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          createdAt: now,
          connection: { kind: "selected", connectionId: null },
          creator: { kind: "user" },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            messageId: MessageId.makeUnsafe("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            messageId: MessageId.makeUnsafe("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("penkra-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 1_000).toISOString();

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId: FolderId.makeUnsafe("project-overwrite"),
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          createdAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(ThreadId.makeUnsafe("thread-overwrite")),
        folderId: FolderId.makeUnsafe(FolderId.makeUnsafe("project-overwrite")),
        title: "Thread Overwrite",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        createdAt: now,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          messageId: MessageId.makeUnsafe("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.makeUnsafe("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          messageId: MessageId.makeUnsafe("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("penkra-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId: FolderId.makeUnsafe("project-rollback"),
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          createdAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(ThreadId.makeUnsafe("thread-rollback")),
        folderId: FolderId.makeUnsafe(FolderId.makeUnsafe("project-rollback")),
        title: "Thread Rollback",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        createdAt: now,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE INSERT ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-rollback-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-rollback"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-rollback-3"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-rollback-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-rollback"),
            messageId: MessageId.makeUnsafe("message-rollback"),
            role: "user",
            text: "Rollback me",
            attachments: [
              {
                type: "image",
                id: "thread-rollback-att-1",
                name: "rollback.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;
    }),
  );

  it.effect("streams assistant deltas into one byte-identical message row", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);
      const folderId = FolderId.makeUnsafe("project-stream-append");
      const threadId = ThreadId.makeUnsafe("thread-stream-append");
      const messageId = MessageId.makeUnsafe("message-stream-append");
      const turnId = TurnId.makeUnsafe("turn-stream-append");
      const otherTurnId = TurnId.makeUnsafe("turn-stream-append-other");
      const createdAt = "2026-04-01T10:00:00.000Z";
      const iso = (offsetSeconds: number) =>
        new Date(Date.parse(createdAt) + offsetSeconds * 1_000).toISOString();

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId,
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Stream Append Project",
          workspaceRoot: "/tmp/project-stream-append",
          defaultModelSelection: null,
          createdAt,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(threadId),
        folderId: FolderId.makeUnsafe(folderId),
        title: "Stream Append Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });

      // Deltas deliberately include multi-byte characters, empty chunks and
      // trailing whitespace: the appended text must match a plain JS join.
      const deltas = Array.from({ length: 64 }, (_, index) =>
        index % 8 === 3 ? "" : `δ${index}-${"x".repeat(index % 5)}${index % 4 === 0 ? "\n" : " "}`,
      );

      let expectedTextByteLength = 0;
      for (const [index, delta] of deltas.entries()) {
        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe(`evt-stream-append-delta-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: iso(index + 1),
          commandId: CommandId.makeUnsafe(`cmd-stream-append-delta-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-stream-append-delta-${index}`),
          metadata: {},
          payload: {
            threadId,
            messageId,
            role: "assistant",
            text: delta,
            // The first delta creates the row without a turn; the next one binds
            // it, and a later conflicting turn must not steal the binding.
            turnId: index === 0 ? null : index === 40 ? otherTurnId : turnId,
            streaming: true,
            expectedTextByteLength,
            ...(index === 1 ? { dispatchOrigin: "agent" as const } : {}),
            createdAt: iso(index + 1),
            updatedAt: iso(index + 1),
          },
        });
        expectedTextByteLength += Buffer.byteLength(delta, "utf8");
      }

      const streamedRows = yield* sql<{
        readonly text: string;
        readonly turnId: string | null;
        readonly dispatchOrigin: string | null;
        readonly isStreaming: unknown;
        readonly sequence: number;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>`
        SELECT
          text,
          turn_id AS "turnId",
          dispatch_origin AS "dispatchOrigin",
          is_streaming AS "isStreaming",
          sequence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      const streamed = streamedRows[0];
      assert.lengthOf(streamedRows, 1);
      assert.equal(streamed?.text, deltas.join(""));
      assert.equal(streamed?.turnId, turnId);
      assert.equal(streamed?.dispatchOrigin, "agent");
      assert.isTrue(Boolean(streamed?.isStreaming));
      assert.equal(streamed?.createdAt, iso(1));
      assert.equal(streamed?.updatedAt, iso(deltas.length));

      const firstDeltaSequence = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events
        WHERE event_id = 'evt-stream-append-delta-0'
      `;
      assert.equal(streamed?.sequence, firstDeltaSequence[0]?.sequence);

      // Every phase cursor must stay exactly at the last projected event: the
      // client snapshot sequence is their minimum, and a lagging cursor makes
      // clients replay deltas they already applied.
      const lastDeltaSequence = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events
        WHERE event_id = ${`evt-stream-append-delta-${deltas.length - 1}`}
      `;
      const shellCursor = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}
      `;
      assert.equal(shellCursor[0]?.lastAppliedSequence, lastDeltaSequence[0]?.sequence);

      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
          status, error, fingerprint_version, command_fingerprint
        )
        SELECT 'provider:stream-append:delta-receipt', 'thread', ${threadId}, ${iso(1)},
               sequence, 'accepted', NULL, 1,
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        FROM orchestration_events
        WHERE event_id = 'evt-stream-append-delta-0'
      `;

      // Non-streaming writes replace the accumulated text instead of appending.
      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-stream-append-final"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: iso(500),
        commandId: CommandId.makeUnsafe("cmd-stream-append-final"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stream-append-final"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "assistant",
          text: "replaced final text",
          turnId,
          streaming: false,
          createdAt: iso(500),
          updatedAt: iso(500),
        },
      });

      const retainedStreamingEvents = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE stream_id = ${threadId}
          AND event_type = 'thread.message-sent'
          AND json_extract(payload_json, '$.messageId') = ${messageId}
          AND json_extract(payload_json, '$.streaming') = 1
      `;
      assert.equal(retainedStreamingEvents[0]?.count, 64);
      const retainedDeltaReceipts = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_command_receipts
        WHERE command_id = 'provider:stream-append:delta-receipt'
      `;
      assert.equal(retainedDeltaReceipts[0]?.count, 1);

      // An empty non-streaming write keeps the stored text.
      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-stream-append-complete"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: iso(501),
        commandId: CommandId.makeUnsafe("cmd-stream-append-complete"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stream-append-complete"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "assistant",
          text: "",
          turnId,
          streaming: false,
          createdAt: iso(501),
          updatedAt: iso(501),
        },
      });

      const settledRows = yield* sql<{
        readonly text: string;
        readonly isStreaming: unknown;
        readonly sequence: number;
        readonly createdAt: string;
      }>`
        SELECT text, is_streaming AS "isStreaming", sequence, created_at AS "createdAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.equal(settledRows[0]?.text, "replaced final text");
      assert.isFalse(Boolean(settledRows[0]?.isStreaming));
      assert.equal(settledRows[0]?.sequence, firstDeltaSequence[0]?.sequence);
      assert.equal(settledRows[0]?.createdAt, iso(1));
    }),
  );

  it.effect("keeps streaming appends and message rebuilds consistent after a rollback", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);
      const folderId = FolderId.makeUnsafe("project-stream-restart");
      const threadId = ThreadId.makeUnsafe("thread-stream-restart");
      const messageId = MessageId.makeUnsafe("message-stream-restart");
      const createdAt = "2026-04-02T10:00:00.000Z";

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId,
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Stream Restart Project",
          workspaceRoot: "/tmp/project-stream-restart",
          defaultModelSelection: null,
          createdAt,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(threadId),
        folderId: FolderId.makeUnsafe(folderId),
        title: "Stream Restart Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });

      for (const [index, delta] of ["first ", "second ", "third"].entries()) {
        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe(`evt-stream-restart-delta-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.makeUnsafe(`cmd-stream-restart-delta-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-stream-restart-delta-${index}`),
          metadata: {},
          payload: {
            threadId,
            messageId,
            role: "assistant",
            text: delta,
            turnId: null,
            streaming: true,
            createdAt,
            updatedAt: createdAt,
          },
        });
      }

      // Replaying the journal from scratch must land on the same text: the
      // append path is only correct if it is driven by the event log alone.
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_state`;
      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.lengthOf(rows, 1);
      assert.equal(rows[0]?.text, "first second third");
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("penkra-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("prunes legacy and managed attachments through their existing authorities", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const managedAttachments = yield* ManagedAttachmentRepository;
      const sql = yield* SqlClient.SqlClient;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";
      const removeFileAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000004";
      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";
      const keepManagedAttachmentId = "att_v2_33333333333333333333333333333333";
      const removeManagedAttachmentId = "att_v2_44444444444444444444444444444444";
      const keepManagedRelativePath = `objects/33/${keepManagedAttachmentId}.txt`;
      const removeManagedRelativePath = `objects/44/${removeManagedAttachmentId}.txt`;

      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);

      for (const [attachmentId, relativePath, commandId, messageId] of [
        [
          keepManagedAttachmentId,
          keepManagedRelativePath,
          "command-managed-coexist-keep",
          "message-keep",
        ],
        [
          removeManagedAttachmentId,
          removeManagedRelativePath,
          "command-managed-coexist-remove",
          "message-remove",
        ],
      ] as const) {
        assert.strictEqual(
          (yield* managedAttachments.reserve({
            attachmentId,
            ownerThreadId: threadId,
            ownerKind: "principal",
            ownerId: "principal-managed-coexist",
            kind: "file",
            originalName: `${attachmentId}.txt`,
            mimeType: "text/plain",
            reservedBytes: 5,
            relativePath,
            now,
          })).status,
          "reserved",
        );
        assert.strictEqual(
          (yield* managedAttachments.finalizeStaged({
            attachmentId,
            ownerThreadId: threadId,
            ownerKind: "principal",
            ownerId: "principal-managed-coexist",
            sizeBytes: 5,
            sha256: "b".repeat(64),
            stagingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            now,
          })).status,
          "staged",
        );
        assert.strictEqual(
          (yield* managedAttachments.claimForAcceptedTurn({
            attachmentIds: [attachmentId],
            ownerThreadId: threadId,
            ownerKind: "principal",
            ownerId: "principal-managed-coexist",
            commandId,
            messageId,
            now,
          })).status,
          "claimed",
        );
      }

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId: FolderId.makeUnsafe("project-revert-files"),
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          createdAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(threadId),
        folderId: FolderId.makeUnsafe(FolderId.makeUnsafe("project-revert-files")),
        title: "Thread Revert Files",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        createdAt: now,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
            {
              type: "file",
              id: keepManagedAttachmentId,
              name: "managed-keep.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.makeUnsafe("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
            {
              type: "file",
              id: removeFileAttachmentId,
              name: "remove.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
            {
              type: "file",
              id: removeManagedAttachmentId,
              name: "managed-remove.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.makeUnsafe("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      const removeFilePath = path.join(attachmentsDir, `${removeFileAttachmentId}.txt`);
      const keepManagedPath = path.join(attachmentsDir, keepManagedRelativePath);
      const removeManagedPath = path.join(attachmentsDir, removeManagedRelativePath);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(keepManagedPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(removeManagedPath), { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      yield* fileSystem.writeFileString(removeFilePath, "remove-file");
      yield* fileSystem.writeFileString(keepManagedPath, "keep!");
      yield* fileSystem.writeFileString(removeManagedPath, "drop!");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(removeFilePath));
      assert.isTrue(yield* exists(otherThreadPath));
      assert.isTrue(yield* exists(keepManagedPath));
      assert.isTrue(yield* exists(removeManagedPath));

      yield* appendAndProject({
        type: "thread.conversation-rolled-back",
        eventId: EventId.makeUnsafe("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-remove"),
          numTurns: 1,
          removedTurnIds: [TurnId.makeUnsafe("turn-remove")],
        },
      });

      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isFalse(yield* exists(removeFilePath));
      assert.isTrue(yield* exists(otherThreadPath));
      assert.isTrue(yield* exists(keepManagedPath));
      assert.isTrue(yield* exists(removeManagedPath));

      const statesBeforeCleanup = yield* sql<{
        readonly attachmentId: string;
        readonly state: string;
      }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        WHERE attachment_id IN (${keepManagedAttachmentId}, ${removeManagedAttachmentId})
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(statesBeforeCleanup, [
        { attachmentId: keepManagedAttachmentId, state: "claimed" },
        { attachmentId: removeManagedAttachmentId, state: "deleting" },
      ]);

      yield* runManagedAttachmentCleanupBatch;

      assert.isTrue(yield* exists(keepManagedPath));
      assert.isFalse(yield* exists(removeManagedPath));
      const statesAfterCleanup = yield* sql<{
        readonly attachmentId: string;
        readonly state: string;
      }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        WHERE attachment_id IN (${keepManagedAttachmentId}, ${removeManagedAttachmentId})
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(statesAfterCleanup, [
        { attachmentId: keepManagedAttachmentId, state: "claimed" },
        { attachmentId: removeManagedAttachmentId, state: "deleted" },
      ]);
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId: FolderId.makeUnsafe("project-a"),
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          createdAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(ThreadId.makeUnsafe("thread-a")),
        folderId: FolderId.makeUnsafe(FolderId.makeUnsafe("project-a")),
        title: "Thread A",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        createdAt: now,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [{ text: "hello world" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId: FolderId.makeUnsafe("project-empty"),
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          createdAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe(ThreadId.makeUnsafe("thread-empty")),
        folderId: FolderId.makeUnsafe(FolderId.makeUnsafe("project-empty")),
        title: "Thread Empty",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        createdAt: now,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );
});

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(ThreadPublisherLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ThreadPublisherLive),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "penkra-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("routes telemetry activities only through their owning hot projector", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-07-09T00:00:00.000Z";
      const spaceId = SpaceId.makeUnsafe("space-routed-telemetry");
      const folderId = FolderId.makeUnsafe("project-routed-telemetry");
      const threadId = ThreadId.makeUnsafe("thread-routed-telemetry");

      yield* updateNavigation({
        update: {
          action: "space.create",
          spaceId,
          name: "Routed telemetry",
          icon: "home",
          createdAt,
        },
      });
      yield* seedSpace;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId,
          spaceId,
          title: "Routed telemetry",
          workspaceRoot: null,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt,
        },
      });
      yield* createThreadFixture(sql, {
        threadId: threadId,
        folderId: folderId,
        title: "Routed telemetry",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      });

      yield* sql`CREATE TABLE projection_state_write_log (projector TEXT NOT NULL)`;
      yield* sql`
        CREATE TRIGGER log_projection_state_insert
        AFTER INSERT ON projection_state
        BEGIN
          INSERT INTO projection_state_write_log (projector) VALUES (NEW.projector);
        END
      `;
      yield* sql`
        CREATE TRIGGER log_projection_state_update
        AFTER UPDATE ON projection_state
        BEGIN
          INSERT INTO projection_state_write_log (projector) VALUES (NEW.projector);
        END
      `;

      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-routed-context-window"),
        threadId,
        activity: {
          id: EventId.makeUnsafe("activity-routed-context-window"),
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload: { usedTokens: 42, maxTokens: 200_000 },
          turnId: null,
          createdAt,
        },
        createdAt,
      });

      const writes = yield* sql<{ readonly projector: string }>`
        SELECT projector
        FROM projection_state_write_log
        ORDER BY projector ASC
      `;
      assert.deepEqual(writes, [
        { projector: "projection.hot" },
        { projector: "projection.thread-activities" },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(
    Layer.effectDiscard(seedThreadFolderFixture("project-test", "penkra-personal")).pipe(
      Layer.provideMerge(
        makeProjectionPipelinePrefixedTestLayer("penkra-projection-pipeline-turn-finish-"),
      ),
    ),
  ),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("keeps assistant message completions from settling a running turn early", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-turn-finish");
      yield* createThread({
        id: threadId,
        spaceId: "penkra-personal",
        folderId: "project-test",
        sidebarSortOrder: 0,
        title: "Thread",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      const turnId = TurnId.makeUnsafe("turn-turn-finish");
      const startedAt = "2026-02-27T09:00:00.000Z";
      const assistantCompletedAt = "2026-02-27T09:00:02.000Z";
      const turnFinishedAt = "2026-02-27T09:00:05.000Z";

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-turn-finish-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: startedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-finish-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-turn-finish-1"),
        metadata: {},
        payload: {
          threadId,
          turnId,
          messageId: MessageId.makeUnsafe("message-turn-finish"),
          runtimeMode: "full-access",
          createdAt: startedAt,
        },
      });

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-turn-finish-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: startedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-finish-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-turn-finish-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: startedAt,
          },
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-turn-finish-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: assistantCompletedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-finish-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-turn-finish-3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("assistant-turn-finish"),
          role: "assistant",
          text: "",
          turnId,
          streaming: false,
          createdAt: assistantCompletedAt,
          updatedAt: assistantCompletedAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rowsAfterAssistantComplete = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
        readonly assistantMessageId: string | null;
      }>`
        SELECT
          state,
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
      `;
      assert.deepEqual(rowsAfterAssistantComplete, [
        {
          state: "running",
          completedAt: null,
          assistantMessageId: "assistant-turn-finish",
        },
      ]);

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-turn-finish-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnFinishedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-finish-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-turn-finish-4"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: turnFinishedAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const rowsAfterSessionReady = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT
          state,
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
      `;
      assert.deepEqual(rowsAfterSessionReady, [
        {
          state: "completed",
          completedAt: turnFinishedAt,
        },
      ]);
    }),
  );

  it.effect("settles every logical turn bound to one provider invocation", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-native-steer-aliases");
      yield* createThread({
        id: threadId,
        spaceId: "penkra-personal",
        folderId: "project-test",
        sidebarSortOrder: 0,
        title: "Thread",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      const providerTurnId = TurnId.makeUnsafe("turn-provider-native-steer");
      const settledAt = "2026-09-05T07:11:04.000Z";
      const logicalTurns = [
        {
          turnId: TurnId.makeUnsafe("turn-logical-original"),
          messageId: MessageId.makeUnsafe("message-logical-original"),
          requestedAt: "2026-09-05T07:11:00.000Z",
        },
        {
          turnId: TurnId.makeUnsafe("turn-logical-steer"),
          messageId: MessageId.makeUnsafe("message-logical-steer"),
          requestedAt: "2026-09-05T07:11:02.000Z",
        },
      ] as const;

      for (const [index, logicalTurn] of logicalTurns.entries()) {
        yield* eventStore.append({
          type: "thread.turn-start-requested",
          eventId: EventId.makeUnsafe(`evt-native-steer-start-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: logicalTurn.requestedAt,
          commandId: CommandId.makeUnsafe(`cmd-native-steer-start-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-native-steer-start-${index}`),
          metadata: {},
          payload: {
            threadId,
            turnId: logicalTurn.turnId,
            messageId: logicalTurn.messageId,
            runtimeMode: "full-access",
            createdAt: logicalTurn.requestedAt,
          },
        });
        yield* eventStore.append({
          type: "thread.message-delivery-set",
          eventId: EventId.makeUnsafe(`evt-native-steer-accepted-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: logicalTurn.requestedAt,
          commandId: CommandId.makeUnsafe(`cmd-native-steer-accepted-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-native-steer-accepted-${index}`),
          metadata: {},
          payload: {
            threadId,
            messageId: logicalTurn.messageId,
            turnId: logicalTurn.turnId,
            state: "accepted",
            providerTurnId,
            updatedAt: logicalTurn.requestedAt,
          },
        });
      }
      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-native-steer-ready"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: settledAt,
        commandId: CommandId.makeUnsafe("cmd-native-steer-ready"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-native-steer-ready"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: settledAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly turnId: string;
        readonly providerTurnId: string | null;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT
          turn_id AS "turnId",
          provider_turn_id AS "providerTurnId",
          state,
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY requested_at ASC
      `;
      assert.deepEqual(
        rows,
        logicalTurns.map((logicalTurn) => ({
          turnId: logicalTurn.turnId,
          providerTurnId,
          state: "completed",
          completedAt: settledAt,
        })),
      );
    }),
  );

  it.effect("matches in-memory turn settlement for terminal session statuses", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const scenarios = [
        {
          key: "ready-cleared",
          status: "ready",
          retainsActiveTurn: false,
          expectedState: "completed",
          expectedCompleted: true,
        },
        {
          key: "interrupted-cleared",
          status: "interrupted",
          retainsActiveTurn: false,
          expectedState: "interrupted",
          expectedCompleted: true,
        },
        {
          key: "stopped-cleared",
          status: "stopped",
          retainsActiveTurn: false,
          expectedState: "interrupted",
          expectedCompleted: true,
        },
        {
          key: "error-retained",
          status: "error",
          retainsActiveTurn: true,
          expectedState: "error",
          expectedCompleted: true,
        },
        {
          key: "interrupted-retained",
          status: "interrupted",
          retainsActiveTurn: true,
          expectedState: "running",
          expectedCompleted: false,
        },
        {
          key: "stopped-retained",
          status: "stopped",
          retainsActiveTurn: true,
          expectedState: "running",
          expectedCompleted: false,
        },
      ] as const;

      for (const [index, scenario] of scenarios.entries()) {
        const threadId = ThreadId.makeUnsafe(`thread-session-settlement-${scenario.key}`);
        yield* createThread({
          id: threadId,
          spaceId: "penkra-personal",
          folderId: "project-test",
          sidebarSortOrder: 0,
          title: "Thread",
          provider: "codex",
          model: "gpt-5.5",
          runtimeMode: "full-access",
          createdBy: "user",
          createdAt: "2026-10-10T00:00:00.000Z",
        });
        const turnId = TurnId.makeUnsafe(`turn-session-settlement-${scenario.key}`);
        const startedAt = `2026-02-27T12:00:${String(index * 2).padStart(2, "0")}.000Z`;
        const settledAt = `2026-02-27T12:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`;

        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.makeUnsafe(`evt-session-settlement-${scenario.key}-running`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: startedAt,
          commandId: CommandId.makeUnsafe(`cmd-session-settlement-${scenario.key}-running`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-session-settlement-${scenario.key}-running`),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: startedAt,
            },
          },
        });

        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.makeUnsafe(`evt-session-settlement-${scenario.key}-terminal`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: settledAt,
          commandId: CommandId.makeUnsafe(`cmd-session-settlement-${scenario.key}-terminal`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(
            `cmd-session-settlement-${scenario.key}-terminal`,
          ),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: scenario.status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: scenario.retainsActiveTurn ? turnId : null,
              lastError: scenario.status === "error" ? "provider crashed" : null,
              updatedAt: settledAt,
            },
          },
        });

        if (scenario.expectedCompleted) {
          const replayedAt = `2026-02-27T12:01:${String(index).padStart(2, "0")}.000Z`;
          yield* eventStore.append({
            type: "thread.session-set",
            eventId: EventId.makeUnsafe(`evt-session-settlement-${scenario.key}-running-replay`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: replayedAt,
            commandId: CommandId.makeUnsafe(
              `cmd-session-settlement-${scenario.key}-running-replay`,
            ),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe(
              `cmd-session-settlement-${scenario.key}-running-replay`,
            ),
            metadata: {},
            payload: {
              threadId,
              session: {
                threadId,
                status: "running",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: turnId,
                lastError: null,
                updatedAt: replayedAt,
              },
            },
          });
        }
      }

      yield* projectionPipeline.bootstrap;

      for (const [index, scenario] of scenarios.entries()) {
        const threadId = ThreadId.makeUnsafe(`thread-session-settlement-${scenario.key}`);
        yield* createThread({
          id: threadId,
          spaceId: "penkra-personal",
          folderId: "project-test",
          sidebarSortOrder: 0,
          title: "Thread",
          provider: "codex",
          model: "gpt-5.5",
          runtimeMode: "full-access",
          createdBy: "user",
          createdAt: "2026-10-10T00:00:00.000Z",
        });
        const turnId = TurnId.makeUnsafe(`turn-session-settlement-${scenario.key}`);
        const settledAt = `2026-02-27T12:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`;
        const rows = yield* sql<{
          readonly state: string;
          readonly completedAt: string | null;
        }>`
          SELECT state, completed_at AS "completedAt"
          FROM projection_turns
          WHERE thread_id = ${threadId}
            AND turn_id = ${turnId}
        `;

        assert.deepEqual(rows, [
          {
            state: scenario.expectedState,
            completedAt: scenario.expectedCompleted ? settledAt : null,
          },
        ]);
      }
    }),
  );

  it.effect("folders steer dispatch mode onto the triggering user message", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-steer-chip");
      yield* createThread({
        id: threadId,
        spaceId: "penkra-personal",
        folderId: "project-test",
        sidebarSortOrder: 0,
        title: "Thread",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      const messageId = MessageId.makeUnsafe("message-steer-chip");
      const createdAt = "2026-02-27T11:00:00.000Z";

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-steer-chip-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-steer-chip-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-steer-chip-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "hello",
          dispatchMode: "steer",
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly dispatchMode: string | null }>`
        SELECT dispatch_mode AS "dispatchMode"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
      `;

      assert.deepEqual(rows, [{ dispatchMode: "steer" }]);
    }),
  );

  it.effect("persists the steering marker at queued steer admission before provider metadata", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-restored-steer-marker");
      yield* createThread({
        id: threadId,
        spaceId: "penkra-personal",
        folderId: "project-test",
        sidebarSortOrder: 0,
        title: "Thread",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      const messageId = MessageId.makeUnsafe("message-restored-steer-marker");
      const createdAt = "2026-02-27T11:01:00.000Z";
      const base = {
        aggregateKind: "thread" as const,
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-restored-steer-marker"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
      };
      yield* eventStore.append({
        ...base,
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-restored-steer-message"),
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "restore the glow",
          dispatchMode: "queue",
          delivery: { state: "queued", queued: true },
          turnId: null,
          streaming: false,
          source: "native",
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* eventStore.append({
        ...base,
        type: "thread.turn-steer-queued-requested",
        eventId: EventId.makeUnsafe("evt-restored-steer-admitted"),
        payload: { threadId, messageId, createdAt },
      });
      yield* projectionPipeline.bootstrap;
      const rows = yield* sql<{ readonly dispatchMode: string | null }>`
        SELECT dispatch_mode AS "dispatchMode"
        FROM projection_thread_messages WHERE message_id = ${messageId}
      `;
      assert.deepEqual(rows, [{ dispatchMode: "steer" }]);
    }),
  );

  it.effect("sequence-fences the durable message delivery lifecycle", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-delivery-lifecycle");
      yield* createThread({
        id: threadId,
        spaceId: "penkra-personal",
        folderId: "project-test",
        sidebarSortOrder: 0,
        title: "Thread",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      const messageId = MessageId.makeUnsafe("message-delivery-lifecycle");
      const createdAt = "2026-02-27T11:02:00.000Z";

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-delivery-admitted"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-delivery-admitted"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delivery-admitted"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "runtime-requeued follow-up",
          dispatchMode: "queue",
          delivery: { state: "starting", queued: false },
          turnId: null,
          streaming: false,
          source: "native",
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* eventStore.append({
        type: "thread.message-delivery-set",
        eventId: EventId.makeUnsafe("evt-delivery-pre-dispatch-failed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-02-27T11:02:00.250Z",
        commandId: CommandId.makeUnsafe("cmd-delivery-pre-dispatch-failed"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delivery-pre-dispatch-failed"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          state: "failed",
          failurePhase: "before-provider-dispatch",
          failureDetail: "EPERM: operation not permitted",
          updatedAt: "2026-02-27T11:02:00.250Z",
        },
      });
      yield* projectionPipeline.bootstrap;
      const failedRows = yield* sql<{
        readonly state: string | null;
        readonly failurePhase: string | null;
        readonly failureDetail: string | null;
      }>`
        SELECT delivery_state AS state,
          delivery_failure_phase AS "failurePhase",
          delivery_failure_detail AS "failureDetail"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.deepEqual(failedRows, [
        {
          state: "failed",
          failurePhase: "before-provider-dispatch",
          failureDetail: "EPERM: operation not permitted",
        },
      ]);
      yield* eventStore.append({
        type: "thread.message-delivery-set",
        eventId: EventId.makeUnsafe("evt-delivery-requeued"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-02-27T11:02:00.500Z",
        commandId: CommandId.makeUnsafe("cmd-delivery-requeued"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delivery-requeued"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          state: "queued",
          queued: true,
          updatedAt: "2026-02-27T11:02:00.500Z",
        },
      });
      yield* eventStore.append({
        type: "thread.message-delivery-set",
        eventId: EventId.makeUnsafe("evt-delivery-accepted"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-02-27T11:02:01.000Z",
        commandId: CommandId.makeUnsafe("cmd-delivery-accepted"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delivery-accepted"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          state: "accepted",
          updatedAt: "2026-02-27T11:02:01.000Z",
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly state: string | null;
        readonly queued: number | null;
        readonly sequence: number | null;
        readonly failurePhase: string | null;
        readonly failureDetail: string | null;
      }>`
        SELECT delivery_state AS state, delivery_queued AS queued,
          delivery_sequence AS sequence,
          delivery_failure_phase AS "failurePhase",
          delivery_failure_detail AS "failureDetail"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.equal(rows[0]?.state, "accepted");
      assert.equal(rows[0]?.queued, 1);
      assert.ok((rows[0]?.sequence ?? 0) > 0);
      assert.equal(rows[0]?.failurePhase, null);
      assert.equal(rows[0]?.failureDetail, null);
    }),
  );

  it.effect("moves an edited user message to its durable replay boundary", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-edit-replay-time");
      yield* createThread({
        id: threadId,
        spaceId: "penkra-personal",
        folderId: "project-test",
        sidebarSortOrder: 0,
        title: "Thread",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      const messageId = MessageId.makeUnsafe("message-edit-replay-time");
      const originalAt = "2026-09-11T10:28:50.952Z";
      const replayAt = "2026-09-11T17:21:54.125Z";

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-edit-replay-original"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: originalAt,
        commandId: CommandId.makeUnsafe("cmd-edit-replay-original"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-edit-replay-original"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "original text",
          turnId: TurnId.makeUnsafe("turn-edit-replay-original"),
          streaming: false,
          source: "native",
          createdAt: originalAt,
          updatedAt: originalAt,
        },
      });
      yield* eventStore.append({
        type: "thread.conversation-rolled-back",
        eventId: EventId.makeUnsafe("evt-edit-replay-rollback"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: replayAt,
        commandId: CommandId.makeUnsafe("cmd-edit-replay-rollback"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-edit-replay-rollback"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          numTurns: 1,
          removedTurnIds: [TurnId.makeUnsafe("turn-edit-replay-original")],
          skipAttachmentPrune: true,
        },
      });
      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-edit-replay-replacement"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: replayAt,
        commandId: CommandId.makeUnsafe("cmd-edit-replay-replacement"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-edit-replay-replacement"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "edited text",
          turnId: TurnId.makeUnsafe("turn-edit-replay-replacement"),
          streaming: false,
          source: "native",
          createdAt: replayAt,
          updatedAt: replayAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly text: string;
        readonly turnId: string | null;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>`
        SELECT text, turn_id AS "turnId", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;

      assert.deepEqual(rows, [
        {
          text: "edited text",
          turnId: "turn-edit-replay-replacement",
          createdAt: replayAt,
          updatedAt: replayAt,
        },
      ]);
    }),
  );

  it.effect("folders the automation dispatch origin onto the triggering user message", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-automation-chip");
      yield* createThread({
        id: threadId,
        spaceId: "penkra-personal",
        folderId: "project-test",
        sidebarSortOrder: 0,
        title: "Thread",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      const messageId = MessageId.makeUnsafe("message-automation-chip");
      const createdAt = "2026-02-27T11:05:00.000Z";

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-automation-chip-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-automation-chip-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-automation-chip-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "run the nightly review",
          dispatchOrigin: "automation",
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly dispatchOrigin: string | null }>`
        SELECT dispatch_origin AS "dispatchOrigin"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
      `;

      assert.deepEqual(rows, [{ dispatchOrigin: "automation" }]);
    }),
  );

  it.effect("folders the agent dispatch origin onto the triggering user message", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-agent-chip");
      yield* createThread({
        id: threadId,
        spaceId: "penkra-personal",
        folderId: "project-test",
        sidebarSortOrder: 0,
        title: "Thread",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      const messageId = MessageId.makeUnsafe("message-agent-chip");
      const createdAt = "2026-02-27T11:06:00.000Z";

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-agent-chip-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-agent-chip-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-agent-chip-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "status check from the coordinating agent",
          dispatchOrigin: "agent",
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly dispatchOrigin: string | null }>`
        SELECT dispatch_origin AS "dispatchOrigin"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
      `;

      assert.deepEqual(rows, [{ dispatchOrigin: "agent" }]);
    }),
  );

  it.effect("preserves exact managed attachment references during projection rebuild", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const managedAttachments = yield* ManagedAttachmentRepository;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-managed-rebuild");
      yield* createThread({
        id: threadId,
        spaceId: "penkra-personal",
        folderId: "project-test",
        sidebarSortOrder: 0,
        title: "Thread",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      const retainedAttachmentId = "att_v2_11111111111111111111111111111111";
      const prunedAttachmentId = "att_v2_22222222222222222222222222222222";
      const retainedLegacyId = "thread-managed-rebuild-11111111-1111-4111-8111-111111111111";
      const prunedLegacyId = "thread-managed-rebuild-22222222-2222-4222-8222-222222222222";
      const retainedMessageId = MessageId.makeUnsafe("message-managed-retained");
      const prunedMessageId = MessageId.makeUnsafe("message-managed-pruned");
      const createdAt = "2020-07-14T14:00:00.000Z";

      for (const [attachmentId, messageId, commandId] of [
        [retainedAttachmentId, retainedMessageId, "command-managed-retained"],
        [prunedAttachmentId, prunedMessageId, "command-managed-pruned"],
      ] as const) {
        const reserved = yield* managedAttachments.reserve({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: "principal",
          ownerId: "principal-managed-rebuild",
          kind: "file",
          originalName: `${attachmentId}.txt`,
          mimeType: "text/plain",
          reservedBytes: 4,
          relativePath: `objects/${attachmentId.slice(7, 9)}/${attachmentId}.txt`,
          now: createdAt,
        });
        assert.strictEqual(reserved.status, "reserved");
        const staged = yield* managedAttachments.finalizeStaged({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: "principal",
          ownerId: "principal-managed-rebuild",
          sizeBytes: 4,
          sha256: "a".repeat(64),
          stagingExpiresAt: "2020-07-14T15:00:00.000Z",
          now: "2020-07-14T14:00:01.000Z",
        });
        assert.strictEqual(staged.status, "staged");
        const claimed = yield* managedAttachments.claimForAcceptedTurn({
          attachmentIds: [attachmentId],
          ownerThreadId: threadId,
          ownerKind: "principal",
          ownerId: "principal-managed-rebuild",
          commandId,
          messageId,
          now: "2020-07-14T14:00:02.000Z",
        });
        assert.strictEqual(claimed.status, "claimed");
      }

      for (const [eventId, commandId, messageId, attachmentId, text, occurredAt] of [
        [
          "evt-managed-rebuild-retained",
          "cmd-managed-rebuild-retained",
          retainedMessageId,
          retainedAttachmentId,
          "retained",
          "2020-07-14T14:00:03.000Z",
        ],
        [
          "evt-managed-rebuild-pruned",
          "cmd-managed-rebuild-pruned",
          prunedMessageId,
          prunedAttachmentId,
          "pruned",
          "2020-07-14T14:00:04.000Z",
        ],
      ] as const) {
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.makeUnsafe(commandId),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(commandId),
          metadata: {},
          payload: {
            threadId,
            messageId,
            role: "user",
            text,
            attachments: [
              {
                type: "file",
                id: attachmentId,
                name: `${text}.txt`,
                mimeType: "text/plain",
                sizeBytes: 4,
              },
              {
                type: "file",
                id: text === "retained" ? retainedLegacyId : prunedLegacyId,
                name: `${text}-legacy.txt`,
                mimeType: "text/plain",
                sizeBytes: 4,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
        });
      }

      yield* eventStore.append({
        type: "thread.conversation-rolled-back",
        eventId: EventId.makeUnsafe("evt-managed-rebuild-rollback"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2020-07-14T14:00:05.000Z",
        commandId: CommandId.makeUnsafe("cmd-managed-rebuild-rollback"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-managed-rebuild-rollback"),
        metadata: {},
        payload: {
          threadId,
          messageId: prunedMessageId,
          numTurns: 1,
          removedTurnIds: [],
        },
      });

      const retainedManagedPath = path.join(
        attachmentsDir,
        `objects/11/${retainedAttachmentId}.txt`,
      );
      const prunedManagedPath = path.join(attachmentsDir, `objects/22/${prunedAttachmentId}.txt`);
      const retainedLegacyPath = path.join(attachmentsDir, `${retainedLegacyId}.txt`);
      const prunedLegacyPath = path.join(attachmentsDir, `${prunedLegacyId}.txt`);
      for (const filePath of [
        retainedManagedPath,
        prunedManagedPath,
        retainedLegacyPath,
        prunedLegacyPath,
      ]) {
        yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fileSystem.writeFileString(filePath, "data");
      }

      const highWaterSequence = yield* eventStore.getHighWaterSequence();
      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      assert.isTrue(yield* exists(retainedLegacyPath));
      assert.isFalse(yield* exists(prunedLegacyPath));
      assert.isTrue(yield* exists(retainedManagedPath));
      assert.isTrue(yield* exists(prunedManagedPath));

      const messages = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(messages, [{ messageId: retainedMessageId }]);

      const blobs = yield* sql<{ readonly attachmentId: string; readonly state: string }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        WHERE owner_thread_id = ${threadId}
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(blobs, [
        { attachmentId: retainedAttachmentId, state: "claimed" },
        { attachmentId: prunedAttachmentId, state: "deleting" },
      ]);

      const cleanupJobs = yield* sql<{
        readonly attachmentId: string;
        readonly reason: string;
      }>`
        SELECT attachment_id AS "attachmentId", reason
        FROM managed_attachment_cleanup_jobs
        WHERE attachment_id IN (${retainedAttachmentId}, ${prunedAttachmentId})
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(cleanupJobs, [
        { attachmentId: prunedAttachmentId, reason: "projection-pruned" },
      ]);

      const projectorState = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}
      `;
      assert.deepStrictEqual(projectorState, [{ lastAppliedSequence: highWaterSequence }]);

      yield* runManagedAttachmentCleanupBatch;
      assert.isTrue(yield* exists(retainedLegacyPath));
      assert.isTrue(yield* exists(retainedManagedPath));
      assert.isFalse(yield* exists(prunedManagedPath));
      const completedBlobs = yield* sql<{
        readonly attachmentId: string;
        readonly state: string;
      }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        WHERE owner_thread_id = ${threadId}
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(completedBlobs, [
        { attachmentId: retainedAttachmentId, state: "claimed" },
        { attachmentId: prunedAttachmentId, state: "deleted" },
      ]);
    }),
  );
});
