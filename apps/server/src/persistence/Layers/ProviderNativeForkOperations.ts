// FILE: ProviderNativeForkOperations.ts
// Purpose: SQLite-backed exact native-fork journal.

import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  ProviderNativeForkOperationRecord,
  ProviderNativeForkOperationRepository,
  type ProviderNativeForkOperationRepositoryShape,
} from "../Services/ProviderNativeForkOperations.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectById = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String }),
    Result: ProviderNativeForkOperationRecord,
    execute: ({ id }) => sql`
      SELECT operation_id AS id, command_id AS "commandId",
        source_thread_id AS "sourceThreadId", target_thread_id AS "targetThreadId",
        operation_state AS state, source_state_revision AS "sourceStateRevision",
        source_binding_revision AS "sourceBindingRevision",
        target_native_state_generation_id AS "targetNativeStateGenerationId",
        selection_json AS "selectionJson", command_json AS "commandJson", cwd,
        fork_result_json AS "forkResultJson", failure_reason AS "failureReason",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM provider_native_fork_operations WHERE operation_id = ${id}
    `,
  });
  const mapped = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.mapError(toPersistenceSqlOrDecodeError(`${operation}:query`, `${operation}:decode`)),
    );
  const transition: ProviderNativeForkOperationRepositoryShape["transition"] = (input) =>
    mapped(
      "ProviderNativeForkOperationRepository.transition",
      sql`
      UPDATE provider_native_fork_operations
      SET operation_state = ${input.state}, failure_reason = ${input.failureReason},
        fork_result_json = COALESCE(${input.forkResultJson ?? null}, fork_result_json),
        updated_at = ${input.updatedAt}
      WHERE operation_id = ${input.id}
    `.pipe(Effect.andThen(selectById({ id: input.id }))),
    );
  const markCommittedInCurrentTransaction: ProviderNativeForkOperationRepositoryShape["markCommittedInCurrentTransaction"] =
    (input) =>
      mapped(
        "ProviderNativeForkOperationRepository.markCommittedInCurrentTransaction",
        sql`
          UPDATE provider_native_fork_operations
          SET operation_state = 'committed', failure_reason = NULL, updated_at = ${input.updatedAt}
          WHERE operation_id = ${input.id} AND operation_state = 'forked'
        `.pipe(Effect.andThen(selectById({ id: input.id }))),
      );
  return {
    begin: (input) =>
      mapped(
        "ProviderNativeForkOperationRepository.begin",
        sql`
      INSERT INTO provider_native_fork_operations (
        operation_id, command_id, source_thread_id, target_thread_id, operation_state,
        source_state_revision, source_binding_revision, target_native_state_generation_id,
        selection_json, command_json, cwd, fork_result_json, failure_reason, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.commandId}, ${input.sourceThreadId}, ${input.targetThreadId}, ${input.state},
        ${input.sourceStateRevision}, ${input.sourceBindingRevision}, ${input.targetNativeStateGenerationId},
        ${input.selectionJson}, ${input.commandJson}, ${input.cwd}, ${input.forkResultJson},
        ${input.failureReason}, ${input.createdAt}, ${input.updatedAt}
      )
    `.pipe(Effect.andThen(selectById({ id: input.id }))),
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die("Inserted provider native fork operation was not readable."),
            onSome: Effect.succeed,
          }),
        ),
      ),
    get: (id) => mapped("ProviderNativeForkOperationRepository.get", selectById({ id })),
    listOpen: () =>
      mapped(
        "ProviderNativeForkOperationRepository.listOpen",
        SqlSchema.findAll({
          Request: Schema.Void,
          Result: ProviderNativeForkOperationRecord,
          execute: () => sql`
        SELECT operation_id AS id, command_id AS "commandId",
          source_thread_id AS "sourceThreadId", target_thread_id AS "targetThreadId",
          operation_state AS state, source_state_revision AS "sourceStateRevision",
          source_binding_revision AS "sourceBindingRevision",
          target_native_state_generation_id AS "targetNativeStateGenerationId",
          selection_json AS "selectionJson", command_json AS "commandJson", cwd,
          fork_result_json AS "forkResultJson", failure_reason AS "failureReason",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM provider_native_fork_operations
        WHERE operation_state NOT IN ('committed', 'failed')
        ORDER BY created_at ASC, operation_id ASC
      `,
        })(),
      ),
    transition,
    markCommittedInCurrentTransaction,
  } satisfies ProviderNativeForkOperationRepositoryShape;
});

export const ProviderNativeForkOperationRepositoryLive = Layer.effect(
  ProviderNativeForkOperationRepository,
  make,
);
