// FILE: ProviderConnections.ts
// Purpose: SQLite implementation of durable Connection identity, lifecycle, and Space defaults.

import { ProviderConnection, SpaceConnectionDefault } from "@penkra/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  CreateProviderConnectionInput,
  ProviderCredentialProfileRecord,
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

  const selectIdentity = SqlSchema.findOneOption({
    Request: Schema.Struct({
      harness: CreateProviderConnectionInput.fields.harness,
      authenticationTargetId: CreateProviderConnectionInput.fields.authenticationTargetId,
      providerIdentityId: Schema.String,
    }),
    Result: ProviderConnectionRecord,
    execute: ({ harness, authenticationTargetId, providerIdentityId }) => sql`
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
      WHERE harness_kind = ${harness}
        AND authentication_target_id = ${authenticationTargetId}
        AND provider_identity_id = ${providerIdentityId}
      ORDER BY created_at ASC, connection_id ASC
      LIMIT 1
    `,
  });

  const listProfilesPendingCleanup = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderCredentialProfileRecord,
    execute: () => sql`
      SELECT profile.profile_ref AS "profileRef", profile.harness_kind AS harness,
        profile.authentication_target_id AS "authenticationTargetId",
        profile.authentication_method_id AS "authenticationMethodId", profile.lifecycle,
        profile.connection_id AS "connectionId",
        profile.login_operation_id AS "loginOperationId",
        profile.created_at AS "createdAt", profile.updated_at AS "updatedAt",
        profile.retired_at AS "retiredAt"
      FROM provider_credential_profiles profile
      LEFT JOIN provider_connection_logins login
        ON login.operation_id = profile.login_operation_id
      LEFT JOIN provider_connections connection
        ON connection.connection_id = profile.connection_id
      WHERE profile.lifecycle = 'retired'
        OR (
          profile.lifecycle = 'staging'
          AND login.operation_state IN ('completed', 'failed', 'cancelled')
        )
        OR (
          profile.lifecycle = 'active'
          AND connection.lifecycle = 'terminated'
        )
      ORDER BY COALESCE(profile.retired_at, profile.updated_at) ASC,
        profile.profile_ref ASC
    `,
  });

  const mapped = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.mapError(toPersistenceSqlOrDecodeError(`${operation}:query`, `${operation}:decode`)),
    );
  const getRecord = (id: Parameters<ProviderConnectionRepositoryShape["getRecord"]>[0]) =>
    mapped("ProviderConnectionRepository.getRecord", selectRecord({ id }));

  const commitManagedProfile: ProviderConnectionRepositoryShape["commitManagedProfile"] = (input) =>
    mapped(
      "ProviderConnectionRepository.commitManagedProfile",
      sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* selectRecord({ id: input.id });
          const canonical = yield* selectIdentity({
            harness: input.harness,
            authenticationTargetId: input.authenticationTargetId,
            providerIdentityId: input.providerIdentityId,
          });
          const stagedProfile = yield* sql<{ readonly profileRef: string }>`
            SELECT profile_ref AS "profileRef" FROM provider_credential_profiles
            WHERE profile_ref = ${input.profileRef}
              AND harness_kind = ${input.harness}
              AND authentication_target_id = ${input.authenticationTargetId}
              AND authentication_method_id = ${input.authenticationMethodId}
              AND lifecycle IN ('staging', 'active')
          `;
          if (stagedProfile.length !== 1) return Option.none();
          if (
            Option.isSome(existing) &&
            (existing.value.harness !== input.harness ||
              existing.value.authenticationTargetId !== input.authenticationTargetId ||
              existing.value.credentialRef !== null ||
              existing.value.profileRef !== input.profileRef)
          ) {
            return Option.none();
          }
          if (Option.isSome(canonical) && canonical.value.credentialRef !== null) {
            return Option.none();
          }

          const connectionId = Option.isSome(canonical) ? canonical.value.id : input.id;
          const previousProfileRef = Option.isSome(canonical) ? canonical.value.profileRef : null;

          // Credential profiles have immutable addresses. Cutover changes only
          // the logical Connection's reference; the provider-owned directory
          // and any path-keyed Keychain item remain exactly where login created them.
          yield* sql`
            UPDATE provider_credential_profiles
            SET lifecycle = 'retired', retired_at = ${input.updatedAt},
                updated_at = ${input.updatedAt}
            WHERE connection_id = ${connectionId} AND lifecycle = 'active'
              AND profile_ref != ${input.profileRef}
          `;

          if (Option.isNone(canonical) && Option.isNone(existing)) {
            yield* sql`
                INSERT INTO provider_connections (
                  connection_id, harness_kind, authentication_target_id,
                  authentication_method_id, label, credential_ref, profile_ref,
                  provider_identity_id, health_status, lifecycle, created_at, updated_at
                ) VALUES (
                  ${input.id}, ${input.harness}, ${input.authenticationTargetId},
                  ${input.authenticationMethodId}, ${input.label}, ${input.credentialRef},
                  ${input.profileRef}, ${input.providerIdentityId}, 'unknown', 'active',
                  ${input.createdAt}, ${input.updatedAt}
                )
              `;
          } else if (Option.isSome(canonical)) {
            yield* sql`
                UPDATE provider_connections
                SET authentication_method_id = ${input.authenticationMethodId},
                    label = ${input.label}, profile_ref = ${input.profileRef},
                    provider_identity_id = ${input.providerIdentityId},
                    health_status = 'unknown', health_reason = NULL, last_checked_at = NULL,
                    lifecycle = 'active', termination_reason = NULL, terminated_at = NULL,
                    updated_at = ${input.updatedAt}
                WHERE connection_id = ${connectionId}
              `;
          }

          yield* sql`
            UPDATE provider_credential_profiles
            SET lifecycle = 'active', connection_id = ${connectionId}, retired_at = NULL,
                updated_at = ${input.updatedAt}
            WHERE profile_ref = ${input.profileRef}
              AND harness_kind = ${input.harness}
              AND authentication_target_id = ${input.authenticationTargetId}
              AND authentication_method_id = ${input.authenticationMethodId}
              AND lifecycle IN ('staging', 'active')
          `;
          const committed = yield* selectRecord({ id: connectionId });
          const committedRecord = yield* Option.match(committed, {
            onNone: () => Effect.die("Committed managed Connection was not readable."),
            onSome: Effect.succeed,
          });
          return Option.some({
            connection: toPublicConnection(committedRecord),
            retiredProfileRef:
              previousProfileRef !== null && previousProfileRef !== input.profileRef
                ? previousProfileRef
                : null,
          });
        }),
      ),
    );

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
            SET provider_identity_id = 'superseded:' || ${input.id} || ':' || connection_id,
                updated_at = ${input.updatedAt}
            WHERE connection_id != ${input.id}
              AND harness_kind = (
                SELECT harness_kind FROM provider_connections WHERE connection_id = ${input.id}
              )
              AND authentication_target_id = (
                SELECT authentication_target_id
                FROM provider_connections WHERE connection_id = ${input.id}
              )
              AND provider_identity_id = ${input.providerIdentityId}
          `.pipe(
            Effect.andThen(sql`
            UPDATE provider_connections
            SET label = ${input.label}, provider_identity_id = ${input.providerIdentityId},
                updated_at = ${input.updatedAt}
            WHERE connection_id = ${input.id} AND lifecycle = 'active'
              AND credential_ref IS NULL AND profile_ref IS NOT NULL
            `),
            Effect.andThen(sql`
              UPDATE thread_runtime_bindings
              SET connection_id = ${input.id}, binding_revision = binding_revision + 1,
                  updated_at = ${input.updatedAt}
              WHERE connection_id IN (
                SELECT connection_id FROM provider_connections
                WHERE connection_id != ${input.id}
                  AND provider_identity_id LIKE 'superseded:' || ${input.id} || ':%'
              )
            `),
            Effect.andThen(sql`
              UPDATE space_connection_defaults
              SET connection_id = ${input.id}, updated_at = ${input.updatedAt}
              WHERE connection_id IN (
                SELECT connection_id FROM provider_connections
                WHERE connection_id != ${input.id}
                  AND provider_identity_id LIKE 'superseded:' || ${input.id} || ':%'
              )
            `),
            Effect.andThen(sql`
              UPDATE provider_connections
              SET lifecycle = 'terminated', termination_reason = 'removed',
                  terminated_at = ${input.updatedAt}, health_status = 'unavailable',
                  updated_at = ${input.updatedAt}
              WHERE connection_id != ${input.id}
                AND provider_identity_id LIKE 'superseded:' || ${input.id} || ':%'
                AND lifecycle = 'active'
            `),
            Effect.andThen(selectRecord({ id: input.id })),
          ),
        ),
      ).pipe(Effect.map(Option.map(toPublicConnection))),
    commitManagedProfile,
    retireManagedProfile: (input) =>
      mapped(
        "ProviderConnectionRepository.retireManagedProfile",
        sql`
          UPDATE provider_credential_profiles
          SET lifecycle = 'retired', retired_at = ${input.retiredAt},
              updated_at = ${input.retiredAt}
          WHERE profile_ref = ${input.profileRef} AND lifecycle IN ('staging', 'active')
        `.pipe(Effect.asVoid),
      ),
    listManagedProfilesPendingCleanup: () =>
      mapped(
        "ProviderConnectionRepository.listManagedProfilesPendingCleanup",
        listProfilesPendingCleanup(),
      ),
    markManagedProfileRemoved: (input) =>
      mapped(
        "ProviderConnectionRepository.markManagedProfileRemoved",
        sql`
          UPDATE provider_credential_profiles
          SET lifecycle = 'removed', updated_at = ${input.removedAt}
          WHERE profile_ref = ${input.profileRef} AND lifecycle = 'retired'
        `.pipe(Effect.asVoid),
      ),
    reactivateIdentity: (input) =>
      mapped(
        "ProviderConnectionRepository.reactivateIdentity",
        sql.withTransaction(
          sql`
            UPDATE provider_connections
            SET provider_identity_id = 'superseded:' || ${input.id} || ':' || connection_id,
                label = label || ' (superseded ' || substr(connection_id, 1, 8) || ')',
                updated_at = ${input.updatedAt}
            WHERE connection_id != ${input.id}
              AND harness_kind = ${input.harness}
              AND authentication_target_id = ${input.authenticationTargetId}
              AND provider_identity_id = ${input.providerIdentityId}
          `.pipe(
            Effect.andThen(sql`
              UPDATE provider_connections
              SET authentication_method_id = ${input.authenticationMethodId},
                  label = ${input.label}, credential_ref = ${input.credentialRef},
                  profile_ref = ${input.profileRef},
                  provider_identity_id = ${input.providerIdentityId},
                  health_status = 'unknown', health_reason = NULL, last_checked_at = NULL,
                  lifecycle = 'active', termination_reason = NULL, terminated_at = NULL,
                  updated_at = ${input.updatedAt}
              WHERE connection_id = ${input.id}
                AND harness_kind = ${input.harness}
                AND authentication_target_id = ${input.authenticationTargetId}
            `),
            Effect.andThen(sql`
              UPDATE thread_runtime_bindings
              SET connection_id = ${input.id}, binding_revision = binding_revision + 1,
                  updated_at = ${input.updatedAt}
              WHERE connection_id IN (
                SELECT connection_id FROM provider_connections
                WHERE connection_id != ${input.id}
                  AND harness_kind = ${input.harness}
                  AND authentication_target_id = ${input.authenticationTargetId}
                  AND provider_identity_id LIKE 'superseded:' || ${input.id} || ':%'
              )
            `),
            Effect.andThen(sql`
              UPDATE space_connection_defaults
              SET connection_id = ${input.id}, updated_at = ${input.updatedAt}
              WHERE connection_id IN (
                SELECT connection_id FROM provider_connections
                WHERE connection_id != ${input.id}
                  AND harness_kind = ${input.harness}
                  AND authentication_target_id = ${input.authenticationTargetId}
                  AND provider_identity_id LIKE 'superseded:' || ${input.id} || ':%'
              )
            `),
            Effect.andThen(sql`
              UPDATE provider_connections
              SET lifecycle = 'terminated', termination_reason = 'removed',
                  terminated_at = ${input.updatedAt}, health_status = 'unavailable',
                  updated_at = ${input.updatedAt}
              WHERE connection_id != ${input.id}
                AND harness_kind = ${input.harness}
                AND authentication_target_id = ${input.authenticationTargetId}
                AND provider_identity_id LIKE 'superseded:' || ${input.id} || ':%'
                AND lifecycle = 'active'
            `),
            Effect.andThen(selectRecord({ id: input.id })),
          ),
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
