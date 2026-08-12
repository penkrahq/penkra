// FILE: ProviderThreadSwitchOperations.ts
// Purpose: SQLite-backed send-time Connection-switch journal.

import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  ProviderThreadSwitchOperationRecord,
  ProviderThreadSwitchOperationRepository,
  type ProviderThreadSwitchOperationRepositoryShape,
} from "../Services/ProviderThreadSwitchOperations.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectById = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String }),
    Result: ProviderThreadSwitchOperationRecord,
    execute: ({ id }) => sql`
      SELECT operation_id AS id, thread_id AS "threadId", command_id AS "commandId",
        operation_kind AS kind,
        operation_state AS state, source_state_revision AS "sourceStateRevision",
        source_binding_revision AS "sourceBindingRevision",
        target_native_state_generation_id AS "targetNativeStateGenerationId",
        selection_json AS "selectionJson", command_json AS "commandJson", cwd,
        verification_json AS "verificationJson",
        failure_reason AS "failureReason", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM provider_thread_switch_operations WHERE operation_id = ${id}
    `,
  });
  const mapped = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.mapError(toPersistenceSqlOrDecodeError(`${operation}:query`, `${operation}:decode`)),
    );
  const transition: ProviderThreadSwitchOperationRepositoryShape["transition"] = (input) =>
    mapped(
      "ProviderThreadSwitchOperationRepository.transition",
      sql`
        UPDATE provider_thread_switch_operations
        SET operation_state = ${input.state}, failure_reason = ${input.failureReason},
          verification_json = COALESCE(${input.verificationJson ?? null}, verification_json),
          updated_at = ${input.updatedAt}
        WHERE operation_id = ${input.id}
      `.pipe(Effect.andThen(selectById({ id: input.id }))),
    );
  const markInterruptedWithSettledSelection: ProviderThreadSwitchOperationRepositoryShape["markInterruptedWithSettledSelection"] =
    (input) =>
      mapped(
        "ProviderThreadSwitchOperationRepository.markInterruptedWithSettledSelection",
        sql`
          UPDATE provider_thread_switch_operations
          SET operation_state = 'interrupted',
            source_state_revision = ${input.sourceStateRevision},
            source_binding_revision = ${input.sourceBindingRevision},
            selection_json = ${input.selectionJson},
            failure_reason = NULL,
            updated_at = ${input.updatedAt}
          WHERE operation_id = ${input.id} AND operation_state = 'pending'
        `.pipe(Effect.andThen(selectById({ id: input.id }))),
      );

  return {
    begin: (input) =>
      mapped(
        "ProviderThreadSwitchOperationRepository.begin",
        sql`
          INSERT INTO provider_thread_switch_operations (
            operation_id, thread_id, command_id, operation_kind, operation_state,
            source_state_revision, source_binding_revision,
              target_native_state_generation_id, selection_json, command_json, cwd,
            verification_json, failure_reason, created_at, updated_at
          ) VALUES (
            ${input.id}, ${input.threadId}, ${input.commandId}, ${input.kind}, ${input.state},
            ${input.sourceStateRevision}, ${input.sourceBindingRevision},
            ${input.targetNativeStateGenerationId}, ${input.selectionJson}, ${input.commandJson}, ${input.cwd},
            ${input.verificationJson}, ${input.failureReason}, ${input.createdAt}, ${input.updatedAt}
          )
        `.pipe(Effect.andThen(selectById({ id: input.id }))),
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die("Inserted provider thread switch operation was not readable."),
            onSome: Effect.succeed,
          }),
        ),
      ),
    get: (id) => mapped("ProviderThreadSwitchOperationRepository.get", selectById({ id })),
    listOpen: () =>
      mapped(
        "ProviderThreadSwitchOperationRepository.listOpen",
        SqlSchema.findAll({
          Request: Schema.Void,
          Result: ProviderThreadSwitchOperationRecord,
          execute: () => sql`
            SELECT operation_id AS id, thread_id AS "threadId", command_id AS "commandId",
              operation_kind AS kind,
              operation_state AS state, source_state_revision AS "sourceStateRevision",
              source_binding_revision AS "sourceBindingRevision",
              target_native_state_generation_id AS "targetNativeStateGenerationId",
              selection_json AS "selectionJson", command_json AS "commandJson", cwd,
              verification_json AS "verificationJson",
              failure_reason AS "failureReason", created_at AS "createdAt", updated_at AS "updatedAt"
            FROM provider_thread_switch_operations
            WHERE operation_state NOT IN ('committed', 'failed')
            ORDER BY created_at ASC, operation_id ASC
          `,
        })(),
      ),
    markInterruptedWithSettledSelection,
    transition,
    markCommittedInCurrentTransaction: ({ id, updatedAt }) =>
      transition({ id, state: "committed", failureReason: null, updatedAt }),
  } satisfies ProviderThreadSwitchOperationRepositoryShape;
});

export const ProviderThreadSwitchOperationRepositoryLive = Layer.effect(
  ProviderThreadSwitchOperationRepository,
  make,
);
