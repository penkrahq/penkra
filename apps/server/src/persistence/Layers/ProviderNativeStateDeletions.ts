// FILE: ProviderNativeStateDeletions.ts
// Purpose: SQLite implementation of crash-safe native-generation cleanup work.

import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderNativeStateDeletionPersistenceError,
  ProviderNativeStateDeletionRepository,
  type ProviderNativeStateDeletionRecord,
  type ProviderNativeStateDeletionRepositoryShape,
} from "../Services/ProviderNativeStateDeletions.ts";

const failure = (operation: string) => (cause: unknown) =>
  new ProviderNativeStateDeletionPersistenceError({ operation, cause });

const makeProviderNativeStateDeletionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listPending = sql<ProviderNativeStateDeletionRecord>`
    SELECT native_state_generation_id AS "nativeStateGenerationId",
      owner_thread_id AS "ownerThreadId", deletion_state AS state,
      failure_reason AS "failureReason"
    FROM provider_native_state_deletions
    WHERE deletion_state IN ('pending', 'deleting')
    ORDER BY created_at ASC, native_state_generation_id ASC
  `.pipe(Effect.mapError(failure("listPending")));

  const markDeleting: ProviderNativeStateDeletionRepositoryShape["markDeleting"] = (generationId) =>
    sql<{ readonly id: string }>`
        UPDATE provider_native_state_deletions
        SET deletion_state = 'deleting', failure_reason = NULL,
          updated_at = ${new Date().toISOString()}
        WHERE native_state_generation_id = ${generationId}
          AND deletion_state IN ('pending', 'deleting')
        RETURNING native_state_generation_id AS id
      `.pipe(
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.void
          : Effect.fail(new Error("native-state deletion work is unavailable")),
      ),
      Effect.mapError(failure("markDeleting")),
    );

  const resetPending: ProviderNativeStateDeletionRepositoryShape["resetPending"] = (input) =>
    sql`
      UPDATE provider_native_state_deletions
      SET deletion_state = 'pending', failure_reason = ${input.failureReason},
        updated_at = ${new Date().toISOString()}
      WHERE native_state_generation_id = ${input.generationId}
        AND deletion_state = 'deleting'
    `.pipe(Effect.asVoid, Effect.mapError(failure("resetPending")));

  const finalize: ProviderNativeStateDeletionRepositoryShape["finalize"] = (input) =>
    sql
      .withTransaction(
        sql<{ readonly id: string }>`
        DELETE FROM provider_native_state_generations
        WHERE native_state_generation_id = ${input.generationId}
          AND owner_thread_id = ${input.ownerThreadId}
          AND NOT EXISTS (
            SELECT 1 FROM thread_harness_states
            WHERE native_state_generation_id = ${input.generationId}
          )
        RETURNING native_state_generation_id AS id
      `.pipe(
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.void
              : Effect.fail(new Error("native-state generation is still referenced or changed")),
          ),
          Effect.andThen(sql<{ readonly id: string }>`
          DELETE FROM provider_native_state_deletions
          WHERE native_state_generation_id = ${input.generationId}
            AND owner_thread_id = ${input.ownerThreadId}
            AND deletion_state = 'deleting'
          RETURNING native_state_generation_id AS id
        `),
          Effect.flatMap((rows) =>
            rows.length === 1
              ? Effect.void
              : Effect.fail(new Error("native-state deletion work changed before finalization")),
          ),
        ),
      )
      .pipe(Effect.mapError(failure("finalize")));

  return {
    listPending,
    markDeleting,
    resetPending,
    finalize,
  } satisfies ProviderNativeStateDeletionRepositoryShape;
});

export const ProviderNativeStateDeletionRepositoryLive = Layer.effect(
  ProviderNativeStateDeletionRepository,
  makeProviderNativeStateDeletionRepository,
);
