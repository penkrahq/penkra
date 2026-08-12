// FILE: ProviderNativeContinuationVerifier.ts
// Purpose: Clone, launch, and silently verify exact native provider continuation.

import { Effect, Layer, Option } from "effect";

import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { providerNativeResumeIdentity } from "../nativeResumeIdentity.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { ProviderNativeStateMaterializer } from "../Services/ProviderNativeStateMaterializer.ts";
import {
  ProviderNativeContinuationVerificationError,
  ProviderNativeContinuationVerifier,
  type ProviderNativeContinuationVerifierShape,
} from "../Services/ProviderNativeContinuationVerifier.ts";

const fail = (detail: string, cause?: unknown) =>
  Effect.fail(
    new ProviderNativeContinuationVerificationError({
      detail,
      ...(cause === undefined ? {} : { cause }),
    }),
  );

export const makeProviderNativeContinuationVerifier = Effect.gen(function* () {
  const adapters = yield* ProviderAdapterRegistry;
  const launches = yield* ProviderLaunchResolver;
  const materializer = yield* ProviderNativeStateMaterializer;
  const threads = yield* ThreadProviderBindingRepository;

  const verifySwitch: ProviderNativeContinuationVerifierShape["verifySwitch"] = (input) =>
    Effect.gen(function* () {
      if (!input.selection.changed) {
        return yield* fail("Native continuation verification requires an actual selection change.");
      }
      const state = yield* threads.getHarnessState(input.selection.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderNativeContinuationVerificationError({
              detail: "Could not read the source native state.",
              cause,
            }),
        ),
      );
      if (
        Option.isNone(state) ||
        state.value.revision !== input.selection.stateRevision ||
        state.value.harness !== input.selection.harness
      ) {
        return yield* fail("The source native state changed before verification.");
      }

      const sourceCursor = yield* Effect.try({
        try: () => JSON.parse(state.value.nativeStateLocatorJson) as unknown,
        catch: (cause) =>
          new ProviderNativeContinuationVerificationError({
            detail: "The source native-state locator is invalid.",
            cause,
          }),
      });
      const sourceIdentity = providerNativeResumeIdentity(input.selection.harness, sourceCursor);
      if (
        sourceIdentity === null ||
        (state.value.providerSessionId !== null && state.value.providerSessionId !== sourceIdentity)
      ) {
        return yield* fail("The source native-state identity is not exact.");
      }

      yield* materializer
        .clone({
          harness: input.selection.harness,
          providerSessionId: sourceIdentity,
          sourceStorage: input.sourceStorage,
          sourceConnectionId: input.selection.previousConnectionId,
          targetConnectionId: input.selection.connectionId,
          sourceGenerationId: state.value.nativeStateGenerationId,
          targetGenerationId: input.targetGenerationId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderNativeContinuationVerificationError({
                detail: "Could not clone the source native state.",
                cause,
              }),
          ),
        );

      const result = yield* Effect.gen(function* () {
        const launch = yield* launches
          .resolve({
            threadId: input.selection.threadId,
            connectionId: input.selection.connectionId,
            installationId: input.selection.installationId,
            internalProviderId: input.selection.internalProviderId,
            nativeStateGenerationId: input.targetGenerationId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderNativeContinuationVerificationError({
                  detail: "Could not resolve the target managed launch.",
                  cause,
                }),
            ),
          );
        const adapter = yield* adapters.getByProvider(input.selection.harness).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderNativeContinuationVerificationError({
                detail: "The target provider adapter is unavailable.",
                cause,
              }),
          ),
        );
        if (adapter.verifyNativeResume === undefined) {
          return yield* fail("The target provider adapter cannot verify native continuation.");
        }
        const verified = yield* adapter
          .verifyNativeResume({
            sourceResumeCursor: sourceCursor,
            managedLaunch: {
              binaryPath: launch.binaryPath,
              isolationKey: launch.isolationKey,
              profileRoot: launch.profileRoot,
              nativeStateRoot: launch.nativeStateRoot,
              childEnvironment: (baseEnv) => launch.childEnvironment(baseEnv),
            },
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            modelSelection: {
              provider: input.selection.harness,
              model: input.selection.modelId,
            },
            runtimeMode: input.runtimeMode,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderNativeContinuationVerificationError({
                  detail: "The target provider rejected native continuation.",
                  cause,
                }),
            ),
          );
        const verifiedIdentity = providerNativeResumeIdentity(
          input.selection.harness,
          verified.resumeCursor,
        );
        if (
          verifiedIdentity === null ||
          verifiedIdentity !== sourceIdentity ||
          verified.providerSessionId !== sourceIdentity
        ) {
          return yield* fail("The target provider resumed a different native session.");
        }
        const verifiedAt = new Date().toISOString();
        return {
          generationId: input.targetGenerationId,
          adapterSchemaVersion: "managed-native-state-v1",
          stateManifestJson: JSON.stringify({
            format: "managed-native-state-v1",
            sourceGenerationId: state.value.nativeStateGenerationId,
          }),
          providerSessionId: verifiedIdentity,
          nativeStateLocatorJson: JSON.stringify(verified.resumeCursor),
          verifiedAt,
        };
      }).pipe(
        Effect.onError(() => materializer.discard(input.targetGenerationId).pipe(Effect.ignore)),
      );

      return result;
    });

  return { verifySwitch } satisfies ProviderNativeContinuationVerifierShape;
});

export const ProviderNativeContinuationVerifierLive = Layer.effect(
  ProviderNativeContinuationVerifier,
  makeProviderNativeContinuationVerifier,
);
