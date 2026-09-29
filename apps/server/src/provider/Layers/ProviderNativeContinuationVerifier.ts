// FILE: ProviderNativeContinuationVerifier.ts
// Purpose: Clone, launch, and silently verify exact native provider continuation.

import { Effect, Layer, Option } from "effect";
import { startDiagnosticTrace } from "@penkra/shared/traceContext";

import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { ThreadDiagnosticsQuery } from "../../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import {
  recordDiagnosticCheckpoint,
  recordDiagnosticIncident,
} from "../../diagnostics/recorder.ts";
import { providerNativeResumeIdentity } from "../nativeResumeIdentity.ts";
import { selectNativeResumeProbeModel } from "../nativeResumeProbeModel.ts";
import { readClaudeSessionMarker } from "../claudeThreadNativeState.ts";
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

const describeCauseChain = (cause: unknown): string => {
  const entries: Array<{ readonly type: string; readonly message: string }> = [];
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current !== undefined && current !== null && entries.length < 8 && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      entries.push({ type: current.name, message: current.message });
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as {
        readonly _tag?: unknown;
        readonly cause?: unknown;
        readonly message?: unknown;
      };
      entries.push({
        type: typeof record._tag === "string" ? record._tag : "Object",
        message: typeof record.message === "string" ? record.message : String(current),
      });
      current = record.cause;
      continue;
    }
    entries.push({ type: typeof current, message: String(current) });
    break;
  }
  return JSON.stringify(entries);
};

export const makeProviderNativeContinuationVerifier = Effect.gen(function* () {
  const adapters = yield* ProviderAdapterRegistry;
  const launches = yield* ProviderLaunchResolver;
  const materializer = yield* ProviderNativeStateMaterializer;
  const threads = yield* ThreadProviderBindingRepository;
  const diagnostics = yield* ThreadDiagnosticsQuery;

  const recordDiagnostic = (input: {
    readonly threadId: string;
    readonly code: string;
    readonly severity: "info" | "error";
    readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  }) =>
    diagnostics
      .recordOperationalDiagnostic({
        threadId: input.threadId,
        source: "server",
        kind: "provider.native-continuation-verification",
        severity: input.severity,
        code: input.code,
        detail: input.detail,
        occurredAt: new Date().toISOString(),
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("could not persist native continuation verification diagnostic", {
            threadId: input.threadId,
            code: input.code,
            cause: cause.message,
          }),
        ),
        Effect.asVoid,
      );

  const verifySwitch: ProviderNativeContinuationVerifierShape["verifySwitch"] = (input) => {
    const startedAt = Date.now();
    const diagnosticTrace = startDiagnosticTrace();
    const recordNewDiagnostic = (code: "started" | "succeeded" | "failed") =>
      Effect.sync(() => {
        const step =
          code === "started"
            ? "provider.continuation_verification_started"
            : code === "succeeded"
              ? "provider.continuation_verification_succeeded"
              : "provider.continuation_verification_failed";
        const fields = {
          provider: input.selection.harness,
          verificationStage: stage,
          elapsedMs: Date.now() - startedAt,
        };
        recordDiagnosticCheckpoint({
          ...diagnosticTrace,
          threadId: input.selection.threadId,
          flow: "provider_delivery",
          step,
          ...(step === "provider.continuation_verification_failed"
            ? { outcome: "failed" as const }
            : {}),
          fields,
        });
        if (step === "provider.continuation_verification_failed")
          recordDiagnosticIncident({
            ...diagnosticTrace,
            threadId: input.selection.threadId,
            kind: "command.failed",
            code: "APP_OPERATION_FAILED",
            where: "server.provider",
            severity: "error",
            expected: { accepted: true },
            actual: { accepted: false },
            context: fields,
            lastCheckpoint: step,
          });
      });
    let stage = "validate-selection";
    const commonDetail = {
      provider: input.selection.harness,
      sourceInstallationId: input.selection.previousInstallationId,
      targetInstallationId: input.selection.installationId,
      sourceStorage: input.sourceStorage,
      targetGenerationId: input.targetGenerationId,
      modelId: input.selection.modelId,
    } as const;
    const verification = Effect.gen(function* () {
      yield* recordDiagnostic({
        threadId: input.selection.threadId,
        code: "NATIVE_CONTINUATION_VERIFICATION_STARTED",
        severity: "info",
        detail: { ...commonDetail, stage },
      });
      yield* recordNewDiagnostic("started");
      if (!input.selection.changed) {
        return yield* fail("Native continuation verification requires an actual selection change.");
      }
      stage = "read-source-state";
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

      stage = "decode-source-state";
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

      stage = "clone-native-state";
      const targetRoot = yield* materializer
        .clone({
          harness: input.selection.harness,
          providerSessionId: sourceIdentity,
          sourceStorage: input.sourceStorage,
          sourceConnectionId: input.selection.previousConnectionId,
          targetConnectionId: input.selection.connectionId,
          sourceGenerationId: state.value.nativeStateGenerationId,
          targetGenerationId: input.targetGenerationId,
          sourceThreadId: input.selection.threadId,
          targetThreadId: input.selection.threadId,
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

      if (input.selection.harness === "claudeAgent") {
        stage = "read-clone-marker";
        const marker = yield* Effect.tryPromise({
          try: () => readClaudeSessionMarker(targetRoot),
          catch: (cause) =>
            new ProviderNativeContinuationVerificationError({
              detail: "Could not read the cloned Claude session marker.",
              cause,
            }),
        });
        // The Thread-owned JSONL is gone; the switch can still rebuild from
        // Penkra's transcript, so never fail the switch on a missing file.
        if (marker?.requiresReconstruction === true) {
          return {
            kind: "reconstructed" as const,
            generationId: input.targetGenerationId,
            adapterSchemaVersion: "penkra-reconstructed-continuation-v1",
            stateManifestJson: JSON.stringify({
              format: "penkra-reconstructed-continuation-v1",
              reason: "The exact Thread-owned Claude session is unavailable.",
            }),
            providerSessionId: null,
            nativeStateLocatorJson: '{"penkraReconstruction":true}',
            verifiedAt: new Date().toISOString(),
          };
        }
      }

      const result = yield* Effect.gen(function* () {
        stage = "resolve-target-launch";
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
        stage = "resolve-target-adapter";
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
        const requiresCompletedProbe = input.selection.claudeAccountTransition !== undefined;
        let verificationModelId = input.selection.modelId;
        if (requiresCompletedProbe) {
          if (adapter.listModels === undefined) {
            return yield* fail("The target provider cannot list models for the resume probe.");
          }
          stage = "select-target-probe-model";
          const catalog = yield* adapter
            .listModels({
              provider: input.selection.harness,
              connectionId: input.selection.connectionId,
              internalProviderId: input.selection.internalProviderId,
              managedLaunch: {
                binaryPath: launch.binaryPath,
                isolationKey: launch.isolationKey,
                profileRoot: launch.profileRoot,
                nativeStateRoot: launch.nativeStateRoot,
                childEnvironment: (baseEnv) => launch.childEnvironment(baseEnv),
              },
              ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderNativeContinuationVerificationError({
                    detail: "Could not list the target account's resume probe models.",
                    cause,
                  }),
              ),
            );
          const probeModelId = selectNativeResumeProbeModel({
            provider: input.selection.harness,
            connectionId: input.selection.connectionId,
            models: catalog.models,
            selectedModelId: input.selection.modelId,
          });
          if (probeModelId === null) {
            return yield* fail(
              "The target account has no available model for resume verification.",
            );
          }
          verificationModelId = probeModelId;
        }
        stage = "initialize-target-resume";
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
              model: verificationModelId,
            },
            runtimeMode: input.runtimeMode,
            requireCompletedProbe: requiresCompletedProbe,
          })
          .pipe(
            Effect.catch((cause) =>
              input.selection.harness === "claudeAgent" &&
              /no conversation found with session id/i.test(describeCauseChain(cause))
                ? Effect.succeed(null)
                : Effect.fail(
                    new ProviderNativeContinuationVerificationError({
                      detail: "The target provider rejected native continuation.",
                      cause,
                    }),
                  ),
            ),
          );
        if (verified === null) {
          return {
            kind: "reconstructed" as const,
            generationId: input.targetGenerationId,
            adapterSchemaVersion: "penkra-reconstructed-continuation-v1",
            stateManifestJson: JSON.stringify({
              format: "penkra-reconstructed-continuation-v1",
              reason: "The target Claude account could not resume the exact conversation.",
            }),
            providerSessionId: null,
            nativeStateLocatorJson: '{"penkraReconstruction":true}',
            verifiedAt: new Date().toISOString(),
          };
        }
        stage = "validate-resumed-identity";
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

    return verification.pipe(
      Effect.tap(() => {
        stage = "completed";
        return Effect.all(
          [
            recordDiagnostic({
              threadId: input.selection.threadId,
              code: "NATIVE_CONTINUATION_VERIFICATION_SUCCEEDED",
              severity: "info",
              detail: { ...commonDetail, stage: "completed", elapsedMs: Date.now() - startedAt },
            }),
            recordNewDiagnostic("succeeded"),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }),
      Effect.tapError((cause) => {
        const failureDetail = {
          ...commonDetail,
          stage,
          elapsedMs: Date.now() - startedAt,
          errorType: cause._tag,
          errorMessage: cause.message,
          causeChain: describeCauseChain(cause),
        } as const;
        return Effect.all(
          [
            recordDiagnostic({
              threadId: input.selection.threadId,
              code: "NATIVE_CONTINUATION_VERIFICATION_FAILED",
              severity: "error",
              detail: failureDetail,
            }),
            recordNewDiagnostic("failed"),
            Effect.logWarning("native continuation verification failed", {
              threadId: input.selection.threadId,
              ...failureDetail,
            }),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }),
    );
  };

  return { verifySwitch } satisfies ProviderNativeContinuationVerifierShape;
});

export const ProviderNativeContinuationVerifierLive = Layer.effect(
  ProviderNativeContinuationVerifier,
  makeProviderNativeContinuationVerifier,
);
