// FILE: ProviderInstallations.ts
// Purpose: Atomically activates verified installations while retaining prior generations.

import { ProviderInstallation } from "@penkra/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  ProviderInstallationRepository,
  ProviderInstallationRecord,
  type ProviderInstallationRepositoryShape,
} from "../Services/ProviderInstallations.ts";

const makeProviderInstallationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderInstallation,
    execute: () => sql`
      SELECT
        installation_id AS id,
        harness_kind AS harness,
        version,
        platform,
        architecture,
        adapter_version AS "adapterVersion",
        protocol_version AS "protocolVersion",
        lifecycle,
        health_reason AS "healthReason",
        installed_at AS "installedAt",
        activated_at AS "activatedAt",
        retired_at AS "retiredAt"
      FROM provider_installations
      ORDER BY installed_at DESC, installation_id DESC
    `,
  });
  const selectById = (id: string) =>
    listRows().pipe(
      Effect.map((rows) => rows.find((row) => row.id === id)),
      Effect.flatMap((row) =>
        row ? Effect.succeed(row) : Effect.die("Activated installation was not readable."),
      ),
    );
  const selectRecord = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String }),
    Result: ProviderInstallationRecord,
    execute: ({ id }) => sql`
      SELECT installation_id AS id, harness_kind AS harness, version, platform, architecture,
        executable_path AS "executablePath", artifact_source AS "artifactSource",
        artifact_url AS "artifactUrl", artifact_sha256 AS "artifactSha256",
        adapter_version AS "adapterVersion", protocol_version AS "protocolVersion",
        lifecycle, health_reason AS "healthReason", installed_at AS "installedAt",
        activated_at AS "activatedAt", retired_at AS "retiredAt"
      FROM provider_installations WHERE installation_id = ${id}
    `,
  });
  const mapped = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.mapError(toPersistenceSqlOrDecodeError(`${operation}:query`, `${operation}:decode`)),
    );

  return {
    activate: (input) =>
      mapped(
        "ProviderInstallationRepository.activate",
        sql.withTransaction(
          sql`
            UPDATE provider_installations
            SET lifecycle = 'retired', retired_at = ${input.activatedAt}
            WHERE harness_kind = ${input.harness}
              AND lifecycle = 'active'
              AND installation_id != ${input.id}
          `.pipe(
            Effect.andThen(sql`
              INSERT INTO provider_installations (
                installation_id, harness_kind, version, platform, architecture,
                executable_path, artifact_source, artifact_url, artifact_sha256,
                adapter_version, protocol_version, lifecycle, health_reason,
                installed_at, activated_at, retired_at
              ) VALUES (
                ${input.id}, ${input.harness}, ${input.version}, ${input.platform},
                ${input.architecture}, ${input.executablePath}, ${input.artifactSource},
                ${input.artifactUrl}, ${input.artifactSha256}, ${input.adapterVersion},
                ${input.protocolVersion}, 'active', NULL, ${input.installedAt},
                ${input.activatedAt}, NULL
              )
              ON CONFLICT (installation_id) DO UPDATE SET
                lifecycle = 'active', health_reason = NULL,
                activated_at = excluded.activated_at, retired_at = NULL
            `),
            Effect.andThen(selectById(input.id)),
          ),
        ),
      ),
    list: () => mapped("ProviderInstallationRepository.list", listRows()),
    getRecord: (id) => mapped("ProviderInstallationRepository.getRecord", selectRecord({ id })),
    reactivate: (id, activatedAt) =>
      mapped(
        "ProviderInstallationRepository.reactivate",
        sql.withTransaction(
          selectRecord({ id }).pipe(
            Effect.flatMap((record) =>
              Option.isNone(record)
                ? Effect.die("The predecessor installation was not readable.")
                : sql`
                    UPDATE provider_installations
                    SET lifecycle = 'retired', retired_at = ${activatedAt}
                    WHERE harness_kind = ${record.value.harness}
                      AND lifecycle = 'active'
                      AND installation_id != ${id}
                  `.pipe(
                    Effect.andThen(sql`
                      UPDATE provider_installations
                      SET lifecycle = 'active', health_reason = NULL,
                        activated_at = ${activatedAt}, retired_at = NULL
                      WHERE installation_id = ${id}
                    `),
                    Effect.andThen(selectById(id)),
                  ),
            ),
          ),
        ),
      ),
  } satisfies ProviderInstallationRepositoryShape;
});

export const ProviderInstallationRepositoryLive = Layer.effect(
  ProviderInstallationRepository,
  makeProviderInstallationRepository,
);
