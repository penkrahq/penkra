// FILE: ThreadProviderBindings.ts
// Purpose: SQLite implementation of exact native state and optimistic runtime bindings.

import { ThreadRuntimeBinding } from "@penkra/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  ThreadHarnessStateRecord,
  ThreadProviderBindingRepository,
  type ThreadProviderBindingRepositoryShape,
} from "../Services/ThreadProviderBindings.ts";

const makeThreadProviderBindingRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const stateColumns = sql.literal(`
    thread_id AS "threadId", harness_kind AS harness,
    native_state_generation_id AS "nativeStateGenerationId",
    provider_session_id AS "providerSessionId",
    native_state_locator_json AS "nativeStateLocatorJson",
    last_verified_resume_at AS "lastVerifiedResumeAt",
    state_revision AS revision, created_at AS "createdAt", updated_at AS "updatedAt"
  `);
  const bindingColumns = sql.literal(`
    thread_id AS "threadId", connection_id AS "connectionId",
    installation_id AS "installationId", internal_provider_id AS "internalProviderId",
    model_id AS "modelId", binding_revision AS revision,
    created_at AS "createdAt", updated_at AS "updatedAt"
  `);
  const selectState = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadHarnessStateRecord.fields.threadId }),
    Result: ThreadHarnessStateRecord,
    execute: ({ threadId }) => sql`
      SELECT ${stateColumns} FROM thread_harness_states WHERE thread_id = ${threadId}
    `,
  });
  const selectBinding = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadRuntimeBinding.fields.threadId }),
    Result: ThreadRuntimeBinding,
    execute: ({ threadId }) => sql`
      SELECT ${bindingColumns} FROM thread_runtime_bindings WHERE thread_id = ${threadId}
    `,
  });
  const updateState = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: ThreadHarnessStateRecord.fields.threadId,
      expectedRevision: Schema.Int,
      nativeStateGenerationId: ThreadHarnessStateRecord.fields.nativeStateGenerationId,
      providerSessionId: Schema.NullOr(Schema.String),
      nativeStateLocatorJson: Schema.String,
      verifiedAt: Schema.NullOr(Schema.String),
      updatedAt: Schema.String,
    }),
    Result: ThreadHarnessStateRecord,
    execute: (input) => sql`
      UPDATE thread_harness_states
      SET native_state_generation_id = ${input.nativeStateGenerationId},
        provider_session_id = ${input.providerSessionId},
        native_state_locator_json = ${input.nativeStateLocatorJson},
        last_verified_resume_at = ${input.verifiedAt},
        state_revision = state_revision + 1,
        updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId} AND state_revision = ${input.expectedRevision}
      RETURNING ${stateColumns}
    `,
  });
  const updateBinding = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: ThreadRuntimeBinding.fields.threadId,
      expectedRevision: Schema.Int,
      connectionId: ThreadRuntimeBinding.fields.connectionId,
      installationId: ThreadRuntimeBinding.fields.installationId,
      internalProviderId: ThreadRuntimeBinding.fields.internalProviderId,
      modelId: ThreadRuntimeBinding.fields.modelId,
      updatedAt: Schema.String,
    }),
    Result: ThreadRuntimeBinding,
    execute: (input) => sql`
      UPDATE thread_runtime_bindings
      SET connection_id = ${input.connectionId}, installation_id = ${input.installationId},
        internal_provider_id = ${input.internalProviderId}, model_id = ${input.modelId},
        binding_revision = binding_revision + 1, updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId} AND binding_revision = ${input.expectedRevision}
      RETURNING ${bindingColumns}
    `,
  });
  const mapped = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.mapError(toPersistenceSqlOrDecodeError(`${operation}:query`, `${operation}:decode`)),
    );

  const initializeThreadInCurrentTransaction: ThreadProviderBindingRepositoryShape["initializeThread"] =
    (input) =>
      mapped(
        "ThreadProviderBindingRepository.initializeThreadInCurrentTransaction",
        sql`
          INSERT INTO provider_native_state_generations (
            native_state_generation_id, owner_thread_id, harness_kind, adapter_schema_version,
            state_manifest_json, lifecycle, created_at
          ) VALUES (
            ${input.generation.id}, ${input.generation.ownerThreadId}, ${input.generation.harness},
            ${input.generation.adapterSchemaVersion}, ${input.generation.stateManifestJson},
            'active', ${input.generation.createdAt}
          )
        `.pipe(
          Effect.andThen(sql`
            INSERT INTO thread_harness_states (
              thread_id, harness_kind, native_state_generation_id, provider_session_id,
              native_state_locator_json, last_verified_resume_at, state_revision,
              created_at, updated_at
            ) VALUES (
              ${input.threadId}, ${input.generation.harness}, ${input.generation.id},
              ${input.providerSessionId}, ${input.nativeStateLocatorJson}, NULL, 0,
              ${input.createdAt}, ${input.createdAt}
            )
          `),
          Effect.andThen(sql`
            INSERT INTO thread_runtime_bindings (
              thread_id, connection_id, installation_id, internal_provider_id,
              model_id, binding_revision, created_at, updated_at
            ) VALUES (
              ${input.threadId}, ${input.connectionId}, ${input.installationId},
              ${input.internalProviderId}, ${input.modelId}, 0,
              ${input.createdAt}, ${input.createdAt}
            )
          `),
          Effect.asVoid,
        ),
      );
  const commitSwitchInCurrentTransaction: ThreadProviderBindingRepositoryShape["commitSwitch"] = (
    input,
  ) =>
    mapped(
      "ThreadProviderBindingRepository.commitSwitchInCurrentTransaction",
      selectState({ threadId: input.threadId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Error("thread harness state does not exist")),
            onSome: Effect.succeed,
          }),
        ),
        Effect.flatMap((previousState) =>
          sql`
              INSERT INTO provider_native_state_generations (
                native_state_generation_id, owner_thread_id, harness_kind, adapter_schema_version,
                state_manifest_json, lifecycle, created_at
              ) VALUES (
                ${input.generation.id}, ${input.generation.ownerThreadId}, ${input.generation.harness},
                ${input.generation.adapterSchemaVersion}, ${input.generation.stateManifestJson},
                'active', ${input.generation.createdAt}
              )
            `.pipe(Effect.as(previousState)),
        ),
        Effect.flatMap((previousState) =>
          updateState({
            threadId: input.threadId,
            expectedRevision: input.expectedStateRevision,
            nativeStateGenerationId: input.generation.id,
            providerSessionId: input.providerSessionId,
            nativeStateLocatorJson: input.nativeStateLocatorJson,
            verifiedAt: input.verifiedAt,
            updatedAt: input.updatedAt,
          }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Error("thread native state revision conflict")),
                onSome: (state) => Effect.succeed({ previousState, state }),
              }),
            ),
          ),
        ),
        Effect.flatMap(({ previousState, state }) =>
          updateBinding({
            threadId: input.threadId,
            expectedRevision: input.expectedBindingRevision,
            connectionId: input.connectionId,
            installationId: input.installationId,
            internalProviderId: input.internalProviderId,
            modelId: input.modelId,
            updatedAt: input.updatedAt,
          }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Error("thread runtime binding revision conflict")),
                onSome: (binding) => Effect.succeed({ previousState, state, binding }),
              }),
            ),
          ),
        ),
        Effect.flatMap(({ previousState, state, binding }) =>
          sql`
              UPDATE provider_native_state_generations
              SET lifecycle = 'retained', retained_at = ${input.updatedAt}
              WHERE native_state_generation_id = ${previousState.nativeStateGenerationId}
                AND NOT EXISTS (
                  SELECT 1 FROM thread_harness_states
                  WHERE native_state_generation_id = ${previousState.nativeStateGenerationId}
                )
            `.pipe(Effect.as({ state, binding })),
        ),
      ),
    );
  const updateRuntimeBindingInCurrentTransaction: ThreadProviderBindingRepositoryShape["updateRuntimeBinding"] =
    (input) =>
      mapped(
        "ThreadProviderBindingRepository.updateRuntimeBindingInCurrentTransaction",
        updateBinding(input),
      );

  return {
    createNativeStateGeneration: (input) =>
      mapped(
        "ThreadProviderBindingRepository.createNativeStateGeneration",
        sql`
          INSERT INTO provider_native_state_generations (
            native_state_generation_id, owner_thread_id, harness_kind, adapter_schema_version,
            state_manifest_json, lifecycle, created_at
          ) VALUES (
            ${input.id}, ${input.ownerThreadId}, ${input.harness}, ${input.adapterSchemaVersion},
            ${input.stateManifestJson}, 'active', ${input.createdAt}
          )
        `.pipe(Effect.asVoid),
      ),
    bindThread: (input) =>
      mapped(
        "ThreadProviderBindingRepository.bindThread",
        sql.withTransaction(
          sql`
            INSERT INTO thread_harness_states (
              thread_id, harness_kind, native_state_generation_id, provider_session_id,
              native_state_locator_json, last_verified_resume_at, state_revision,
              created_at, updated_at
            ) VALUES (
              ${input.threadId}, ${input.harness}, ${input.nativeStateGenerationId},
              ${input.providerSessionId}, ${input.nativeStateLocatorJson}, NULL, 0,
              ${input.createdAt}, ${input.createdAt}
            )
          `.pipe(
            Effect.andThen(sql`
              INSERT INTO thread_runtime_bindings (
                thread_id, connection_id, installation_id, internal_provider_id,
                model_id, binding_revision, created_at, updated_at
              ) VALUES (
                ${input.threadId}, ${input.connectionId}, ${input.installationId},
                ${input.internalProviderId}, ${input.modelId}, 0,
                ${input.createdAt}, ${input.createdAt}
              )
            `),
            Effect.asVoid,
          ),
        ),
      ),
    initializeThread: (input) =>
      mapped(
        "ThreadProviderBindingRepository.initializeThread",
        sql.withTransaction(initializeThreadInCurrentTransaction(input)),
      ),
    initializeThreadInCurrentTransaction,
    getHarnessState: (threadId) =>
      mapped("ThreadProviderBindingRepository.getHarnessState", selectState({ threadId })),
    getRuntimeBinding: (threadId) =>
      mapped("ThreadProviderBindingRepository.getRuntimeBinding", selectBinding({ threadId })),
    replaceNativeState: (input) =>
      mapped("ThreadProviderBindingRepository.replaceNativeState", updateState(input)),
    updateRuntimeBinding: updateRuntimeBindingInCurrentTransaction,
    updateRuntimeBindingInCurrentTransaction,
    commitSwitch: (input) =>
      mapped(
        "ThreadProviderBindingRepository.commitSwitch",
        sql.withTransaction(commitSwitchInCurrentTransaction(input)),
      ),
    commitSwitchInCurrentTransaction,
  } satisfies ThreadProviderBindingRepositoryShape;
});

export const ThreadProviderBindingRepositoryLive = Layer.effect(
  ThreadProviderBindingRepository,
  makeThreadProviderBindingRepository,
);
