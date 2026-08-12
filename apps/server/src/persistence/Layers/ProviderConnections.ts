// FILE: ProviderConnections.ts
// Purpose: SQLite implementation of terminal Connection lifecycle and Space defaults.

import { ProviderConnection, SpaceConnectionDefault } from "@penkra/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  CreateProviderConnectionInput,
  ProviderConnectionRecord,
  ProviderConnectionRepository,
  type ProviderConnectionRepositoryShape,
} from "../Services/ProviderConnections.ts";

const toPublicConnection = (record: ProviderConnectionRecord): ProviderConnection => ({
  id: record.id,
  harness: record.harness,
  authenticationTargetId: record.authenticationTargetId,
  authenticationMethodId: record.authenticationMethodId,
  label: record.label,
  providerIdentityId: record.providerIdentityId,
  health: record.health,
  healthReason: record.healthReason,
  lastCheckedAt: record.lastCheckedAt,
  lifecycle: record.lifecycle,
  terminationReason: record.terminationReason,
  terminatedAt: record.terminatedAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const makeProviderConnectionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRecord = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: CreateProviderConnectionInput.fields.id }),
    Result: ProviderConnectionRecord,
    execute: ({ id }) => sql`
      SELECT
        connection_id AS id,
        harness_kind AS harness,
        authentication_target_id AS "authenticationTargetId",
        authentication_method_id AS "authenticationMethodId",
        label,
        credential_ref AS "credentialRef",
        profile_ref AS "profileRef",
        provider_identity_id AS "providerIdentityId",
        health_status AS health,
        health_reason AS "healthReason",
        last_checked_at AS "lastCheckedAt",
        lifecycle,
        termination_reason AS "terminationReason",
        terminated_at AS "terminatedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM provider_connections
      WHERE connection_id = ${id}
    `,
  });

  const listRecords = SqlSchema.findAll({
    Request: Schema.Struct({ includeTerminated: Schema.Boolean }),
    Result: ProviderConnectionRecord,
    execute: ({ includeTerminated }) => sql`
      SELECT
        connection_id AS id,
        harness_kind AS harness,
        authentication_target_id AS "authenticationTargetId",
        authentication_method_id AS "authenticationMethodId",
        label,
        credential_ref AS "credentialRef",
        profile_ref AS "profileRef",
        provider_identity_id AS "providerIdentityId",
        health_status AS health,
        health_reason AS "healthReason",
        last_checked_at AS "lastCheckedAt",
        lifecycle,
        termination_reason AS "terminationReason",
        terminated_at AS "terminatedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM provider_connections
      WHERE ${includeTerminated ? 1 : 0} = 1 OR lifecycle = 'active'
      ORDER BY created_at DESC, connection_id DESC
    `,
  });

  const listDefaults = SqlSchema.findAll({
    Request: Schema.Struct({ spaceId: SpaceConnectionDefault.fields.spaceId }),
    Result: SpaceConnectionDefault,
    execute: ({ spaceId }) => sql`
      SELECT
        space_id AS "spaceId",
        harness_kind AS harness,
        connection_id AS "connectionId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM space_connection_defaults
      WHERE space_id = ${spaceId}
      ORDER BY harness_kind ASC
    `,
  });

  const mapped = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.mapError(toPersistenceSqlOrDecodeError(`${operation}:query`, `${operation}:decode`)),
    );
  const getRecord = (id: Parameters<ProviderConnectionRepositoryShape["getRecord"]>[0]) =>
    mapped("ProviderConnectionRepository.getRecord", selectRecord({ id }));
  const getPublic = (id: Parameters<ProviderConnectionRepositoryShape["getRecord"]>[0]) =>
    getRecord(id).pipe(Effect.map(Option.map(toPublicConnection)));

  return {
    create: (input) =>
      mapped(
        "ProviderConnectionRepository.create",
        sql.withTransaction(
          sql`
            INSERT INTO provider_connections (
              connection_id, harness_kind, authentication_target_id,
              authentication_method_id, label, credential_ref, profile_ref,
              provider_identity_id, health_status, lifecycle, created_at, updated_at
            ) VALUES (
              ${input.id}, ${input.harness}, ${input.authenticationTargetId},
              ${input.authenticationMethodId}, ${input.label}, ${input.credentialRef},
              ${input.profileRef}, ${input.providerIdentityId}, 'unknown', 'active',
              ${input.createdAt}, ${input.createdAt}
            )
          `.pipe(Effect.andThen(selectRecord({ id: input.id }))),
        ),
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die("Inserted Connection was not readable."),
            onSome: (record) => Effect.succeed(toPublicConnection(record)),
          }),
        ),
      ),
    getRecord,
    list: (input) =>
      mapped(
        "ProviderConnectionRepository.list",
        listRecords({ includeTerminated: input?.includeTerminated === true }),
      ).pipe(Effect.map((records) => records.map(toPublicConnection))),
    rename: (input) =>
      mapped(
        "ProviderConnectionRepository.rename",
        sql.withTransaction(
          sql`
            UPDATE provider_connections
            SET label = ${input.label}, updated_at = ${input.updatedAt}
            WHERE connection_id = ${input.id} AND lifecycle = 'active'
          `.pipe(Effect.andThen(selectRecord({ id: input.id }))),
        ),
      ).pipe(Effect.map(Option.map(toPublicConnection))),
    identifyManaged: (input) =>
      mapped(
        "ProviderConnectionRepository.identifyManaged",
        sql.withTransaction(
          sql`
            UPDATE provider_connections
            SET label = ${input.label}, provider_identity_id = ${input.providerIdentityId},
                updated_at = ${input.updatedAt}
            WHERE connection_id = ${input.id} AND lifecycle = 'active'
              AND credential_ref IS NULL AND profile_ref IS NOT NULL
          `.pipe(Effect.andThen(selectRecord({ id: input.id }))),
        ),
      ).pipe(Effect.map(Option.map(toPublicConnection))),
    observeHealth: (input) =>
      mapped(
        "ProviderConnectionRepository.observeHealth",
        sql.withTransaction(
          sql`
            UPDATE provider_connections
            SET health_status = ${input.health}, health_reason = ${input.reason},
                last_checked_at = ${input.checkedAt}, updated_at = ${input.checkedAt}
            WHERE connection_id = ${input.id} AND lifecycle = 'active'
          `.pipe(Effect.andThen(selectRecord({ id: input.id }))),
        ),
      ).pipe(Effect.map(Option.map(toPublicConnection))),
    terminate: (input) =>
      mapped(
        "ProviderConnectionRepository.terminate",
        sql.withTransaction(
          sql`
            UPDATE provider_connections
            SET lifecycle = 'terminated', termination_reason = ${input.reason},
                terminated_at = ${input.terminatedAt}, updated_at = ${input.terminatedAt},
                health_status = 'unavailable'
            WHERE connection_id = ${input.id} AND lifecycle = 'active'
          `.pipe(Effect.andThen(selectRecord({ id: input.id }))),
        ),
      ).pipe(Effect.map(Option.map(toPublicConnection))),
    setSpaceDefault: (input) =>
      mapped(
        "ProviderConnectionRepository.setSpaceDefault",
        sql`
          INSERT INTO space_connection_defaults (
            space_id, harness_kind, connection_id, created_at, updated_at
          ) VALUES (
            ${input.spaceId}, ${input.harness}, ${input.connectionId},
            ${input.createdAt}, ${input.updatedAt}
          )
          ON CONFLICT (space_id, harness_kind) DO UPDATE SET
            connection_id = excluded.connection_id,
            updated_at = excluded.updated_at
        `.pipe(Effect.asVoid),
      ),
    listSpaceDefaults: (spaceId) =>
      mapped("ProviderConnectionRepository.listSpaceDefaults", listDefaults({ spaceId })),
  } satisfies ProviderConnectionRepositoryShape;
});

export const ProviderConnectionRepositoryLive = Layer.effect(
  ProviderConnectionRepository,
  makeProviderConnectionRepository,
);
