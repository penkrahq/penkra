// FILE: ProviderConnectionLogins.ts
// Purpose: In-process sign-in progress; credential profiles remain durable.

import { Effect, Layer, Option, PubSub } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  type ProviderConnectionLoginRecord,
  ProviderConnectionLoginRepository,
  type ProviderConnectionLoginRepositoryShape,
} from "../Services/ProviderConnectionLogins.ts";

export const makeProviderConnectionLogins = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<ProviderConnectionLoginRecord>();
  const records = new Map<string, ProviderConnectionLoginRecord>();
  return {
    subscribeChanges: PubSub.subscribe(changes),
    begin: (record) =>
      sql`
        INSERT INTO provider_credential_profiles (
          profile_ref, harness_kind, authentication_target_id, authentication_method_id,
          lifecycle, connection_id, login_operation_id, created_at, updated_at, retired_at
        ) VALUES (
          ${record.profileRef}, ${record.harness}, ${record.authenticationTargetId},
          ${record.authenticationMethodId}, 'staging', NULL, ${record.operationId},
          ${record.createdAt}, ${record.updatedAt}, NULL
        )
      `.pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProviderConnectionLoginRepository.begin:query",
            "ProviderConnectionLoginRepository.begin:decode",
          ),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            records.set(record.operationId, record);
          }),
        ),
        Effect.tap(() => PubSub.publish(changes, record)),
        Effect.asVoid,
        Effect.uninterruptible,
      ),
    get: (operationId) => Effect.sync(() => Option.fromUndefinedOr(records.get(operationId))),
    listOpen: () =>
      Effect.sync(() =>
        [...records.values()].filter(
          (record) =>
            record.state === "starting" ||
            record.state === "awaiting-user" ||
            record.state === "verified",
        ),
      ),
    transition: (input) =>
      Effect.sync(() => {
        const record = records.get(input.operationId);
        if (record === undefined) return Option.none();
        const next = {
          ...record,
          ...input,
          committedConnectionId:
            input.committedConnectionId === undefined
              ? record.committedConnectionId
              : input.committedConnectionId,
        };
        records.set(input.operationId, next);
        return Option.some(next);
      }).pipe(
        Effect.tap((record) =>
          Option.match(record, {
            onNone: () => Effect.void,
            onSome: (next) => PubSub.publish(changes, next),
          }),
        ),
      ),
  } satisfies ProviderConnectionLoginRepositoryShape;
});

export const ProviderConnectionLoginRepositoryLive = Layer.effect(
  ProviderConnectionLoginRepository,
  makeProviderConnectionLogins,
);
