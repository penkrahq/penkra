import { MessageId, ThreadId, TurnId } from "@penkra/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError, toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteProjectionTurnsByThreadInput,
  GetProjectionUnboundTurnStartInput,
  GetProjectionTurnByTurnIdInput,
  ListProjectionTurnsByThreadInput,
  ProjectionUnboundTurnStart,
  ProjectionTurn,
  ProjectionTurnById,
  ProjectionTurnIdentityInput,
  ProjectionTurnState,
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../Services/ProjectionTurns.ts";

const ProjectionTurnDbRowSchema = ProjectionTurn;
const ProjectionTurnByIdDbRowSchema = ProjectionTurnById;
const ProjectionProviderTurnIdDbRowSchema = Schema.Struct({ providerTurnId: TurnId });

const ProjectionWaitTurnDbRowSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  assistantMessageId: Schema.NullOr(MessageId),
  state: Schema.NullOr(ProjectionTurnState),
});

const makeProjectionTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTurnById = SqlSchema.void({
    Request: ProjectionTurnByIdDbRowSchema,
    execute: (row) =>
      sql`
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
        VALUES (
          ${row.threadId},
          ${row.turnId},
          ${row.providerTurnId},
          ${row.pendingMessageId},
          ${row.assistantMessageId},
          ${row.state},
          ${row.requestedAt},
          ${row.startedAt},
          ${row.completedAt}
        )
        ON CONFLICT (thread_id, turn_id)
        DO UPDATE SET
          pending_message_id = excluded.pending_message_id,
          assistant_message_id = excluded.assistant_message_id,
          provider_turn_id = COALESCE(projection_turns.provider_turn_id, excluded.provider_turn_id),
          state = CASE
            WHEN projection_turns.state IN ('completed', 'interrupted', 'error', 'cancelled')
              THEN projection_turns.state
            ELSE excluded.state
          END,
          requested_at = excluded.requested_at,
          started_at = COALESCE(projection_turns.started_at, excluded.started_at),
          completed_at = CASE
            WHEN projection_turns.state IN ('completed', 'interrupted', 'error', 'cancelled')
              THEN projection_turns.completed_at
            ELSE excluded.completed_at
          END
      `,
  });

  const getUnboundProjectionTurn = SqlSchema.findOneOption({
    Request: GetProjectionUnboundTurnStartInput,
    Result: ProjectionUnboundTurnStart,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          pending_message_id AS "messageId",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND state = 'running'
          AND provider_turn_id IS NULL
          AND started_at IS NULL
          AND pending_message_id IS NOT NULL
        ORDER BY requested_at DESC
        LIMIT 1
      `,
  });

  const listProjectionTurnsByThread = SqlSchema.findAll({
    Request: ListProjectionTurnsByThreadInput,
    Result: ProjectionTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_turn_id AS "providerTurnId",
          pending_message_id AS "pendingMessageId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY requested_at ASC,
          turn_id ASC
      `,
  });

  const listProjectionTurnsByThreads = SqlSchema.findAll({
    Request: Schema.Array(ThreadId),
    Result: ProjectionTurnDbRowSchema,
    execute: (threadIds) => sql`
      SELECT
        thread_id AS "threadId",
        turn_id AS "turnId",
        provider_turn_id AS "providerTurnId",
        pending_message_id AS "pendingMessageId",
        assistant_message_id AS "assistantMessageId",
        state,
        requested_at AS "requestedAt",
        started_at AS "startedAt",
        completed_at AS "completedAt"
      FROM projection_turns
      WHERE thread_id IN ${sql.in([...new Set(threadIds)])}
      ORDER BY thread_id ASC, requested_at ASC, turn_id ASC
    `,
  });

  const getProjectionTurnByTurnId = SqlSchema.findOneOption({
    Request: GetProjectionTurnByTurnIdInput,
    Result: ProjectionTurnByIdDbRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_turn_id AS "providerTurnId",
          pending_message_id AS "pendingMessageId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
        LIMIT 1
      `,
  });

  const getProjectionTurnsByTurnId = SqlSchema.findAll({
    Request: Schema.Array(GetProjectionTurnByTurnIdInput),
    Result: ProjectionTurnByIdDbRowSchema,
    execute: (input) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_turn_id AS "providerTurnId",
          pending_message_id AS "pendingMessageId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id IN ${sql.in([...new Set(input.map((entry) => entry.threadId))])}
          AND turn_id IN ${sql.in([...new Set(input.map((entry) => entry.turnId))])}
      `,
  });

  const reopenProjectionTurnForRestart = SqlSchema.void({
    Request: ProjectionTurnIdentityInput,
    execute: ({ threadId, turnId }) => sql`
      UPDATE projection_turns
      SET provider_turn_id = NULL,
          state = 'running',
          started_at = NULL,
          completed_at = NULL
      WHERE thread_id = ${threadId}
        AND turn_id = ${turnId}
    `,
  });

  const listProjectionProviderTurnIds = SqlSchema.findAll({
    Request: ProjectionTurnIdentityInput,
    Result: ProjectionProviderTurnIdDbRowSchema,
    execute: ({ threadId, turnId }) => sql`
      SELECT provider_turn_id AS "providerTurnId"
      FROM projection_turn_provider_bindings
      WHERE thread_id = ${threadId}
        AND turn_id = ${turnId}
      ORDER BY bound_at ASC, provider_turn_id ASC
    `,
  });

  const getProjectionWaitSnapshot = SqlSchema.findAll({
    Request: Schema.Struct({
      threadIds: Schema.Array(ThreadId),
      turnIds: Schema.Array(TurnId),
    }),
    Result: ProjectionWaitTurnDbRowSchema,
    execute: ({ threadIds, turnIds }) =>
      turnIds.length > 0
        ? sql`
            SELECT
              threads.thread_id AS "threadId",
              turns.turn_id AS "turnId",
              turns.assistant_message_id AS "assistantMessageId",
              turns.state
            FROM projection_threads AS threads
            LEFT JOIN projection_turns AS turns
              ON turns.thread_id = threads.thread_id
             AND turns.turn_id IN ${sql.in(turnIds)}
            WHERE threads.thread_id IN ${sql.in(threadIds)}
              AND threads.deleted_at IS NULL
          `
        : sql`
            SELECT
              threads.thread_id AS "threadId",
              NULL AS "turnId",
              NULL AS "assistantMessageId",
              NULL AS state
            FROM projection_threads AS threads
            WHERE threads.thread_id IN ${sql.in(threadIds)}
              AND threads.deleted_at IS NULL
          `,
  });

  const deleteProjectionTurnsByThread = SqlSchema.void({
    Request: DeleteProjectionTurnsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
      `,
  });

  const upsertByTurnId: ProjectionTurnRepositoryShape["upsertByTurnId"] = (row) =>
    Effect.gen(function* () {
      yield* upsertProjectionTurnById(row);
      if (row.providerTurnId !== null) {
        yield* sql`
          INSERT INTO projection_turn_provider_bindings (
            thread_id, turn_id, provider_turn_id, bound_at
          ) VALUES (
            ${row.threadId}, ${row.turnId}, ${row.providerTurnId},
            ${row.startedAt ?? row.requestedAt}
          )
          ON CONFLICT (thread_id, turn_id, provider_turn_id) DO NOTHING
        `;
      }
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.upsertByTurnId:query",
          "ProjectionTurnRepository.upsertByTurnId:encodeRequest",
        ),
      ),
    );

  const reopenForRestart: ProjectionTurnRepositoryShape["reopenForRestart"] = (input) =>
    reopenProjectionTurnForRestart(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.reopenForRestart:query",
          "ProjectionTurnRepository.reopenForRestart:encodeRequest",
        ),
      ),
    );

  const listProviderTurnIds: ProjectionTurnRepositoryShape["listProviderTurnIds"] = (input) =>
    listProjectionProviderTurnIds(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.listProviderTurnIds:query",
          "ProjectionTurnRepository.listProviderTurnIds:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.providerTurnId)),
    );

  const getUnboundTurnStartByThreadId: ProjectionTurnRepositoryShape["getUnboundTurnStartByThreadId"] =
    (input) =>
      getUnboundProjectionTurn(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.getUnboundTurnStartByThreadId:query"),
        ),
      );

  const listByThreadId: ProjectionTurnRepositoryShape["listByThreadId"] = (input) =>
    listProjectionTurnsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.listByThreadId:query",
          "ProjectionTurnRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionTurn>>),
    );

  const listByThreadIds: ProjectionTurnRepositoryShape["listByThreadIds"] = (threadIds) => {
    if (threadIds.length === 0) return Effect.succeed([]);
    return listProjectionTurnsByThreads([...threadIds]).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.listByThreadIds:query",
          "ProjectionTurnRepository.listByThreadIds:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionTurn>>),
    );
  };

  const getByTurnId: ProjectionTurnRepositoryShape["getByTurnId"] = (input) =>
    getProjectionTurnByTurnId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.getByTurnId:query",
          "ProjectionTurnRepository.getByTurnId:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionTurnById>)),
        }),
      ),
    );

  const getManyByTurnId: ProjectionTurnRepositoryShape["getManyByTurnId"] = (input) => {
    if (input.length === 0) return Effect.succeed([]);
    const requested = new Set(input.map((entry) => `${entry.threadId}\u0000${entry.turnId}`));
    return getProjectionTurnsByTurnId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.getManyByTurnId:query",
          "ProjectionTurnRepository.getManyByTurnId:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.filter((row) => requested.has(`${row.threadId}\u0000${row.turnId}`)),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionTurnById>>),
    );
  };

  const getManyWaitSnapshot: ProjectionTurnRepositoryShape["getManyWaitSnapshot"] = (input) => {
    if (input.threadIds.length === 0) {
      return Effect.succeed({ existingThreadIds: [], turns: [] });
    }
    const requested = new Set(input.turns.map((entry) => `${entry.threadId}\u0000${entry.turnId}`));
    return getProjectionWaitSnapshot({
      threadIds: [...new Set(input.threadIds)],
      turnIds: [...new Set(input.turns.map((entry) => entry.turnId))],
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.getManyWaitSnapshot:query",
          "ProjectionTurnRepository.getManyWaitSnapshot:decodeRows",
        ),
      ),
      Effect.map((rows) => ({
        existingThreadIds: [...new Set(rows.map((row) => row.threadId))],
        turns: rows.flatMap((row) =>
          row.turnId !== null &&
          row.state !== null &&
          requested.has(`${row.threadId}\u0000${row.turnId}`)
            ? [
                {
                  threadId: row.threadId,
                  turnId: row.turnId,
                  assistantMessageId: row.assistantMessageId,
                  state: row.state,
                },
              ]
            : [],
        ),
      })),
    );
  };

  const deleteByThreadId: ProjectionTurnRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionTurnsByThread(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTurnRepository.deleteByThreadId:query")),
    );

  return {
    upsertByTurnId,
    reopenForRestart,
    listProviderTurnIds,
    getUnboundTurnStartByThreadId,
    listByThreadId,
    listByThreadIds,
    getByTurnId,
    getManyByTurnId,
    getManyWaitSnapshot,
    deleteByThreadId,
  } satisfies ProjectionTurnRepositoryShape;
});

export const ProjectionTurnRepositoryLive = Layer.effect(
  ProjectionTurnRepository,
  makeProjectionTurnRepository,
);
