import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  FolderId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asFolderId = (value: string): FolderId => FolderId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates Space identity and project assignments in full and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_spaces`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          'space-snapshot', 'Snapshot Space', 'bag', 0,
          '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:01.000Z', NULL, NULL
        ), (
          'space-archived-snapshot', 'Archived Snapshot Space', 'book', 1,
          '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:02.000Z',
          '2026-07-20T00:00:02.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json,
          scripts_json, space_id, created_at, updated_at, deleted_at
        ) VALUES (
          'project-space-snapshot', 'Space project', '/tmp/space-project', NULL,
          '[]', 'space-snapshot', '2026-07-20T00:00:00.000Z',
          '2026-07-20T00:00:01.000Z', NULL
        )
      `;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 7, '2026-07-20T00:00:01.000Z')
        `;
      }

      const shell = yield* snapshotQuery.getShellSnapshot();
      const full = yield* snapshotQuery.getSnapshot();
      assert.equal(shell.spaces[0]?.id, SpaceId.makeUnsafe("space-snapshot"));
      assert.equal(shell.archivedSpaces?.[0]?.id, SpaceId.makeUnsafe("space-archived-snapshot"));
      assert.equal(shell.folders[0]?.spaceId, SpaceId.makeUnsafe("space-snapshot"));
      assert.equal(full.spaces[0]?.id, SpaceId.makeUnsafe("space-snapshot"));
      assert.equal(
        full.spaces.find((space) => space.id === "space-archived-snapshot")?.archivedAt,
        "2026-07-20T00:00:02.000Z",
      );
      assert.equal(full.folders[0]?.spaceId, SpaceId.makeUnsafe("space-snapshot"));

      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_spaces`;
      yield* sql`DELETE FROM projection_state`;
    }),
  );

  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build"}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          folder_id,
          title,
          model_selection_json,
          working_directory,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          NULL,
          'turn-1',
          '2026-02-24T00:00:03.500Z',
          1,
          1,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-0',
            'thread-1',
            'turn-1',
            'user',
            'ship it',
            0,
            '2026-02-24T00:00:03.500Z',
            '2026-02-24T00:00:03.500Z'
          ),
          (
            'message-1',
            'thread-1',
            'turn-1',
            'assistant',
            'hello from projection',
            0,
            '2026-02-24T00:00:04.000Z',
            '2026-02-24T00:00:05.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES
          (
            'activity-1',
            'thread-1',
            'turn-1',
            'info',
            'runtime.note',
            'provider started',
            '{"stage":"start"}',
            '2026-02-24T00:00:06.000Z'
          ),
          (
            'activity-2',
            'thread-1',
            'turn-1',
            'approval',
            'approval.requested',
            'Command approval requested',
            '{"requestId":"approval-1","requestKind":"command"}',
            '2026-02-24T00:00:06.500Z'
          ),
          (
            'activity-3',
            'thread-1',
            'turn-1',
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"input-1","questions":[{"id":"q-1","header":"Mode","question":"Choose","options":[{"label":"A","description":"Pick A"}]}]}',
            '2026-02-24T00:00:06.750Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          provider_turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at
        )
        VALUES
          (
            'thread-1',
            'turn-1',
            'provider-turn-1',
            NULL,
            'message-1',
            'completed',
            '2026-02-24T00:00:08.000Z',
            '2026-02-24T00:00:08.000Z',
            '2026-02-24T00:00:08.000Z'
          ),
          (
            'thread-1',
            'turn-placeholder',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-02-24T00:00:07.500Z',
            '2026-02-24T00:00:07.500Z',
            NULL
          )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();
      const commandModel = yield* snapshotQuery.getCommandReadModel();

      const commandThread = commandModel.threads[0];
      assert.isDefined(commandThread);
      assert.equal(commandThread.latestUserMessageAt, "2026-02-24T00:00:03.500Z");
      assert.equal(commandThread.hasPendingApprovals, true);
      assert.equal(commandThread.hasPendingUserInput, true);
      assert.deepEqual(commandThread.messages, []);
      assert.deepEqual(commandThread.activities, []);
      assert.deepEqual(commandThread.pendingInteractions, []);

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.folders, [
        {
          id: asFolderId("project-1"),
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
            },
          ],
          iconDataUrl: null,
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          archivedAt: null,
          deletedAt: null,
          isPinned: false,
          sidebarSortOrder: 0,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          folderId: asFolderId("project-1"),
          title: "Thread 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          workingDirectory: null,
          isPinned: false,
          sidebarSortOrder: 0,
          parentThreadId: null,
          creationSource: null,
          sourceThreadId: null,
          sourceTurnId: null,
          gatewayOperationId: null,
          gatewayOperationIndex: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          latestUserMessageAt: "2026-02-24T00:00:03.500Z",
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          workStatus: "attention",
          lastMessagePreview: "hello from projection",
          lastActivityAt: "2026-02-24T00:00:06.750Z",
          latestTurn: {
            turnId: asTurnId("turn-1"),
            providerTurnId: asTurnId("provider-turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
          },
          pendingTurnStartMessageId: null,
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-0"),
              role: "user",
              text: "ship it",
              turnId: asTurnId("turn-1"),
              streaming: false,
              source: "native",
              createdAt: "2026-02-24T00:00:03.500Z",
              updatedAt: "2026-02-24T00:00:03.500Z",
            },
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              source: "native",
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          queuedMessageIds: [],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
            {
              id: asEventId("activity-2"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Command approval requested",
              payload: { requestId: "approval-1", requestKind: "command" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.500Z",
            },
            {
              id: asEventId("activity-3"),
              tone: "info",
              kind: "user-input.requested",
              summary: "User input requested",
              payload: {
                requestId: "input-1",
                questions: [
                  {
                    id: "q-1",
                    header: "Mode",
                    question: "Choose",
                    options: [{ label: "A", description: "Pick A" }],
                  },
                ],
              },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.750Z",
            },
          ],
          pendingInteractions: [],
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);

      yield* sql`
        UPDATE projection_thread_messages
        SET is_streaming = 1
        WHERE message_id = 'message-1'
      `;
      assert.deepEqual(yield* snapshotQuery.listStreamingAssistantMessages(), [
        {
          threadId: asThreadId("thread-1"),
          messageId: asMessageId("message-1"),
          turnId: asTurnId("turn-1"),
        },
      ]);
      yield* sql`
        UPDATE projection_thread_messages
        SET is_streaming = 0
        WHERE message_id = 'message-1'
      `;
    }),
  );

  it.effect("limits hydrated thread activities to the latest activity window", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-activity-cap',
          'Project Activity Cap',
          '/tmp/project-activity-cap',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          folder_id,
          title,
          model_selection_json,
          working_directory,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-activity-cap',
          'project-activity-cap',
          'Thread Activity Cap',
          '{"provider":"codex","model":"gpt-5-codex"}',
          NULL,
          NULL,
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'approval-old',
          'thread-activity-cap',
          NULL,
          'approval',
          'approval.requested',
          'Command approval requested',
          '{"requestId":"approval-1","requestKind":"command"}',
          0,
          '2026-02-24T00:00:00.000Z'
        )
      `;

      for (let index = 0; index < 505; index += 1) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES (
            ${`activity-${index}`},
            'thread-activity-cap',
            NULL,
            'tool',
            'tool.completed',
            'Tool completed',
            '{"stage":"completed"}',
            ${index + 1},
            '2026-02-24T00:00:00.000Z'
          )
        `;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();
      const snapshotActivities = snapshot.threads[0]?.activities ?? [];
      assert.equal(snapshotActivities.length, 501);
      assert.equal(snapshotActivities[0]?.id, asEventId("approval-old"));
      assert.equal(snapshotActivities[1]?.id, asEventId("activity-5"));
      assert.equal(snapshotActivities.at(-1)?.id, asEventId("activity-504"));

      // Thread detail keeps a far deeper window (2_000) than the bulk snapshot,
      // so the same 506-row thread is returned whole - including the activities
      // the snapshot had to drop.
      const detail = yield* snapshotQuery.getThreadDetailById(asThreadId("thread-activity-cap"));
      assert.isTrue(Option.isSome(detail));
      const detailActivities = Option.isSome(detail) ? detail.value.activities : [];
      assert.equal(detailActivities.length, 506);
      assert.equal(detailActivities[0]?.id, asEventId("approval-old"));
      assert.equal(detailActivities[1]?.id, asEventId("activity-0"));
      assert.equal(detailActivities.at(-1)?.id, asEventId("activity-504"));

      yield* sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = 'thread-activity-cap'
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'approval-old',
            'thread-activity-cap',
            NULL,
            'approval',
            'approval.requested',
            'Command approval requested',
            '{"requestId":"approval-1","requestKind":"command"}',
            0,
            '2026-02-24T00:00:00.000Z'
          ),
          (
            'approval-resolved-old',
            'thread-activity-cap',
            NULL,
            'approval',
            'approval.resolved',
            'Command approval resolved',
            '{"requestId":"approval-1","decision":"accept"}',
            1,
            '2026-02-24T00:00:00.000Z'
          )
      `;

      for (let index = 0; index < 505; index += 1) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES (
            ${`resolved-activity-${index}`},
            'thread-activity-cap',
            NULL,
            'tool',
            'tool.completed',
            'Tool completed',
            '{"stage":"completed"}',
            ${index + 2},
            '2026-02-24T00:00:00.000Z'
          )
        `;
      }

      const resolvedSnapshot = yield* snapshotQuery.getSnapshot();
      const resolvedSnapshotActivities = resolvedSnapshot.threads[0]?.activities ?? [];
      assert.equal(resolvedSnapshotActivities.length, 500);
      assert.equal(resolvedSnapshotActivities[0]?.id, asEventId("resolved-activity-5"));
      assert.equal(resolvedSnapshotActivities.at(-1)?.id, asEventId("resolved-activity-504"));

      const resolvedDetail = yield* snapshotQuery.getThreadDetailById(
        asThreadId("thread-activity-cap"),
      );
      assert.isTrue(Option.isSome(resolvedDetail));
      const resolvedDetailActivities = Option.isSome(resolvedDetail)
        ? resolvedDetail.value.activities
        : [];
      assert.equal(resolvedDetailActivities.length, 507);
      assert.equal(resolvedDetailActivities[0]?.id, asEventId("approval-old"));
      assert.equal(resolvedDetailActivities[1]?.id, asEventId("approval-resolved-old"));
      assert.equal(resolvedDetailActivities.at(-1)?.id, asEventId("resolved-activity-504"));

      // Canonical notices have no legacy sequence. A newer canonical resolution
      // must still suppress an older request that sits outside the raw snapshot
      // window; otherwise the UI resurrects an already-settled approval.
      yield* sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = 'thread-activity-cap'
      `;
      yield* sql`DELETE FROM notices WHERE thread_id = 'thread-activity-cap'`;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        ) VALUES (
          'approval-old', 'thread-activity-cap', NULL, 'approval',
          'approval.requested', 'Command approval requested',
          '{"requestId":"approval-1","requestKind":"command"}', 0,
          '2026-02-24T00:00:00.000Z'
        )
      `;
      for (let index = 0; index < 505; index += 1) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary,
            payload_json, sequence, created_at
          ) VALUES (
            ${`canonical-resolution-activity-${index}`},
            'thread-activity-cap', NULL, 'tool', 'tool.completed',
            'Tool completed', '{"stage":"completed"}', ${index + 1},
            '2026-02-24T00:00:00.000Z'
          )
        `;
      }
      yield* sql`
        INSERT INTO notices (
          notice_id, thread_id, turn_id, kind, tone, summary, detail_json, created_at
        ) VALUES (
          'approval-resolved-canonical', 'thread-activity-cap', NULL,
          'approval.resolved', 'info', 'Command approval resolved',
          '{"requestId":"approval-1","decision":"accept"}',
          '2026-02-24T00:00:01.000Z'
        )
      `;

      const canonicalResolvedSnapshot = yield* snapshotQuery.getSnapshot();
      const canonicalResolvedActivities = canonicalResolvedSnapshot.threads[0]?.activities ?? [];
      assert.equal(canonicalResolvedActivities.length, 500);
      assert.equal(
        canonicalResolvedActivities[0]?.id,
        asEventId("canonical-resolution-activity-6"),
      );
      assert.equal(
        canonicalResolvedActivities.at(-1)?.id,
        asEventId("approval-resolved-canonical"),
      );
      assert.isFalse(
        canonicalResolvedActivities.some((activity) => activity.id === asEventId("approval-old")),
      );
    }),
  );

  it.effect("keeps newer canonical operations inside long-thread activity windows", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM operations`;
      yield* sql`DELETE FROM notices`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-canonical-window', 'Canonical window', '/tmp/canonical-window',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, working_directory,
          latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-canonical-window', 'project-canonical-window', 'Canonical Window',
          '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
          '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        )
        WITH RECURSIVE sequences(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM sequences WHERE n < 2_100
        )
        SELECT
          'legacy-' || n, 'thread-canonical-window', 'turn-legacy', 'tool',
          'tool.completed', 'Legacy tool', '{}', n,
          strftime('%Y-%m-%dT%H:%M:%fZ', '2026-08-19T00:00:00.000Z', '+' || n || ' seconds')
        FROM sequences
      `;
      yield* sql`
        INSERT INTO operations (
          operation_id, provider_operation_id, thread_id, turn_id, provider, item_type,
          title, status, input_json, activity_json, started_at, ended_at,
          last_source_event_id, updated_at
        ) VALUES (
          'canonical-current', 'provider-current', 'thread-canonical-window', 'turn-current',
          'codex', 'dynamic_tool_call', 'Current tool', 'running', '{"query":"TODO"}',
          '{"tone":"tool","kind":"tool.updated","summary":"Current tool","payload":{"operationId":"provider-current"}}',
          '2026-08-20T00:00:00.000Z', NULL, 'current-event', '2026-08-20T00:00:00.000Z'
        )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const snapshotActivities = snapshot.threads[0]?.activities ?? [];
      assert.equal(snapshotActivities.length, 500);
      assert.equal(snapshotActivities.at(-1)?.id, asEventId("canonical-current"));

      const detail = yield* snapshotQuery.getThreadDetailById(
        asThreadId("thread-canonical-window"),
      );
      assert.isTrue(Option.isSome(detail));
      const detailActivities = Option.isSome(detail) ? detail.value.activities : [];
      // The older legacy turn straddles the raw cap and is dropped as a whole;
      // the newer canonical turn must still survive that boundary alignment.
      assert.equal(detailActivities.length, 1);
      assert.equal(detailActivities.at(-1)?.id, asEventId("canonical-current"));
      assert.equal(detailActivities.at(-1)?.sequence, undefined);
    }),
  );

  it.effect("aligns the thread detail activity window to a turn boundary", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-turn-window', 'Turn window', '/tmp/turn-window',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, working_directory,
          latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-turn-window', 'project-turn-window', 'Turn Window',
          '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL
        )
      `;

      // 2_150 scoped activities across three turns, plus two newer unscoped
      // metadata rows. The raw 2_000-row detail cap falls at sequence 153 - in
      // the middle of `turn-cutoff` (51..250):
      //   turn-old    -> sequence 1..50      (fully outside the window)
      //   turn-cutoff -> sequence 51..250    (straddles the cap)
      //   turn-recent -> sequence 251..2150
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        )
        WITH RECURSIVE sequences(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM sequences WHERE n < 2150
        )
        SELECT
          'activity-' || n,
          'thread-turn-window',
          CASE
            WHEN n <= 50 THEN 'turn-old'
            WHEN n <= 250 THEN 'turn-cutoff'
            ELSE 'turn-recent'
          END,
          'tool',
          'tool.completed',
          'Tool completed',
          '{"stage":"completed"}',
          n,
          '2026-02-24T00:00:00.000Z'
        FROM sequences
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        ) VALUES
          (
            'activity-unscoped-1', 'thread-turn-window', NULL, 'info',
            'account.rate-limits.updated', 'Rate limits updated', '{}', 2151,
            '2026-02-24T00:00:00.000Z'
          ),
          (
            'activity-unscoped-2', 'thread-turn-window', NULL, 'info',
            'account.rate-limits.updated', 'Rate limits updated', '{}', 2152,
            '2026-02-24T00:00:00.000Z'
          )
      `;

      const detail = yield* snapshotQuery.getThreadDetailById(asThreadId("thread-turn-window"));
      assert.isTrue(Option.isSome(detail));
      const detailActivities = Option.isSome(detail) ? detail.value.activities : [];

      // The partial `turn-cutoff` is dropped rather than extending the query
      // beyond its budget. The complete recent turn remains intact.
      assert.equal(detailActivities.length, 1_902);
      assert.equal(detailActivities[0]?.id, asEventId("activity-251"));
      assert.equal(detailActivities[0]?.turnId, asTurnId("turn-recent"));
      assert.equal(detailActivities.at(-1)?.id, asEventId("activity-unscoped-2"));
      assert.equal(
        detailActivities.filter((activity) => activity.turnId === asTurnId("turn-cutoff")).length,
        0,
      );
      // Turns entirely older than the window are still dropped.
      assert.isFalse(detailActivities.some((activity) => activity.turnId === asTurnId("turn-old")));

      // The bulk snapshot keeps its own, much smaller cap and does not turn-align.
      const snapshot = yield* snapshotQuery.getSnapshot();
      const snapshotActivities = snapshot.threads[0]?.activities ?? [];
      assert.equal(snapshotActivities.length, 500);
      assert.equal(snapshotActivities[0]?.id, asEventId("activity-1653"));
      assert.equal(snapshotActivities.at(-1)?.id, asEventId("activity-unscoped-2"));
    }),
  );

  it.effect("keeps a single oversized turn capped instead of dropping the whole window", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-oversized-turn', 'Oversized turn', '/tmp/oversized-turn',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, working_directory,
          latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-oversized-turn', 'project-oversized-turn', 'Oversized Turn',
          '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        )
        WITH RECURSIVE sequences(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM sequences WHERE n < 2150
        )
        SELECT
          'oversized-activity-' || n,
          'thread-oversized-turn',
          'turn-oversized',
          'tool',
          'tool.completed',
          'Tool completed',
          '{"stage":"completed"}',
          n,
          '2026-02-24T00:00:00.000Z'
        FROM sequences
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        ) VALUES
          (
            'oversized-unscoped-1', 'thread-oversized-turn', NULL, 'info',
            'account.rate-limits.updated', 'Rate limits updated', '{}', 2151,
            '2026-02-24T00:00:00.000Z'
          ),
          (
            'oversized-unscoped-2', 'thread-oversized-turn', NULL, 'info',
            'account.rate-limits.updated', 'Rate limits updated', '{}', 2152,
            '2026-02-24T00:00:00.000Z'
          )
      `;

      const detail = yield* snapshotQuery.getThreadDetailById(asThreadId("thread-oversized-turn"));
      assert.isTrue(Option.isSome(detail));
      const activities = Option.isSome(detail) ? detail.value.activities : [];

      assert.equal(activities.length, 2_000);
      assert.equal(activities[0]?.id, asEventId("oversized-activity-153"));
      assert.equal(activities.at(-1)?.id, asEventId("oversized-unscoped-2"));
      assert.equal(
        activities.filter((activity) => activity.turnId === asTurnId("turn-oversized")).length,
        1_998,
      );
    }),
  );

  it.effect("keeps UI thread detail capped while export detail includes all messages", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-export-message-cap");
      const messageCount = 2_005;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_pending_interactions`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_folders`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-export-message-cap',
          'Project Export Message Cap',
          '/tmp/project-export-message-cap',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          folder_id,
          title,
          model_selection_json,
          working_directory,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-export-message-cap',
          'project-export-message-cap',
          'Thread Export Message Cap',
          '{"provider":"codex","model":"gpt-5-codex"}',
          NULL,
          NULL,
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL
        )
      `;

      for (let index = 0; index < messageCount; index += 1) {
        const createdAt = new Date(Date.UTC(2026, 1, 24, 0, 0, index)).toISOString();
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            is_streaming,
            created_at,
            updated_at
          )
          VALUES (
            ${`message-${index}`},
            'thread-export-message-cap',
            NULL,
            'assistant',
            ${`message ${index}`},
            0,
            ${createdAt},
            ${createdAt}
          )
        `;
      }

      const cappedDetail = yield* snapshotQuery.getThreadDetailById(threadId);
      const exportDetail = yield* snapshotQuery.getThreadDetailForExportById(threadId);

      assert.isTrue(Option.isSome(cappedDetail));
      assert.isTrue(Option.isSome(exportDetail));
      const cappedMessages = Option.isSome(cappedDetail) ? cappedDetail.value.messages : [];
      const exportMessages = Option.isSome(exportDetail) ? exportDetail.value.messages : [];
      assert.equal(cappedMessages.length, 2_000);
      assert.equal(cappedMessages[0]?.text, "message 5");
      assert.equal(cappedMessages.at(-1)?.text, "message 2004");
      assert.equal(exportMessages.length, messageCount);
      assert.equal(exportMessages[0]?.text, "message 0");
      assert.equal(exportMessages.at(-1)?.text, "message 2004");
    }),
  );

  it.effect("orders snapshot and thread-detail messages by server sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-causal-message-snapshot");

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_pending_interactions`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-causal-message-snapshot', 'Causal Message Snapshot',
          '/tmp/project-causal-message-snapshot',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, working_directory,
          latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-causal-message-snapshot', 'project-causal-message-snapshot',
          'Causal Message Snapshot', '{"provider":"codex","model":"gpt-5-codex"}',
          NULL, NULL,
          '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, source,
          sequence, created_at, updated_at
        ) VALUES
          (
            'message-causal-first', 'thread-causal-message-snapshot', NULL, 'user',
            'accepted first', 0, 'native', 10,
            '2026-07-14T12:10:00.000Z', '2026-07-14T12:10:00.000Z'
          ),
          (
            'message-causal-second', 'thread-causal-message-snapshot', NULL, 'assistant',
            'accepted second despite older clock', 0, 'native', 11,
            '2026-07-14T11:59:00.000Z', '2026-07-14T11:59:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_pending_interactions (
          interaction_kind, request_id, thread_id, turn_id, lifecycle_generation, status,
          decision, response_command_id, response_requested_at, created_at, resolved_at
        ) VALUES
          (
            'userInput', 'request-retryable', 'thread-causal-message-snapshot', NULL,
            'generation-current', 'retryable', NULL, 'command-response',
            '2026-07-14T12:11:00.000Z', '2026-07-14T12:10:30.000Z', NULL
          ),
          (
            'approval', 'request-confirmed', 'thread-causal-message-snapshot', NULL,
            'generation-current', 'confirmed', 'accept', 'command-approval',
            '2026-07-14T12:12:00.000Z', '2026-07-14T12:11:30.000Z',
            '2026-07-14T12:12:01.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      const expectedPendingInteractions = [
        {
          interactionKind: "userInput" as const,
          requestId: ApprovalRequestId.makeUnsafe("request-retryable"),
          threadId,
          turnId: null,
          lifecycleGeneration: "generation-current",
          status: "retryable" as const,
          decision: null,
          responseCommandId: CommandId.makeUnsafe("command-response"),
          responseRequestedAt: "2026-07-14T12:11:00.000Z",
          createdAt: "2026-07-14T12:10:30.000Z",
          resolvedAt: null,
        },
      ];
      assert.isTrue(Option.isSome(detail));
      assert.deepStrictEqual(
        snapshot.threads[0]?.messages.map((message) => message.id),
        [asMessageId("message-causal-first"), asMessageId("message-causal-second")],
      );
      assert.deepStrictEqual(
        Option.isSome(detail) ? detail.value.messages.map((message) => message.id) : [],
        [asMessageId("message-causal-first"), asMessageId("message-causal-second")],
      );
      assert.deepStrictEqual(snapshot.threads[0]?.pendingInteractions, expectedPendingInteractions);
      assert.deepStrictEqual(
        Option.isSome(detail) ? detail.value.pendingInteractions : [],
        expectedPendingInteractions,
      );
    }),
  );

  it.effect("normalizes imported Penkra model-selection shapes from projection reads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_sessions`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-imported-shape',
          'Imported Shape Project',
          '/tmp/imported-shape',
          '{"instanceId":"codex","model":"imported-project-model","options":[{"id":"reasoningEffort","value":"medium"}]}',
          '[]',
          '2026-05-05T14:39:18.000Z',
          '2026-05-05T14:39:19.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          folder_id,
          title,
          model_selection_json,
          working_directory,
          runtime_mode,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-imported-shape',
          'project-imported-shape',
          'Imported Shape Thread',
          '{"provider":"codex","model":"gpt-5.5","options":[{"id":"reasoningEffort","value":"medium"}]}',
          NULL,
          'full-access',
          NULL,
          '2026-05-05T14:39:20.000Z',
          '2026-05-05T14:39:21.000Z',
          NULL
        )
      `;

      const expectedProjectSelection = {
        provider: "codex",
        model: "imported-project-model",
        options: { reasoningEffort: "medium" },
      } as const;
      const expectedThreadSelection = {
        provider: "codex",
        model: "gpt-5.5",
        options: { reasoningEffort: "medium" },
      } as const;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      const activeProject =
        yield* snapshotQuery.getActiveFolderByWorkspaceRoot("/tmp/imported-shape");
      const projectShell = yield* snapshotQuery.getFolderShellById(
        asFolderId("project-imported-shape"),
      );
      const threadShell = yield* snapshotQuery.getThreadShellById(
        asThreadId("thread-imported-shape"),
      );
      const threadDetail = yield* snapshotQuery.getThreadDetailById(
        asThreadId("thread-imported-shape"),
      );
      const threadDetailSnapshot = yield* snapshotQuery.getThreadDetailSnapshotById(
        asThreadId("thread-imported-shape"),
      );

      assert.deepStrictEqual(
        snapshot.folders.find((project) => project.id === "project-imported-shape")
          ?.defaultModelSelection,
        expectedProjectSelection,
      );
      assert.deepStrictEqual(
        snapshot.threads.find((thread) => thread.id === "thread-imported-shape")?.modelSelection,
        expectedThreadSelection,
      );
      assert.deepStrictEqual(
        shellSnapshot.folders.find((project) => project.id === "project-imported-shape")
          ?.defaultModelSelection,
        expectedProjectSelection,
      );
      assert.deepStrictEqual(
        shellSnapshot.threads.find((thread) => thread.id === "thread-imported-shape")
          ?.modelSelection,
        expectedThreadSelection,
      );
      assert.deepStrictEqual(
        Option.getOrNull(activeProject)?.defaultModelSelection,
        expectedProjectSelection,
      );
      assert.equal(Option.getOrNull(activeProject)?.sidebarSortOrder, 0);
      assert.deepStrictEqual(
        Option.getOrNull(projectShell)?.defaultModelSelection,
        expectedProjectSelection,
      );
      assert.equal(Option.getOrNull(projectShell)?.sidebarSortOrder, 0);
      assert.deepStrictEqual(
        Option.getOrNull(threadShell)?.modelSelection,
        expectedThreadSelection,
      );
      assert.deepStrictEqual(
        Option.getOrNull(threadDetail)?.modelSelection,
        expectedThreadSelection,
      );
      assert.deepStrictEqual(
        Option.getOrNull(threadDetailSnapshot)?.thread.modelSelection,
        expectedThreadSelection,
      );
    }),
  );

  it.effect("reads aggregate counts and cheap lookups without hydrating the full snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_threads`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            NULL,
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          folder_id,
          title,
          model_selection_json,
          runtime_mode,
          working_directory,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

      const counts = yield* snapshotQuery.getCounts();
      assert.deepEqual(counts, {
        folderCount: 2,
        threadCount: 3,
      });

      const project = yield* snapshotQuery.getActiveFolderByWorkspaceRoot("/tmp/workspace");
      assert.equal(project._tag, "Some");
      if (project._tag === "Some") {
        assert.equal(project.value.id, asFolderId("project-active"));
      }

      const missingProject = yield* snapshotQuery.getActiveFolderByWorkspaceRoot("/tmp/missing");
      assert.equal(missingProject._tag, "None");

      const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByFolderId(
        asFolderId("project-active"),
      );
      assert.equal(firstThreadId._tag, "Some");
      if (firstThreadId._tag === "Some") {
        assert.equal(firstThreadId.value, ThreadId.makeUnsafe("thread-first"));
      }
    }),
  );

  it.effect("hydrates shell reads from stored thread summary columns", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-shell',
          'Shell Project',
          '/tmp/project-shell',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-03-03T00:00:00.000Z',
          '2026-03-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          folder_id,
          title,
          model_selection_json,
          runtime_mode,
          working_directory,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-shell',
          'project-shell',
          'Shell Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          NULL,
          'turn-shell',
          '2026-03-03T00:00:02.500Z',
          2,
          1,
          '2026-03-03T00:00:02.000Z',
          '2026-03-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-shell',
          'ready',
          'codex',
          'provider-session-shell',
          'provider-thread-shell',
          'full-access',
          NULL,
          NULL,
          '2026-03-03T00:00:04.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at
        )
        VALUES (
          'thread-shell',
          'turn-shell',
          NULL,
          NULL,
          'completed',
          '2026-03-03T00:00:05.000Z',
          '2026-03-03T00:00:05.000Z',
          '2026-03-03T00:00:05.000Z'
        )
      `;

      let sequence = 20;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-03-03T00:00:06.000Z'
          )
        `;
        sequence += 1;
      }

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.makeUnsafe("thread-shell"),
          folderId: asFolderId("project-shell"),
          title: "Shell Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          workingDirectory: null,
          isPinned: false,
          sidebarSortOrder: 0,
          parentThreadId: null,
          creationSource: null,
          sourceThreadId: null,
          sourceTurnId: null,
          gatewayOperationId: null,
          gatewayOperationIndex: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          latestTurn: {
            turnId: asTurnId("turn-shell"),
            state: "completed",
            requestedAt: "2026-03-03T00:00:05.000Z",
            startedAt: "2026-03-03T00:00:05.000Z",
            completedAt: "2026-03-03T00:00:05.000Z",
            assistantMessageId: null,
          },
          latestUserMessageAt: "2026-03-03T00:00:02.500Z",
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          workStatus: "attention",
          lastMessagePreview: null,
          lastActivityAt: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          session: {
            threadId: ThreadId.makeUnsafe("thread-shell"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-03-03T00:00:04.000Z",
          },
        },
      ]);

      const threadShell = yield* snapshotQuery.getThreadShellById(
        ThreadId.makeUnsafe("thread-shell"),
      );
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.deepEqual(threadShell.value, shellSnapshot.threads[0]);
      }
    }),
  );

  it.effect("lists only stale active thread ids for reconciliation, oldest first", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-runtime-candidates', 'Runtime candidates', '/tmp/runtime-candidates',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, working_directory,
          latest_turn_id, created_at, updated_at, archived_at, deleted_at
        ) VALUES
          (
            'thread-stale-running', 'project-runtime-candidates', 'Stale',
            '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z', NULL, NULL
          ),
          (
            'thread-fresh-running', 'project-runtime-candidates', 'Fresh',
            '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
            '2026-07-23T00:00:00.000Z', '2026-07-23T09:59:00.000Z', NULL, NULL
          ),
          (
            'thread-settled', 'project-runtime-candidates', 'Settled',
            '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z', NULL, NULL
          ),
          (
            'thread-archived-running', 'project-runtime-candidates', 'Archived',
            '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z',
            '2026-07-23T08:00:00.000Z', NULL
          ),
          (
            'thread-unbound-oldest', 'project-runtime-candidates', 'Unbound',
            '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
            '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z', NULL, NULL
          ),
          (
            'thread-queued-oldest', 'project-runtime-candidates', 'Queued',
            '{"provider":"codex","model":"gpt-5-codex"}', NULL, 'turn-queued',
            '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', NULL, NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at,
          started_at, completed_at
        ) VALUES
          (
            'thread-queued-oldest', 'turn-queued-old', NULL, NULL, 'running',
            '2026-07-20T23:59:00.000Z', '2026-07-20T23:59:01.000Z', NULL
          ),
          (
            'thread-queued-oldest', 'turn-queued', NULL, NULL, 'pending',
            '2026-07-21T00:00:00.000Z', NULL, NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, provider_thread_id,
          runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES
          (
            'thread-stale-running', 'running', 'codex', NULL, NULL,
            'full-access', 'turn-stale', NULL, '2026-07-23T00:00:00.000Z'
          ),
          (
            'thread-fresh-running', 'running', 'codex', NULL, NULL,
            'full-access', 'turn-fresh', NULL, '2026-07-23T09:59:00.000Z'
          ),
          (
            'thread-settled', 'ready', 'codex', NULL, NULL,
            'full-access', NULL, NULL, '2026-07-23T00:00:00.000Z'
          ),
          (
            'thread-archived-running', 'running', 'codex', NULL, NULL,
            'full-access', 'turn-archived', NULL, '2026-07-23T00:00:00.000Z'
          ),
          (
            'thread-unbound-oldest', 'running', 'codex', NULL, NULL,
            'full-access', 'turn-unbound', NULL, '2026-07-22T00:00:00.000Z'
          ),
          (
            'thread-queued-oldest', 'starting', 'codex', NULL, NULL,
            'full-access', NULL, NULL, '2026-07-21T00:00:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, runtime_mode, status,
          lifecycle_generation, last_seen_at, runtime_payload_json
        ) VALUES
          (
            'thread-stale-running', 'codex', 'codex', 'full-access', 'running',
            'generation-stale', '2026-07-23T00:00:00.000Z', NULL
          ),
          (
            'thread-fresh-running', 'codex', 'codex', 'full-access', 'running',
            'generation-fresh', '2026-07-23T09:59:00.000Z', NULL
          ),
          (
            'thread-queued-oldest', 'codex', 'codex', 'full-access', 'starting',
            'generation-queued', '2026-07-21T00:00:00.000Z', '{}'
          )
        ON CONFLICT (thread_id) DO UPDATE SET
          provider_name = excluded.provider_name,
          adapter_key = excluded.adapter_key,
          runtime_mode = excluded.runtime_mode,
          status = excluded.status,
          lifecycle_generation = excluded.lifecycle_generation,
          last_seen_at = excluded.last_seen_at,
          runtime_payload_json = excluded.runtime_payload_json
      `;

      assert.deepEqual(yield* snapshotQuery.listOpenTurnCounts(), [
        { threadId: ThreadId.makeUnsafe("thread-queued-oldest"), count: 2 },
      ]);

      const candidates = yield* snapshotQuery.listStaleInFlightThreadIds({
        updatedBefore: "2026-07-23T09:00:00.000Z",
        limit: 10,
      });

      // Candidacy covers every thread whose projection still claims an active
      // turn past the staleness cutoff, including threads whose runtime binding
      // row is already gone (`thread-unbound-oldest`) and archived threads
      // (`thread-archived-running`) - archiving does not settle a live turn.
      // Excluded: `thread-fresh-running` (updated after the cutoff),
      // `thread-settled` (no active turn), and `thread-queued-oldest` (a pending
      // turn with no active turn id on either the session or the runtime row).
      assert.deepEqual(candidates, [
        ThreadId.makeUnsafe("thread-unbound-oldest"),
        ThreadId.makeUnsafe("thread-archived-running"),
        ThreadId.makeUnsafe("thread-stale-running"),
      ]);

      // Oldest-first ordering, so a bounded sweep drains the longest-stuck
      // threads first.
      const oldestCandidate = yield* snapshotQuery.listStaleInFlightThreadIds({
        updatedBefore: "2026-07-23T09:00:00.000Z",
        limit: 1,
      });
      assert.deepEqual(oldestCandidate, [ThreadId.makeUnsafe("thread-unbound-oldest")]);
    }),
  );

  it.effect("excludes soft-deleted thread bodies from the full snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-soft-delete', 'Soft delete', '/tmp/soft-delete',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, working_directory,
          latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES
          (
            'thread-live', 'project-soft-delete', 'Live',
            '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
            '2026-07-24T00:00:01.000Z', '2026-07-24T00:00:01.000Z', NULL
          ),
          (
            'thread-soft-deleted', 'project-soft-delete', 'Retention deleted',
            '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
            '2026-07-24T00:00:02.000Z', '2026-07-24T00:00:09.000Z',
            '2026-07-24T00:00:09.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          (
            'message-live', 'thread-live', NULL, 'user', 'visible', 0,
            '2026-07-24T00:00:03.000Z', '2026-07-24T00:00:03.000Z'
          ),
          (
            'message-deleted', 'thread-soft-deleted', NULL, 'user', 'hidden', 0,
            '2026-07-24T00:00:04.000Z', '2026-07-24T00:00:04.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        ) VALUES
          (
            'activity-live', 'thread-live', NULL, 'info', 'runtime.note',
            'visible', '{}', 1, '2026-07-24T00:00:05.000Z'
          ),
          (
            'activity-deleted', 'thread-soft-deleted', NULL, 'info', 'runtime.note',
            'hidden', '{}', 2, '2026-07-24T00:00:06.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      // Soft-deleted threads still appear as rows: only their bodies are dropped, so
      // nothing that reconciles tombstones client-side changes behavior.
      const live = snapshot.threads.find((thread) => thread.id === asThreadId("thread-live"));
      const deleted = snapshot.threads.find(
        (thread) => thread.id === asThreadId("thread-soft-deleted"),
      );
      assert.deepEqual(
        live?.messages.map((message) => message.id),
        [asMessageId("message-live")],
      );
      assert.deepEqual(
        live?.activities.map((activity) => activity.summary),
        ["visible"],
      );
      assert.isDefined(deleted);
      assert.deepEqual(deleted?.messages, []);
      assert.deepEqual(deleted?.activities, []);
    }),
  );

  it.effect("pages transcript history by twenty complete turns with a stable cursor", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-turn-pages");

      yield* sql`DELETE FROM projection_pending_interactions`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      for (let index = 1; index <= 21; index += 1) {
        const turnId = asTurnId(`turn-page-${String(index).padStart(2, "0")}`);
        const requestedAt = `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z`;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id,
            state, requested_at, started_at, completed_at
          ) VALUES (
            ${threadId}, ${turnId}, NULL, NULL,
            'completed', ${requestedAt}, ${requestedAt}, ${requestedAt}
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming,
            sequence, created_at, updated_at
          ) VALUES (
            ${asMessageId(`message-page-${String(index).padStart(2, "0")}`)},
            ${threadId}, ${turnId}, 'user', ${`message ${index}`}, 0,
            ${index}, ${requestedAt}, ${requestedAt}
          )
        `;
      }
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'message-unscoped-page', ${threadId}, NULL, 'system', 'unscoped', 0,
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;

      const newest = yield* snapshotQuery.getThreadTurnsPage({ threadId });
      assert.equal(newest.conversationTurnCount, 20);
      assert.deepEqual(
        newest.messages.map((message) => message.text),
        Array.from({ length: 20 }, (_, index) => `message ${index + 2}`),
      );
      assert.isTrue(newest.hasOlder);
      assert.isNotNull(newest.nextCursor);

      const older = yield* snapshotQuery.getThreadTurnsPage({
        threadId,
        before: newest.nextCursor!,
      });
      assert.equal(older.conversationTurnCount, 1);
      assert.deepEqual(
        older.messages.map((message) => message.text),
        ["unscoped", "message 1"],
      );
      assert.isFalse(older.hasOlder);
      assert.isNull(older.nextCursor);
    }),
  );

  it.effect("hydrates promoted queued turns through canonical and provider turn aliases", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-promoted-turn-page");
      const canonicalTurnId = asTurnId("turn:server:dispatch-queued-turn:42");
      const queuedTurnId = asTurnId("turn:composer-queue:queued-message");
      const providerTurnId = asTurnId("provider-turn-promoted-42");
      const pendingMessageId = asMessageId("message-promoted-user");

      yield* sql`DELETE FROM projection_pending_interactions`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, provider_turn_id, pending_message_id, assistant_message_id,
          state, requested_at, started_at, completed_at
        ) VALUES (
          ${threadId}, ${canonicalTurnId}, ${providerTurnId}, ${pendingMessageId},
          'message-promoted-assistant', 'completed',
          '2026-08-02T00:00:01.000Z', '2026-08-02T00:00:02.000Z',
          '2026-08-02T00:00:03.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming,
          sequence, created_at, updated_at
        ) VALUES
          (
            ${pendingMessageId}, ${threadId}, ${queuedTurnId}, 'user', 'Ground yourself', 0,
            41, '2026-08-02T00:00:01.000Z', '2026-08-02T00:00:01.000Z'
          ),
          (
            'message-promoted-assistant', ${threadId}, ${providerTurnId}, 'assistant',
            'Grounded.', 0, 43,
            '2026-08-02T00:00:03.000Z', '2026-08-02T00:00:03.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        ) VALUES (
          'activity-promoted-provider-turn', ${threadId}, ${providerTurnId}, 'info',
          'runtime.note', 'provider activity', '{}', 42, '2026-08-02T00:00:02.000Z'
        )
      `;

      const page = yield* snapshotQuery.getThreadTurnsPage({ threadId });
      assert.equal(page.conversationTurnCount, 1);
      assert.deepEqual(
        page.messages.map((message) => message.text),
        ["Ground yourself", "Grounded."],
      );
      assert.deepEqual(
        page.messages.map((message) => message.turnId),
        [queuedTurnId, providerTurnId],
      );
      assert.deepEqual(
        page.activities.map((activity) => activity.summary),
        ["provider activity"],
      );
    }),
  );

  it.effect(
    "keeps restart continuations and provider retries in the originating conversation turn",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const threadId = asThreadId("thread-restart-conversation-page");

        yield* sql`DELETE FROM projection_pending_interactions`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_state`;

        yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, provider_turn_id, pending_message_id,
          assistant_message_id, state, requested_at, started_at, completed_at
        ) VALUES
          (
            ${threadId}, 'turn-original', 'provider-attempt-one', 'message-user',
            'message-assistant-one', 'interrupted', '2026-08-03T00:00:01.000Z',
            '2026-08-03T00:00:02.000Z', '2026-08-03T00:00:03.000Z'
          ),
          (
            ${threadId}, 'turn:restart-recovery:one', NULL, 'restart-recovery:one',
            NULL, 'interrupted', '2026-08-03T00:00:04.000Z', NULL,
            '2026-08-03T00:00:05.000Z'
          ),
          (
            ${threadId}, 'turn-provider-retry', 'provider-attempt-two', NULL,
            'message-assistant-two', 'completed', '2026-08-03T00:00:05.000Z',
            '2026-08-03T00:00:05.000Z', '2026-08-03T00:00:07.000Z'
          )
      `;
        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming,
          sequence, created_at, updated_at
        ) VALUES
          (
            'message-user', ${threadId}, 'turn-original', 'user', 'Continue the task', 0,
            1, '2026-08-03T00:00:01.000Z', '2026-08-03T00:00:01.000Z'
          ),
          (
            'message-assistant-one', ${threadId}, 'provider-attempt-one', 'assistant',
            'First attempt', 0, 2, '2026-08-03T00:00:02.000Z',
            '2026-08-03T00:00:03.000Z'
          ),
          (
            'message-assistant-two', ${threadId}, 'provider-attempt-two', 'assistant',
            'Recovered attempt', 0, 4, '2026-08-03T00:00:06.000Z',
            '2026-08-03T00:00:07.000Z'
          )
      `;
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        ) VALUES (
          'activity-recovery', ${threadId}, 'provider-attempt-two', 'info',
          'runtime.note', 'continued after restart', '{}', 3,
          '2026-08-03T00:00:05.000Z'
        )
      `;

        const page = yield* snapshotQuery.getThreadTurnsPage({ threadId });
        assert.equal(page.conversationTurnCount, 1);
        assert.deepEqual(
          page.messages.map((message) => message.text),
          ["Continue the task", "First attempt", "Recovered attempt"],
        );
        assert.deepEqual(
          page.activities.map((activity) => activity.summary),
          ["continued after restart"],
        );
        assert.isFalse(page.hasOlder);
      }),
  );
});
