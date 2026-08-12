// FILE: ProviderConnectionLogins.ts
// Purpose: SQLite journal for provider-owned Connection login.

import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  ProviderConnectionLoginRecord,
  ProviderConnectionLoginRepository,
  type ProviderConnectionLoginRepositoryShape,
} from "../Services/ProviderConnectionLogins.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = SqlSchema.findOneOption({
    Request: Schema.Struct({ operationId: Schema.String }),
    Result: ProviderConnectionLoginRecord,
    execute: ({ operationId }) => sql`
      SELECT operation_id AS "operationId", connection_id AS "connectionId",
        harness_kind AS harness, authentication_target_id AS "authenticationTargetId",
        authentication_method_id AS "authenticationMethodId", label,
        profile_ref AS "profileRef", provider_login_id AS "providerLoginId",
        operation_state AS state, provider_identity_id AS "providerIdentityId",
        failure_reason AS "failureReason", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM provider_connection_logins WHERE operation_id = ${operationId}
    `,
  });
  const mapped = <A>(name: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlOrDecodeError(`${name}:query`, `${name}:decode`)));
  return {
    begin: (record) =>
      mapped(
        "ProviderConnectionLoginRepository.begin",
        sql`
          INSERT INTO provider_connection_logins (
            operation_id, connection_id, harness_kind, authentication_target_id,
            authentication_method_id, label, profile_ref, provider_login_id,
            operation_state, provider_identity_id, failure_reason, created_at, updated_at
          ) VALUES (
            ${record.operationId}, ${record.connectionId}, ${record.harness},
            ${record.authenticationTargetId}, ${record.authenticationMethodId}, ${record.label},
            ${record.profileRef}, ${record.providerLoginId}, ${record.state},
            ${record.providerIdentityId}, ${record.failureReason}, ${record.createdAt}, ${record.updatedAt}
          )
        `.pipe(Effect.asVoid),
      ),
    get: (operationId) => mapped("ProviderConnectionLoginRepository.get", select({ operationId })),
    listOpen: () =>
      mapped(
        "ProviderConnectionLoginRepository.listOpen",
        SqlSchema.findAll({
          Request: Schema.Void,
          Result: ProviderConnectionLoginRecord,
          execute: () => sql`
            SELECT operation_id AS "operationId", connection_id AS "connectionId",
              harness_kind AS harness, authentication_target_id AS "authenticationTargetId",
              authentication_method_id AS "authenticationMethodId", label,
              profile_ref AS "profileRef", provider_login_id AS "providerLoginId",
              operation_state AS state, provider_identity_id AS "providerIdentityId",
              failure_reason AS "failureReason", created_at AS "createdAt", updated_at AS "updatedAt"
            FROM provider_connection_logins
            WHERE operation_state IN ('starting', 'awaiting-user', 'verified')
            ORDER BY created_at ASC
          `,
        })(),
      ),
    transition: (input) =>
      mapped(
        "ProviderConnectionLoginRepository.transition",
        sql`
          UPDATE provider_connection_logins
          SET operation_state = ${input.state}, provider_login_id = ${input.providerLoginId},
            provider_identity_id = ${input.providerIdentityId}, failure_reason = ${input.failureReason},
            updated_at = ${input.updatedAt}
          WHERE operation_id = ${input.operationId}
        `.pipe(Effect.andThen(select({ operationId: input.operationId }))),
      ),
  } satisfies ProviderConnectionLoginRepositoryShape;
});

export const ProviderConnectionLoginRepositoryLive = Layer.effect(
  ProviderConnectionLoginRepository,
  make,
);
