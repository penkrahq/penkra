// FILE: ProviderConnectionOperations.ts
// Purpose: SQLite-backed Connection lifecycle operation journal.

import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  ProviderConnectionOperationRecord,
  ProviderConnectionOperationRepository,
  type ProviderConnectionOperationRepositoryShape,
} from "../Services/ProviderConnectionOperations.ts";

const makeProviderConnectionOperationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectById = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String }),
    Result: ProviderConnectionOperationRecord,
    execute: ({ id }) => sql`
      SELECT operation_id AS id, connection_id AS "connectionId", operation_kind AS kind,
        operation_state AS state, credential_ref AS "credentialRef", payload_json AS "payloadJson",
        failure_reason AS "failureReason", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM provider_connection_operations
      WHERE operation_id = ${id}
    `,
  });
  const listOpen = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderConnectionOperationRecord,
    execute: () => sql`
      SELECT operation_id AS id, connection_id AS "connectionId", operation_kind AS kind,
        operation_state AS state, credential_ref AS "credentialRef", payload_json AS "payloadJson",
        failure_reason AS "failureReason", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM provider_connection_operations
      WHERE operation_state NOT IN ('completed', 'failed')
      ORDER BY created_at ASC, operation_id ASC
    `,
  });
  const mapped = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.mapError(toPersistenceSqlOrDecodeError(`${operation}:query`, `${operation}:decode`)),
    );

  return {
    begin: (input) =>
      mapped(
        "ProviderConnectionOperationRepository.begin",
        sql`
          INSERT INTO provider_connection_operations (
            operation_id, connection_id, operation_kind, operation_state, credential_ref,
            payload_json, failure_reason, created_at, updated_at
          ) VALUES (
            ${input.id}, ${input.connectionId}, ${input.kind}, ${input.state},
            ${input.credentialRef}, ${input.payloadJson}, ${input.failureReason},
            ${input.createdAt}, ${input.updatedAt}
          )
        `.pipe(Effect.andThen(selectById({ id: input.id }))),
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die("Inserted Connection operation was not readable."),
            onSome: Effect.succeed,
          }),
        ),
      ),
    get: (id) => mapped("ProviderConnectionOperationRepository.get", selectById({ id })),
    listOpen: () => mapped("ProviderConnectionOperationRepository.listOpen", listOpen()),
    transition: (input) =>
      mapped(
        "ProviderConnectionOperationRepository.transition",
        sql`
          UPDATE provider_connection_operations
          SET operation_state = ${input.state}, credential_ref = ${input.credentialRef},
            failure_reason = ${input.failureReason}, updated_at = ${input.updatedAt}
          WHERE operation_id = ${input.id}
        `.pipe(Effect.andThen(selectById({ id: input.id }))),
      ),
  } satisfies ProviderConnectionOperationRepositoryShape;
});

export const ProviderConnectionOperationRepositoryLive = Layer.effect(
  ProviderConnectionOperationRepository,
  makeProviderConnectionOperationRepository,
);
