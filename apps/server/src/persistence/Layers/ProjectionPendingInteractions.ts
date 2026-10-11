import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionPendingInteractionInput,
  GetProjectionPendingInteractionInput,
  ListProjectionPendingInteractionsInput,
  ProjectionPendingInteraction,
  ProjectionPendingInteractionRepository,
  type ProjectionPendingInteractionRepositoryShape,
} from "../Services/ProjectionPendingInteractions.ts";

const makeProjectionPendingInteractionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionPendingInteraction,
    execute: (row) => sql`
      INSERT INTO projection_pending_interactions (
        interaction_kind, request_id, thread_id, turn_id, lifecycle_generation,
        status, response_command_id, response_requested_at, created_at, resolved_at
      ) VALUES (
        ${row.interactionKind}, ${row.requestId}, ${row.threadId}, ${row.turnId},
        ${row.lifecycleGeneration}, ${row.status}, ${row.responseCommandId},
        ${row.responseRequestedAt}, ${row.createdAt}, ${row.resolvedAt}
      )
      ON CONFLICT (thread_id, interaction_kind, request_id)
      DO UPDATE SET
        turn_id = excluded.turn_id,
        lifecycle_generation = excluded.lifecycle_generation,
        status = excluded.status,
        response_command_id = excluded.response_command_id,
        response_requested_at = excluded.response_requested_at,
        created_at = excluded.created_at,
        resolved_at = excluded.resolved_at
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: ListProjectionPendingInteractionsInput,
    Result: ProjectionPendingInteraction,
    execute: ({ threadId }) => sql`
      SELECT
        interaction_kind AS "interactionKind",
        request_id AS "requestId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        lifecycle_generation AS "lifecycleGeneration",
        status,
        response_command_id AS "responseCommandId",
        response_requested_at AS "responseRequestedAt",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt"
      FROM projection_pending_interactions
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, interaction_kind ASC, request_id ASC
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionPendingInteractionInput,
    Result: ProjectionPendingInteraction,
    execute: ({ threadId, interactionKind, requestId }) => sql`
      SELECT
        interaction_kind AS "interactionKind",
        request_id AS "requestId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        lifecycle_generation AS "lifecycleGeneration",
        status,
        response_command_id AS "responseCommandId",
        response_requested_at AS "responseRequestedAt",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt"
      FROM projection_pending_interactions
      WHERE thread_id = ${threadId}
        AND interaction_kind = ${interactionKind}
        AND request_id = ${requestId}
    `,
  });

  const listUnresolvedRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionPendingInteraction,
    execute: () => sql`
      SELECT
        interaction_kind AS "interactionKind",
        request_id AS "requestId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        lifecycle_generation AS "lifecycleGeneration",
        status,
        response_command_id AS "responseCommandId",
        response_requested_at AS "responseRequestedAt",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt"
      FROM projection_pending_interactions
      WHERE status <> 'confirmed'
      ORDER BY created_at ASC, thread_id ASC, interaction_kind ASC, request_id ASC
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteProjectionPendingInteractionInput,
    execute: ({ threadId, interactionKind, requestId }) => sql`
      DELETE FROM projection_pending_interactions
      WHERE thread_id = ${threadId}
        AND interaction_kind = ${interactionKind}
        AND request_id = ${requestId}
    `,
  });

  return {
    upsert: (row) =>
      upsertRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionPendingInteractionRepository.upsert")),
      ),
    listByThreadId: (input) =>
      listRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPendingInteractionRepository.listByThreadId"),
        ),
      ),
    listUnresolved: () =>
      listUnresolvedRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPendingInteractionRepository.listUnresolved"),
        ),
      ),
    getByIdentity: (input) =>
      getRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPendingInteractionRepository.getByIdentity"),
        ),
      ),
    deleteByIdentity: (input) =>
      deleteRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionPendingInteractionRepository.deleteByIdentity"),
        ),
      ),
  } satisfies ProjectionPendingInteractionRepositoryShape;
});

export const ProjectionPendingInteractionRepositoryLive = Layer.effect(
  ProjectionPendingInteractionRepository,
  makeProjectionPendingInteractionRepository,
);
