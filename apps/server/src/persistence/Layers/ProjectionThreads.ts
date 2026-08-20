import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ClearProjectionThreadSpaceAssignmentsInput,
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import { ModelSelection, ThreadPinnedMessages, ThreadMarkers } from "@penkra/contracts";

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== 0),
    encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
  }),
);

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    isPinned: SqliteBoolean,
    pinnedMessages: Schema.NullOr(Schema.fromJsonString(ThreadPinnedMessages)),
    threadMarkers: Schema.NullOr(Schema.fromJsonString(ThreadMarkers)),
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          space_id,
          title,
          model_selection_json,
          runtime_mode,
          working_directory,
          is_pinned,
          sidebar_sort_order,
          parent_thread_id,
          creation_source,
          source_thread_id,
          source_turn_id,
          gateway_operation_id,
          gateway_operation_index,
          subagent_agent_id,
          subagent_nickname,
          subagent_role,
          fork_source_thread_id,
          latest_turn_id,
          pinned_messages_json,
          thread_markers_json,
          notes,
          latest_user_message_at,
          last_visited_at,
          pending_approval_count,
          pending_user_input_count,
          work_status,
          last_message_preview,
          last_activity_at,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.spaceId ?? null},
          ${row.title},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.workingDirectory ?? null},
          ${row.isPinned ? 1 : 0},
          ${row.sidebarSortOrder ?? 0},
          ${row.parentThreadId ?? null},
          ${row.creationSource ?? null},
          ${row.sourceThreadId ?? null},
          ${row.sourceTurnId ?? null},
          ${row.gatewayOperationId ?? null},
          ${row.gatewayOperationIndex ?? null},
          ${row.subagentAgentId ?? null},
          ${row.subagentNickname ?? null},
          ${row.subagentRole ?? null},
          ${row.forkSourceThreadId ?? null},
          ${row.latestTurnId},
          ${row.pinnedMessages === null ? null : JSON.stringify(row.pinnedMessages)},
          ${row.threadMarkers === null ? null : JSON.stringify(row.threadMarkers)},
          ${row.notes},
          ${row.latestUserMessageAt},
          ${row.lastVisitedAt ?? null},
          ${row.pendingApprovalCount},
          ${row.pendingUserInputCount},
          ${row.workStatus ?? "idle"},
          ${row.lastMessagePreview ?? null},
          ${row.lastActivityAt ?? null},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt ?? null},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          space_id = excluded.space_id,
          title = excluded.title,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          working_directory = excluded.working_directory,
          is_pinned = excluded.is_pinned,
          sidebar_sort_order = excluded.sidebar_sort_order,
          parent_thread_id = excluded.parent_thread_id,
          creation_source = excluded.creation_source,
          source_thread_id = excluded.source_thread_id,
          source_turn_id = excluded.source_turn_id,
          gateway_operation_id = excluded.gateway_operation_id,
          gateway_operation_index = excluded.gateway_operation_index,
          subagent_agent_id = excluded.subagent_agent_id,
          subagent_nickname = excluded.subagent_nickname,
          subagent_role = excluded.subagent_role,
          fork_source_thread_id = excluded.fork_source_thread_id,
          latest_turn_id = excluded.latest_turn_id,
          pinned_messages_json = excluded.pinned_messages_json,
          thread_markers_json = excluded.thread_markers_json,
          notes = excluded.notes,
          latest_user_message_at = excluded.latest_user_message_at,
          last_visited_at = excluded.last_visited_at,
          pending_approval_count = excluded.pending_approval_count,
          pending_user_input_count = excluded.pending_user_input_count,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
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
          pinned_messages_json AS "pinnedMessages",
          thread_markers_json AS "threadMarkers",
          notes,
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
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
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
          pinned_messages_json AS "pinnedMessages",
          thread_markers_json AS "threadMarkers",
          notes,
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
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const clearSpaceAssignmentsRows = SqlSchema.void({
    Request: ClearProjectionThreadSpaceAssignmentsInput,
    execute: ({ spaceId, updatedAt }) => sql`
      UPDATE projection_threads
      SET space_id = NULL,
          updated_at = CASE WHEN updated_at > ${updatedAt} THEN updated_at ELSE ${updatedAt} END
      WHERE space_id = ${spaceId}
    `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  return {
    clearSpaceAssignments: (input) =>
      clearSpaceAssignmentsRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadRepository.clearSpaceAssignments:query"),
        ),
      ),
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
