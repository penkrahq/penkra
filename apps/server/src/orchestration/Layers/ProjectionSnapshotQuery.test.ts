import convertNavigation from "../../persistence/Migrations/196_RemoveNavigationEvents";
import { getNavigation } from "../../cleanCore/navigation";
import {
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
  it.effect("uses exact durable delivery evidence and rejects ambiguous pending identities", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json,
          created_at, updated_at, deleted_at
        ) VALUES ('project-outcome', 'Outcome', '/tmp/outcome', NULL,
          '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z', NULL)
      `;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, deleted_at, sidebar_sort_order) VALUES ('thread-outcome', 'penkra-personal', 'project-outcome', 'Outcome', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z', NULL, 0)`;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 20, '2026-09-07T00:00:00.000Z')`;
      }
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, provider_turn_id, pending_message_id, assistant_message_id,
          state, requested_at, started_at, completed_at
        ) VALUES ('thread-outcome', 'turn-one', NULL, 'message-outcome', NULL, 'cancelled',
          '2026-09-07T00:00:01.000Z', NULL, '2026-09-07T00:00:02.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, delivery_state,
          is_streaming, source, sequence, created_at, updated_at
        ) VALUES ('message-outcome', 'thread-outcome', 'turn-one', 'user', 'accepted', 'accepted',
          0, 'native', 10, '2026-09-07T00:00:01.000Z', '2026-09-07T00:00:02.000Z')
      `;
      const contradiction = yield* snapshotQuery.getPendingStartOutcome({
        threadId: asThreadId("thread-outcome"),
        messageId: asMessageId("message-outcome"),
        minimumSequence: 20,
      });
      assert.equal(contradiction.outcome, "accepted");
      const oldFrontier = yield* snapshotQuery.getPendingStartOutcome({
        threadId: asThreadId("thread-outcome"),
        messageId: asMessageId("message-outcome"),
        minimumSequence: 21,
      });
      assert.equal(oldFrontier.outcome, "not-caught-up");

      yield* sql`UPDATE projection_turns SET state = 'completed' WHERE turn_id = 'turn-one'`;
      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'message-outcome'`;
      const terminalWithoutAcceptance = yield* snapshotQuery.getPendingStartOutcome({
        threadId: asThreadId("thread-outcome"),
        messageId: asMessageId("message-outcome"),
        minimumSequence: 20,
      });
      assert.equal(terminalWithoutAcceptance.outcome, "unknown");
      yield* sql`UPDATE projection_turns SET state = 'cancelled' WHERE turn_id = 'turn-one'`;
      const cancelled = yield* snapshotQuery.getPendingStartOutcome({
        threadId: asThreadId("thread-outcome"),
        messageId: asMessageId("message-outcome"),
        minimumSequence: 20,
      });
      assert.equal(cancelled.outcome, "cancelled");

      yield* sql`INSERT INTO projection_turns (
        thread_id, turn_id, provider_turn_id, pending_message_id, assistant_message_id,
        state, requested_at, started_at, completed_at
      ) VALUES ('thread-outcome', 'turn-two', NULL, 'message-outcome', NULL, 'cancelled',
        '2026-09-07T00:00:03.000Z', NULL, '2026-09-07T00:00:04.000Z')`;
      const ambiguous = yield* snapshotQuery.getPendingStartOutcome({
        threadId: asThreadId("thread-outcome"),
        messageId: asMessageId("message-outcome"),
        minimumSequence: 20,
      });
      assert.equal(ambiguous.outcome, "unknown");
      assert.isUndefined(ambiguous.turnId);
    }),
  );
  it.effect("hydrates Space identity and project assignments in full and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM threads`;
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
          folder_id, title, workspace_root, default_model_selection_json, space_id, created_at, updated_at, deleted_at
        ) VALUES (
          'project-space-snapshot', 'Space project', '/tmp/space-project', NULL, 'space-snapshot', '2026-07-20T00:00:00.000Z',
          '2026-07-20T00:00:01.000Z', NULL
        )
      `;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 7, '2026-07-20T00:00:01.000Z')
        `;
      }

      const shell = yield* snapshotQuery.getStartupSnapshot();
      const full = yield* getNavigation;
      assert.equal(shell.spaces[0]?.id, SpaceId.makeUnsafe("space-snapshot"));
      assert.equal(
        shell.spaces.some((space) => space.id === "space-archived-snapshot"),
        false,
      );
      assert.equal(shell.folders[0]?.spaceId, SpaceId.makeUnsafe("space-snapshot"));
      assert.equal(full.spaces[0]?.id, SpaceId.makeUnsafe("space-snapshot"));
      assert.equal(
        full.spaces.find((space) => space.id === "space-archived-snapshot")?.archivedAt,
        undefined,
      );
      assert.equal(full.folders[0]?.spaceId, SpaceId.makeUnsafe("space-snapshot"));

      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_spaces`;
      yield* sql`DELETE FROM projection_state`;
    }),
  );

  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id,
          space_id,
          title,
          workspace_root,
          default_model_selection_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'penkra-personal',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, last_user_message_at, deleted_at, sidebar_sort_order) VALUES ('thread-1', 'penkra-personal', 'project-1', 'Thread 1', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-02-24T00:00:02.000Z', '2026-02-24T00:00:03.000Z', '2026-02-24T00:00:03.500Z', NULL, 0)`;

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
            'info',
            'user-input.requested',
            'User input requested',
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

      yield* sql`UPDATE threads SET open_question_count = 2, last_activity_at = '2026-02-24T00:00:06.750Z', last_message_preview = 'hello from projection' WHERE id = 'thread-1'`;
      const snapshot = yield* snapshotQuery.getSnapshot();
      const commandModel = yield* snapshotQuery.getCommandReadModel();

      const commandThread = commandModel.threads[0];
      assert.isDefined(commandThread);
      assert.notProperty(commandThread, "latestUserMessageAt");
      assert.equal(commandThread.hasPendingUserInput, true);
      assert.deepEqual(commandThread.messages, []);
      assert.deepEqual(commandThread.activities, []);
      assert.deepEqual(commandThread.pendingInteractions, []);

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual((yield* getNavigation).folders, [
        {
          id: asFolderId("project-1"),
          spaceId: SpaceId.makeUnsafe("penkra-personal"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          iconDataUrl: null,
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          archivedAt: null,

          sidebarSortOrder: 0,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          deletedAt: null,
          connectionId: null,
          folderId: asFolderId("project-1"),
          title: "Thread 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          creationSource: null,
          sourceThreadId: null,
          sourceTurnId: null,
          gatewayOperationId: null,
          gatewayOperationIndex: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          hasPendingUserInput: true,
          workStatus: "attention",
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
              tone: "info",
              kind: "user-input.requested",
              summary: "User input requested",
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
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);
    }),
  );

  it.effect("limits hydrated thread activities to the latest activity window", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_thread_activities`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id,
          title,
          workspace_root,
          default_model_selection_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-activity-cap',
          'Project Activity Cap',
          '/tmp/project-activity-cap',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, deleted_at, sidebar_sort_order) VALUES ('thread-activity-cap', 'penkra-personal', 'project-activity-cap', 'Thread Activity Cap', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL, 0)`;

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
          'question-old',
          'thread-activity-cap',
          NULL,
          'approval',
          'user-input.requested',
          'User input requested',
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
      assert.equal(snapshotActivities[0]?.id, asEventId("question-old"));
      assert.equal(snapshotActivities[1]?.id, asEventId("activity-5"));
      assert.equal(snapshotActivities.at(-1)?.id, asEventId("activity-504"));

      // Thread detail keeps a far deeper window (2_000) than the bulk snapshot,
      // so the same 506-row thread is returned whole - including the activities
      // the snapshot had to drop.
      const detail = yield* snapshotQuery.getThreadDetailById(asThreadId("thread-activity-cap"));
      assert.isTrue(Option.isSome(detail));
      const detailActivities = Option.isSome(detail) ? detail.value.activities : [];
      assert.equal(detailActivities.length, 506);
      assert.equal(detailActivities[0]?.id, asEventId("question-old"));
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
            'question-old',
            'thread-activity-cap',
            NULL,
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"approval-1","requestKind":"command"}',
            0,
            '2026-02-24T00:00:00.000Z'
          ),
          (
            'question-resolved-old',
            'thread-activity-cap',
            NULL,
            'approval',
            'user-input.resolved',
            'User input resolved',
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
      assert.equal(resolvedDetailActivities[0]?.id, asEventId("question-old"));
      assert.equal(resolvedDetailActivities[1]?.id, asEventId("question-resolved-old"));
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
          'question-old', 'thread-activity-cap', NULL, 'approval',
          'user-input.requested', 'User input requested',
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
          'question-resolved-canonical', 'thread-activity-cap', NULL,
          'user-input.resolved', 'info', 'User input resolved',
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
        asEventId("question-resolved-canonical"),
      );
      assert.isFalse(
        canonicalResolvedActivities.some((activity) => activity.id === asEventId("question-old")),
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
      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-canonical-window', 'Canonical window', '/tmp/canonical-window',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z', NULL
        )
      `;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, deleted_at, sidebar_sort_order) VALUES ('thread-canonical-window', 'penkra-personal', 'project-canonical-window', 'Canonical Window', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z', NULL, 0)`;
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
      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-turn-window', 'Turn window', '/tmp/turn-window',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL
        )
      `;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, deleted_at, sidebar_sort_order) VALUES ('thread-turn-window', 'penkra-personal', 'project-turn-window', 'Turn Window', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL, 0)`;

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
      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-oversized-turn', 'Oversized turn', '/tmp/oversized-turn',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL
        )
      `;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, deleted_at, sidebar_sort_order) VALUES ('thread-oversized-turn', 'penkra-personal', 'project-oversized-turn', 'Oversized Turn', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL, 0)`;
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
      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id,
          title,
          workspace_root,
          default_model_selection_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-export-message-cap',
          'Project Export Message Cap',
          '/tmp/project-export-message-cap',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, deleted_at, sidebar_sort_order) VALUES ('thread-export-message-cap', 'penkra-personal', 'project-export-message-cap', 'Thread Export Message Cap', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL, 0)`;

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
      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-causal-message-snapshot', 'Causal Message Snapshot',
          '/tmp/project-causal-message-snapshot',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:00.000Z', NULL
        )
      `;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, deleted_at, sidebar_sort_order) VALUES ('thread-causal-message-snapshot', 'penkra-personal', 'project-causal-message-snapshot', 'Causal Message Snapshot', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:00.000Z', NULL, 0)`;
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
          response_command_id, response_requested_at, created_at, resolved_at
        ) VALUES
          (
            'userInput', 'request-retryable', 'thread-causal-message-snapshot', NULL,
            'generation-current', 'retryable', 'command-response',
            '2026-07-14T12:11:00.000Z', '2026-07-14T12:10:30.000Z', NULL
          ),
          (
            'approval', 'request-confirmed', 'thread-causal-message-snapshot', NULL,
            'generation-current', 'pending', 'command-approval',
            '2026-07-14T12:12:00.000Z', '2026-07-14T12:11:30.000Z',
            '2026-07-14T12:12:01.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      const expectedPendingInteractions = [
        {
          interactionKind: "userInput" as const,
          requestId: "request-retryable",
          threadId,
          turnId: null,
          lifecycleGeneration: "generation-current",
          status: "retryable" as const,
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

      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_sessions`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id, space_id,
          title,
          workspace_root,
          default_model_selection_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-imported-shape', 'penkra-personal',
          'Imported Shape Project',
          '/tmp/imported-shape',
          '{"instanceId":"codex","model":"imported-project-model","options":[{"id":"reasoningEffort","value":"medium"}]}',
          '2026-05-05T14:39:18.000Z',
          '2026-05-05T14:39:19.000Z',
          NULL
        )
      `;

      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, deleted_at, sidebar_sort_order) VALUES ('thread-imported-shape', 'penkra-personal', 'project-imported-shape', 'Imported Shape Thread', json_extract('{"provider":"codex","model":"gpt-5.5","options":[{"id":"reasoningEffort","value":"medium"}]}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5.5","options":[{"id":"reasoningEffort","value":"medium"}]}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5.5","options":[{"id":"reasoningEffort","value":"medium"}]}', '$.options'), 'full-access', 'idle', 'user', '2026-05-05T14:39:20.000Z', '2026-05-05T14:39:21.000Z', NULL, 0)`;

      yield* sql.withTransaction(convertNavigation);
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
      const shellSnapshot = yield* snapshotQuery.getStartupSnapshot();
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
        (yield* getNavigation).folders.find((project) => project.id === "project-imported-shape")
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
        Option.getOrNull(
          yield* snapshotQuery.getThreadShellById(asThreadId("thread-imported-shape")),
        )?.modelSelection,
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

      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id,
          title,
          workspace_root,
          default_model_selection_json,
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
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, archived_at, deleted_at, sidebar_sort_order) VALUES ('thread-first', 'penkra-personal', 'project-active', 'First Thread', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-03-01T00:00:05.000Z', '2026-03-01T00:00:06.000Z', NULL, NULL, 0),
      ('thread-second', 'penkra-personal', 'project-active', 'Second Thread', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-03-01T00:00:07.000Z', '2026-03-01T00:00:08.000Z', NULL, NULL, 0),
      ('thread-deleted', 'penkra-personal', 'project-active', 'Deleted Thread', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-03-01T00:00:09.000Z', '2026-03-01T00:00:10.000Z', NULL, '2026-03-01T00:00:11.000Z', 0)`;

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

      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id, space_id,
          title,
          workspace_root,
          default_model_selection_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-shell', 'penkra-personal',
          'Shell Project',
          '/tmp/project-shell',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '2026-03-03T00:00:00.000Z',
          '2026-03-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, last_user_message_at, archived_at, deleted_at, sidebar_sort_order) VALUES ('thread-shell', 'penkra-personal', 'project-shell', 'Shell Thread', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-03-03T00:00:02.000Z', '2026-03-03T00:00:03.000Z', '2026-03-03T00:00:02.500Z', NULL, NULL, 0)`;

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

      yield* sql`UPDATE threads SET open_question_count = 2 WHERE id = 'thread-shell'`;
      const shellSnapshot = yield* snapshotQuery.getStartupSnapshot();
      const expectedThreadShells: readonly import("@penkra/contracts").OrchestrationThreadShell[] =
        [
          {
            id: ThreadId.makeUnsafe("thread-shell"),
            connectionId: null,
            folderId: asFolderId("project-shell"),
            title: "Shell Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            creationSource: null,
            sourceThreadId: null,
            sourceTurnId: null,
            gatewayOperationId: null,
            gatewayOperationIndex: null,
            subagentAgentId: null,
            subagentNickname: null,
            subagentRole: null,
            latestTurn: {
              turnId: asTurnId("turn-shell"),
              state: "completed",
              requestedAt: "2026-03-03T00:00:05.000Z",
              startedAt: "2026-03-03T00:00:05.000Z",
              completedAt: "2026-03-03T00:00:05.000Z",
              assistantMessageId: null,
            },
            hasPendingUserInput: true,
            workStatus: "attention",
            createdAt: "2026-03-03T00:00:02.000Z",
            updatedAt: "2026-03-03T00:00:03.000Z",
            archivedAt: null,
            session: {
              threadId: ThreadId.makeUnsafe("thread-shell"),
              status: "ready",
              providerName: "codex",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-03-03T00:00:04.000Z",
            },
          },
        ];
      assert.deepEqual(shellSnapshot.runningThreads, []);

      const threadShell = yield* snapshotQuery.getThreadShellById(
        ThreadId.makeUnsafe("thread-shell"),
      );
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.deepEqual(threadShell.value, expectedThreadShells[0]);
      }
    }),
  );

  it.effect("surfaces the runtime-active turn ahead of a newer historical request", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;

      yield* sql`
        INSERT INTO projection_folders (
          folder_id, space_id, title, workspace_root, default_model_selection_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-active-turn', 'penkra-personal', 'Active Turn Project', NULL,
          '{"provider":"codex","model":"gpt-5-codex"}',
          '2026-08-29T06:14:00.000Z', '2026-08-29T06:14:00.000Z', NULL
        )
      `;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, last_user_message_at, archived_at, deleted_at, sidebar_sort_order) VALUES ('thread-active-turn', 'penkra-personal', 'project-active-turn', 'Active Turn', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-08-29T06:14:00.000Z', '2026-08-29T06:14:25.053Z', '2026-08-29T06:14:22.782Z', NULL, NULL, 0)`;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id,
          provider_thread_id, runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES (
          'thread-active-turn', 'running', 'codex', 'session-active-turn',
          'provider-thread-active-turn', 'full-access', 'provider-active-turn', NULL,
          '2026-08-29T06:14:25.053Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, provider_turn_id, pending_message_id,
          assistant_message_id, state, requested_at, started_at, completed_at
        ) VALUES (
          'thread-active-turn', 'canonical-active-turn', 'provider-active-turn', NULL,
          NULL, 'running', '2026-08-29T05:42:53.000Z',
          '2026-08-29T06:14:25.053Z', NULL
        ), (
          'thread-active-turn', 'newer-terminal-turn', NULL, NULL,
          NULL, 'completed', '2026-08-29T06:14:22.782Z',
          '2026-08-29T06:14:25.002Z', '2026-08-29T06:14:25.002Z'
        )
      `;

      const targeted = yield* snapshotQuery.getThreadShellById(asThreadId("thread-active-turn"));
      assert.equal(targeted._tag, "Some");
      if (targeted._tag === "Some") {
        assert.equal(targeted.value.latestTurn?.turnId, asTurnId("canonical-active-turn"));
        assert.equal(targeted.value.latestTurn?.providerTurnId, asTurnId("provider-active-turn"));
        assert.equal(targeted.value.latestTurn?.state, "running");
      }

      const shell = yield* snapshotQuery.getStartupSnapshot();
      assert.deepEqual(shell.runningThreads, []);
      yield* sql`UPDATE threads SET state = 'running', active_turn_id = 'canonical-active-turn' WHERE id = 'thread-active-turn'`;
      const running = yield* snapshotQuery.getStartupSnapshot();
      assert.equal(running.runningThreads[0]?.id, asThreadId("thread-active-turn"));
      assert.equal(running.runningThreads[0]?.activeTurnId, "canonical-active-turn");
    }),
  );

  it.effect("excludes soft-deleted thread bodies from the full snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM threads`;
      yield* sql`DELETE FROM projection_folders`;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-soft-delete', 'Soft delete', '/tmp/soft-delete',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z', NULL
        )
      `;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, model_options, runtime_mode, state, created_by, created_at, updated_at, deleted_at, sidebar_sort_order) VALUES ('thread-live', 'penkra-personal', 'project-soft-delete', 'Live', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-07-24T00:00:01.000Z', '2026-07-24T00:00:01.000Z', NULL, 0),
      ('thread-soft-deleted', 'penkra-personal', 'project-soft-delete', 'Retention deleted', json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.provider'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.model'), json_extract('{"provider":"codex","model":"gpt-5-codex"}', '$.options'), 'full-access', 'idle', 'user', '2026-07-24T00:00:02.000Z', '2026-07-24T00:00:09.000Z', '2026-07-24T00:00:09.000Z', 0)`;
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

  it.effect("searches indexed transcript literals and reads exact anchored turn context", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-transcript-search");
      yield* sql`INSERT OR IGNORE INTO projection_folders(folder_id, title, workspace_root, space_id, created_at, updated_at)
        VALUES ('folder-transcript-search', 'Search', '/repo', 'penkra-personal', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`;
      yield* sql`INSERT OR IGNORE INTO threads(id, space_id, folder_id, title, provider, model, runtime_mode, state, created_by, created_at, updated_at)
        VALUES (${threadId}, 'penkra-personal', 'folder-transcript-search', 'Search', 'codex', 'gpt-5.5', 'full-access', 'idle', 'user', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming,
          sequence, created_at, updated_at
        ) VALUES
          ('search-user-1', ${threadId}, 'search-turn-1', 'user',
            'Thread grouping grouping discussion', 0, 1,
            '2026-09-01T00:00:01.000Z', '2026-09-01T00:00:01.000Z'),
          ('search-assistant-1', ${threadId}, 'search-turn-1', 'assistant',
            'First response', 0, 2,
            '2026-09-01T00:00:02.000Z', '2026-09-01T00:00:02.000Z'),
          ('search-user-2', ${threadId}, 'search-turn-2', 'user',
            'Put related work in one panel', 0, 3,
            '2026-09-02T00:00:01.000Z', '2026-09-02T00:00:01.000Z'),
          ('search-assistant-2', ${threadId}, 'search-turn-2', 'assistant',
            'Grouping and one panel are both here', 0, 4,
            '2026-09-02T00:00:02.000Z', '2026-09-02T00:00:02.000Z'),
          ('search-user-3', ${threadId}, 'search-turn-3', 'user',
            'Third turn with Élan', 0, 5,
            '2026-09-03T00:00:01.000Z', '2026-09-03T00:00:01.000Z'),
          ('search-user-4', ${threadId}, 'search-turn-4', 'user',
            'Outside the context window', 0, 6,
            '2026-09-04T00:00:01.000Z', '2026-09-04T00:00:01.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          sequence, created_at
        ) VALUES (
          'search-activity-2', ${threadId}, 'search-turn-2', 'info', 'tool.completed',
          'Panel tool', '{}', 4, '2026-09-02T00:00:02.500Z'
        )
      `;

      const indexed = yield* snapshotQuery.searchThreadMessages({
        spaceId: SpaceId.makeUnsafe("penkra-personal"),
        folderId: null,
        threadId,
        queries: ["grouping", "one panel"],
        queryMode: "all",
        roles: ["assistant"],
        createdAfter: "2026-09-02T00:00:00.000Z",
        createdBefore: "2026-09-03T00:00:00.000Z",
        order: "recent",
      });
      assert.equal(indexed.path, "indexed");
      assert.deepEqual(
        indexed.messages.map((message) => message.messageId),
        [asMessageId("search-assistant-2")],
      );

      const fallback = yield* snapshotQuery.searchThreadMessages({
        spaceId: SpaceId.makeUnsafe("penkra-personal"),
        folderId: null,
        threadId,
        queries: ["x"],
        queryMode: "any",
        order: "oldest",
      });
      assert.equal(fallback.path, "short-query-fallback");
      assert.deepEqual(
        fallback.messages.map((message) => message.messageId),
        [asMessageId("search-user-4")],
      );

      const unicodeFallback = yield* snapshotQuery.searchThreadMessages({
        spaceId: SpaceId.makeUnsafe("penkra-personal"),
        folderId: null,
        threadId,
        queries: ["é"],
        queryMode: "any",
        order: "oldest",
      });
      assert.lengthOf(unicodeFallback.messages, 0);
      yield* sql`INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming,
        sequence, created_at, updated_at
      ) VALUES (
        'search-user-lowercase-accent', ${threadId}, 'search-turn-5', 'user',
        'Fifth turn with élan', 0, 7,
        '2026-09-05T00:00:01.000Z', '2026-09-05T00:00:01.000Z'
      )`;
      const unicodePhrase = yield* snapshotQuery.searchThreadMessages({
        spaceId: SpaceId.makeUnsafe("penkra-personal"),
        folderId: null,
        threadId,
        queries: ["élan"],
        queryMode: "any",
        order: "oldest",
      });
      assert.deepEqual(
        unicodePhrase.messages.map((message) => message.messageId),
        [asMessageId("search-user-lowercase-accent")],
      );
      const uppercaseAccent = yield* snapshotQuery.searchThreadMessages({
        spaceId: SpaceId.makeUnsafe("penkra-personal"),
        folderId: null,
        threadId,
        queries: ["ÉLAN"],
        queryMode: "any",
        order: "oldest",
      });
      assert.deepEqual(
        uppercaseAccent.messages.map((message) => message.messageId),
        [asMessageId("search-user-3")],
      );
      const uppercaseAgainstLowercase = yield* snapshotQuery.searchThreadMessages({
        spaceId: SpaceId.makeUnsafe("penkra-personal"),
        folderId: null,
        threadId,
        queries: ["ÉLAN"],
        queryMode: "any",
        order: "oldest",
        turnId: TurnId.makeUnsafe("search-turn-5"),
      });
      assert.lengthOf(uppercaseAgainstLowercase.messages, 0);

      const context = yield* snapshotQuery.getThreadMessageContext({
        threadId,
        messageId: asMessageId("search-assistant-2"),
        beforeTurns: 1,
        afterTurns: 1,
      });
      assert.isTrue(Option.isSome(context));
      if (Option.isSome(context)) {
        assert.deepEqual(
          context.value.messages.map((message) => message.id),
          [
            asMessageId("search-user-1"),
            asMessageId("search-assistant-1"),
            asMessageId("search-user-2"),
            asMessageId("search-assistant-2"),
            asMessageId("search-user-3"),
          ],
        );
        assert.deepEqual(
          context.value.activities.map((activity) => activity.id),
          ["search-activity-2"],
        );
      }
    }),
  );
});
