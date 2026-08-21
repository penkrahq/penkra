// FILE: ProviderThreadSwitchCoordinator.ts
// Purpose: Crash-recoverable interrupt, verify, and atomic switch admission saga.

import {
  OrchestrationCommand,
  ProviderNativeStateGenerationId,
  ThreadId,
  type RuntimeMode,
} from "@penkra/contracts";
import { Effect, Layer, Option, Result, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
  type ManagedAttachmentPrincipal,
} from "../../managedAttachmentPrincipal.ts";
import { ProviderThreadSwitchOperationRepository } from "../../persistence/Services/ProviderThreadSwitchOperations.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import {
  ProviderNativeForkOperationRepository,
  type ProviderNativeForkOperationState,
} from "../../persistence/Services/ProviderNativeForkOperations.ts";
import { providerNativeResumeIdentity } from "../../provider/nativeResumeIdentity.ts";
import {
  confirmManagedProviderRuntimeCompatibility,
  readManagedProviderRuntimeActivation,
  rejectManagedProviderRuntimeUpdate,
} from "../../provider/managedProviderRuntime.ts";
import type { ProviderManagedLaunchContext } from "../../provider/Services/ProviderAdapter.ts";
import { ProviderLaunchResolver } from "../../provider/Services/ProviderLaunchResolver.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  ProviderNativeContinuationVerifier,
  VerifiedProviderNativeContinuation,
} from "../../provider/Services/ProviderNativeContinuationVerifier.ts";
import { ProviderNativeStateMaterializer } from "../../provider/Services/ProviderNativeStateMaterializer.ts";
import {
  ResolvedProviderTurnSelection,
  ProviderTurnSelectionResolver,
} from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { fingerprintOrchestrationCommand } from "../commandFingerprint.ts";
import {
  ProviderThreadSwitchCoordinator,
  ProviderThreadSwitchCoordinatorError,
  type ProviderThreadSwitchCoordinatorShape,
} from "../Services/ProviderThreadSwitchCoordinator.ts";

const fail = (detail: string, cause?: unknown) =>
  Effect.fail(
    new ProviderThreadSwitchCoordinatorError({
      detail,
      ...(cause === undefined ? {} : { cause }),
    }),
  );

const mapOperationError = (detail: string) =>
  Effect.mapError((cause: unknown) => new ProviderThreadSwitchCoordinatorError({ detail, cause }));

const operationIdFor = (commandId: string) => `provider-switch:${commandId}`;
const forkOperationIdFor = (commandId: string) => `provider-fork:${commandId}`;
const generationIdFor = (commandId: string) =>
  ProviderNativeStateGenerationId.makeUnsafe(`provider-switch-generation:${commandId}`);
const anonymousConnectionLabel = (harness: string) =>
  harness === "opencode" ? "OpenCode" : "No Connection";
const RUNTIME_COMPATIBILITY_FAILURE_PREFIX = "managed-runtime-continuation-incompatible:";

class ManagedRuntimeContinuationCompatibilityError extends Error {}

const isInstallationOnlyRuntimeUpgrade = (selection: typeof ResolvedProviderTurnSelection.Type) =>
  selection.previousInstallationId !== null &&
  selection.previousInstallationId !== selection.installationId &&
  selection.previousConnectionId === selection.connectionId &&
  selection.previousModelId === selection.modelId;

export const makeProviderThreadSwitchCoordinator = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const operations = yield* ProviderThreadSwitchOperationRepository;
  const installations = yield* ProviderInstallationRepository;
  const forkOperations = yield* ProviderNativeForkOperationRepository;
  const threadBindings = yield* ThreadProviderBindingRepository;
  const provider = yield* ProviderService;
  const projections = yield* ProjectionSnapshotQuery;
  const launches = yield* ProviderLaunchResolver;
  const resolver = yield* ProviderTurnSelectionResolver;
  const verifier = yield* ProviderNativeContinuationVerifier;
  const materializer = yield* ProviderNativeStateMaterializer;
  const config = yield* ServerConfig;

  const confirmRuntimeUpgrade = (selection: typeof ResolvedProviderTurnSelection.Type) =>
    isInstallationOnlyRuntimeUpgrade(selection) && selection.requiresNativeStateMaterialization
      ? confirmManagedProviderRuntimeCompatibility({
          stateDir: config.stateDir,
          provider: selection.harness,
          installationId: selection.installationId,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("could not prune proven provider runtime predecessor", {
              provider: selection.harness,
              installationId: selection.installationId,
              cause: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
          Effect.asVoid,
        )
      : Effect.void;

  const decodeCommand = (json: string) =>
    Effect.try({
      try: () => JSON.parse(json) as unknown,
      catch: (cause) =>
        new ProviderThreadSwitchCoordinatorError({
          detail: "The persisted provider-switch command is invalid JSON.",
          cause,
        }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OrchestrationCommand)),
      Effect.mapError(
        (cause) =>
          new ProviderThreadSwitchCoordinatorError({
            detail: "The persisted provider-switch command is invalid.",
            cause,
          }),
      ),
      Effect.flatMap((command) =>
        command.type === "thread.turn.start"
          ? Effect.succeed(command)
          : fail("The persisted provider-switch command is not a turn start."),
      ),
    );

  const decodeSelection = (json: string) =>
    Effect.try({
      try: () => JSON.parse(json) as unknown,
      catch: (cause) =>
        new ProviderThreadSwitchCoordinatorError({
          detail: "The persisted provider-switch selection is invalid JSON.",
          cause,
        }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ResolvedProviderTurnSelection)),
      Effect.mapError(
        (cause) =>
          new ProviderThreadSwitchCoordinatorError({
            detail: "The persisted provider-switch selection is invalid.",
            cause,
          }),
      ),
    );

  const decodeVerification = (json: string) =>
    Effect.try({
      try: () => JSON.parse(json) as unknown,
      catch: (cause) =>
        new ProviderThreadSwitchCoordinatorError({
          detail: "The provider-switch verification evidence is invalid JSON.",
          cause,
        }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(VerifiedProviderNativeContinuation)),
      Effect.mapError(
        (cause) =>
          new ProviderThreadSwitchCoordinatorError({
            detail: "The provider-switch verification evidence is invalid.",
            cause,
          }),
      ),
    );

  const waitForTurnToSettle = (
    threadId: string,
    deadlineAt: number | null,
  ): Effect.Effect<void, ProviderThreadSwitchCoordinatorError> =>
    Effect.all([
      provider
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId))),
      projections.getThreadShellById(ThreadId.makeUnsafe(threadId)),
    ]).pipe(
      Effect.flatMap(([session, projectedThread]) => {
        const runtimeRunning = session?.status === "running" && session.activeTurnId !== undefined;
        const projectedSession = Option.getOrUndefined(projectedThread)?.session;
        const projectionRunning =
          projectedSession?.status === "running" && projectedSession.activeTurnId !== null;
        if (!runtimeRunning && !projectionRunning) {
          return Effect.void;
        }
        if (deadlineAt !== null && Date.now() >= deadlineAt) {
          return fail(
            "The active provider turn and its durable projection did not settle after interruption.",
          );
        }
        return Effect.sleep("50 millis").pipe(
          Effect.andThen(waitForTurnToSettle(threadId, deadlineAt)),
        );
      }),
      Effect.mapError((cause) =>
        cause instanceof ProviderThreadSwitchCoordinatorError
          ? cause
          : new ProviderThreadSwitchCoordinatorError({
              detail: "Could not observe exact provider turn settlement.",
              cause,
            }),
      ),
    );

  const interruptIfRunning = Effect.fnUntraced(function* (threadId: string) {
    const session = (yield* provider.listSessions().pipe(
      Effect.mapError(
        (cause) =>
          new ProviderThreadSwitchCoordinatorError({
            detail: "Could not inspect the active provider turn before switching.",
            cause,
          }),
      ),
    )).find((entry) => entry.threadId === threadId);
    if (session?.status === "running" && session.activeTurnId !== undefined) {
      yield* provider
        .interruptTurn({
          threadId: session.threadId,
          turnId: session.activeTurnId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderThreadSwitchCoordinatorError({
                detail: "Could not interrupt the active provider turn before switching.",
                cause,
              }),
          ),
        );
    }
    // A provider process may disappear before its terminal runtime event reaches
    // the durable projection. A switch must still wait for both views to settle;
    // cloning native state while either one says the turn is live is not exact.
    yield* waitForTurnToSettle(threadId, Date.now() + 30_000);
  });

  const waitForQueuedTurnSlot = (threadId: string) =>
    // Queue means exactly that: preserve the active turn and wait without an
    // arbitrary timeout. The durable switch journal already exists before this
    // wait, so restart recovery resumes the same requested message and route.
    waitForTurnToSettle(threadId, null);

  const runOperation = Effect.fnUntraced(function* (input: {
    readonly command: Extract<typeof OrchestrationCommand.Type, { type: "thread.turn.start" }>;
    readonly attachmentPrincipal: ManagedAttachmentPrincipal;
    readonly cwd?: string;
    readonly selection: typeof ResolvedProviderTurnSelection.Type;
    readonly operationId: string;
    readonly targetGenerationId: typeof ProviderNativeStateGenerationId.Type | null;
    readonly startingState: "pending" | "interrupted" | "verified" | "committed";
    readonly verificationJson: string | null;
  }) {
    let state = input.startingState;
    let selection = input.selection;
    let verificationJson = input.verificationJson;
    if (state === "pending") {
      if (input.command.dispatchMode === "steer") {
        yield* interruptIfRunning(input.command.threadId);
      } else {
        yield* waitForQueuedTurnSlot(input.command.threadId);
      }

      // The turn being stopped or awaited may persist a newer exact native
      // cursor as it settles. Resolve the requested target again against that
      // settled source, then atomically pin the journal to those revisions.
      // The command still supplies the immutable requested Connection/model;
      // this does not infer or reconstruct provider state.
      selection = yield* resolver
        .resolveExisting({
          threadId: input.command.threadId,
          ...(input.command.modelSelection === undefined
            ? {}
            : { modelSelection: input.command.modelSelection }),
          ...(input.command.connectionId === undefined
            ? {}
            : { connectionId: input.command.connectionId }),
          bindingRevision: input.selection.bindingRevision,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderThreadSwitchCoordinatorError({
                detail: cause.message,
                cause,
              }),
          ),
        );
      if (!selection.changed) {
        return yield* fail(
          "The requested provider switch was no longer a change after settlement.",
        );
      }
      if (selection.requiresNativeStateMaterialization !== (input.targetGenerationId !== null)) {
        return yield* fail("The requested provider switch kind changed after settlement.");
      }
      yield* operations
        .markInterruptedWithSettledSelection({
          id: input.operationId,
          sourceStateRevision: selection.stateRevision,
          sourceBindingRevision: selection.bindingRevision,
          selectionJson: JSON.stringify(selection),
          updatedAt: new Date().toISOString(),
        })
        .pipe(
          mapOperationError("Could not persist the settled provider-switch source."),
          Effect.flatMap(
            Option.match({
              onNone: () => fail("The pending provider-switch journal was not found."),
              onSome: () => Effect.void,
            }),
          ),
        );
      state = "interrupted";
    }

    const internalCommand = {
      ...input.command,
      bindingRevision: selection.bindingRevision + 1,
    };
    if (input.startingState === "committed") {
      const result = yield* engine
        .dispatch(internalCommand, {
          attachmentPrincipal: input.attachmentPrincipal,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderThreadSwitchCoordinatorError({
                detail: cause.message,
                cause,
              }),
          ),
        );
      if (selection.requiresNativeStateMaterialization) {
        if (input.targetGenerationId === null) {
          return yield* fail("The native provider switch has no target state generation.");
        }
        yield* materializer
          .finalize(input.targetGenerationId)
          .pipe(mapOperationError("Could not finalize the committed provider-switch state."));
      }
      yield* confirmRuntimeUpgrade(selection);
      return result;
    }

    if (state === "interrupted") {
      if (selection.requiresNativeStateMaterialization) {
        if (input.targetGenerationId === null) {
          return yield* fail("The native provider switch has no target state generation.");
        }
        const verified = yield* verifier
          .verifySwitch({
            selection,
            sourceStorage: "connection-profile",
            targetGenerationId: input.targetGenerationId,
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            runtimeMode: (input.command.runtimeMode ?? "full-access") as RuntimeMode,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderThreadSwitchCoordinatorError({
                  detail: cause.message,
                  cause: isInstallationOnlyRuntimeUpgrade(selection)
                    ? new ManagedRuntimeContinuationCompatibilityError(cause.message, {
                        cause,
                      })
                    : cause,
                }),
            ),
          );
        verificationJson = JSON.stringify(verified);
      }
      yield* operations
        .transition({
          id: input.operationId,
          state: "verified",
          verificationJson,
          failureReason: null,
          updatedAt: new Date().toISOString(),
        })
        .pipe(mapOperationError("Could not persist the verified provider-switch state."));
      state = "verified";
    }
    if (state !== "verified") {
      return yield* fail("The provider-switch verification evidence is missing.");
    }
    const verified =
      selection.requiresNativeStateMaterialization && verificationJson !== null
        ? yield* decodeVerification(verificationJson)
        : null;
    if (selection.requiresNativeStateMaterialization && verified === null) {
      return yield* fail("The provider-switch verification evidence is missing.");
    }
    const result = yield* engine
      .dispatch(internalCommand, {
        attachmentPrincipal: input.attachmentPrincipal,
        acceptedProviderSwitch: {
          operationId: input.operationId,
          change: {
            previousConnectionId: selection.previousConnectionId,
            connectionId: selection.connectionId,
            label: selection.connectionLabel ?? anonymousConnectionLabel(selection.harness),
            previousModelId: selection.previousModelId,
            modelId: selection.modelId,
            modelLabel: selection.modelLabel,
          },
          commit:
            verified === null
              ? {
                  kind: "runtime-binding" as const,
                  input: {
                    threadId: input.command.threadId,
                    expectedRevision: selection.bindingRevision,
                    connectionId: selection.connectionId,
                    installationId: selection.installationId,
                    internalProviderId: selection.internalProviderId,
                    modelId: selection.modelId,
                    updatedAt: new Date().toISOString(),
                  },
                }
              : {
                  kind: "native-state" as const,
                  input: {
                    threadId: input.command.threadId,
                    expectedStateRevision: selection.stateRevision,
                    expectedBindingRevision: selection.bindingRevision,
                    generation: {
                      id: verified.generationId,
                      ownerThreadId: input.command.threadId,
                      harness: selection.harness,
                      adapterSchemaVersion: verified.adapterSchemaVersion,
                      stateManifestJson: verified.stateManifestJson,
                      createdAt: verified.verifiedAt,
                    },
                    providerSessionId: verified.providerSessionId,
                    nativeStateLocatorJson: verified.nativeStateLocatorJson,
                    verifiedAt: verified.verifiedAt,
                    connectionId: selection.connectionId,
                    installationId: selection.installationId,
                    internalProviderId: selection.internalProviderId,
                    modelId: selection.modelId,
                    updatedAt: new Date().toISOString(),
                  },
                },
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderThreadSwitchCoordinatorError({
              detail: cause.message,
              cause,
            }),
        ),
      );
    if (selection.requiresNativeStateMaterialization) {
      if (input.targetGenerationId === null) {
        return yield* fail("The native provider switch has no target state generation.");
      }
      yield* materializer
        .finalize(input.targetGenerationId)
        .pipe(mapOperationError("Could not finalize the committed provider-switch state."));
    }
    yield* confirmRuntimeUpgrade(selection);
    return result;
  });

  const dispatchRuntimeUpgradeFallback = Effect.fnUntraced(function* (
    input: Parameters<typeof runOperation>[0],
  ) {
    const selection = input.selection;
    if (!isInstallationOnlyRuntimeUpgrade(selection)) {
      return yield* fail("The failed provider switch was not a runtime-only upgrade.");
    }
    const predecessorId = selection.previousInstallationId;
    if (predecessorId === null) {
      return yield* fail("The failed provider runtime upgrade has no predecessor.");
    }
    const binding = yield* threadBindings
      .getRuntimeBinding(input.command.threadId)
      .pipe(mapOperationError("Could not read the provider fallback binding."));
    if (
      Option.isNone(binding) ||
      binding.value.installationId !== predecessorId ||
      binding.value.revision !== selection.bindingRevision
    ) {
      return yield* fail("The provider binding changed before runtime fallback.");
    }

    const activation = yield* readManagedProviderRuntimeActivation({
      stateDir: config.stateDir,
      provider: selection.harness,
    }).pipe(mapOperationError("Could not inspect the provider runtime fallback."));
    const now = new Date().toISOString();
    if (activation?.active.installationId === selection.installationId) {
      yield* installations
        .reactivate(predecessorId, now)
        .pipe(mapOperationError("Could not reactivate the provider runtime predecessor."));
      const rejected = yield* rejectManagedProviderRuntimeUpdate({
        stateDir: config.stateDir,
        provider: selection.harness,
        installationId: selection.installationId,
        rejectedAt: now,
      }).pipe(
        Effect.catch((cause) =>
          installations
            .reactivate(selection.installationId, now)
            .pipe(
              Effect.ignore,
              Effect.andThen(
                fail("Could not reject the incompatible provider runtime update.", cause),
              ),
            ),
        ),
      );
      if (!rejected) {
        yield* installations.reactivate(selection.installationId, now).pipe(Effect.ignore);
        return yield* fail("The incompatible provider runtime update could not be rolled back.");
      }
    } else if (activation?.active.installationId === predecessorId) {
      yield* installations
        .reactivate(predecessorId, now)
        .pipe(mapOperationError("Could not restore the provider runtime predecessor."));
    } else {
      return yield* fail("The provider runtime activation changed before fallback.");
    }

    yield* Effect.logWarning("rejected incompatible managed provider runtime", {
      provider: selection.harness,
      rejectedInstallationId: selection.installationId,
      restoredInstallationId: predecessorId,
      threadId: input.command.threadId,
    });
    return yield* engine
      .dispatch(
        {
          ...input.command,
          connectionId: binding.value.connectionId,
          bindingRevision: binding.value.revision,
        },
        { attachmentPrincipal: input.attachmentPrincipal },
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderThreadSwitchCoordinatorError({
              detail: cause.message,
              cause,
            }),
        ),
      );
  });

  const runClientOperation = (input: Parameters<typeof runOperation>[0]) =>
    runOperation(input).pipe(
      Effect.catch((cause) =>
        operations.get(input.operationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(cause),
              onSome: (current) => {
                if (current.state === "committed") {
                  return runOperation({ ...input, startingState: "committed" });
                }
                if (current.state === "failed") {
                  return current.failureReason?.startsWith(RUNTIME_COMPATIBILITY_FAILURE_PREFIX)
                    ? dispatchRuntimeUpgradeFallback(input)
                    : Effect.fail(cause);
                }
                const compatibilityFailure =
                  cause.cause instanceof ManagedRuntimeContinuationCompatibilityError;
                return operations
                  .transition({
                    id: input.operationId,
                    state: "failed",
                    failureReason: compatibilityFailure
                      ? `${RUNTIME_COMPATIBILITY_FAILURE_PREFIX}${cause.message}`
                      : cause.message,
                    updatedAt: new Date().toISOString(),
                  })
                  .pipe(
                    Effect.ignore,
                    Effect.andThen(
                      input.selection.requiresNativeStateMaterialization &&
                        input.targetGenerationId !== null
                        ? materializer.discard(input.targetGenerationId)
                        : Effect.void,
                    ),
                    Effect.ignore,
                    Effect.andThen(
                      compatibilityFailure
                        ? dispatchRuntimeUpgradeFallback(input)
                        : Effect.fail(cause),
                    ),
                  );
              },
            }),
          ),
          // If the journal cannot be read, retain the cloned generation. The
          // transaction may already have committed and deleting it would make
          // the accepted binding unusable.
          Effect.catch(() => Effect.fail(cause)),
        ),
      ),
    );

  const runForkOperation = Effect.fnUntraced(function* (input: {
    readonly command: Extract<typeof OrchestrationCommand.Type, { type: "thread.turn.start" }>;
    readonly attachmentPrincipal: ManagedAttachmentPrincipal;
    readonly selection: typeof ResolvedProviderTurnSelection.Type;
    readonly sourceThreadId: ThreadId;
    readonly sourceStateRevision: number;
    readonly sourceBindingRevision: number;
    readonly targetGenerationId: typeof ProviderNativeStateGenerationId.Type;
    readonly operationId: string;
    readonly startingState: ProviderNativeForkOperationState;
    readonly forkResultJson: string | null;
    readonly cwd?: string;
  }) {
    let state = input.startingState;
    let forkResultJson = input.forkResultJson;
    const readExactSource = Effect.gen(function* () {
      const sourceState = yield* threadBindings
        .getHarnessState(input.sourceThreadId)
        .pipe(mapOperationError("Could not read the native fork source state."));
      const sourceBinding = yield* threadBindings
        .getRuntimeBinding(input.sourceThreadId)
        .pipe(mapOperationError("Could not read the native fork source binding."));
      if (
        Option.isNone(sourceState) ||
        Option.isNone(sourceBinding) ||
        sourceState.value.revision !== input.sourceStateRevision ||
        sourceBinding.value.revision !== input.sourceBindingRevision
      ) {
        return yield* fail("The native fork source changed before the fork committed.");
      }
      const sourceCursor = yield* Effect.try({
        try: () => JSON.parse(sourceState.value.nativeStateLocatorJson) as unknown,
        catch: (cause) =>
          new ProviderThreadSwitchCoordinatorError({
            detail: "The native fork source cursor is invalid.",
            cause,
          }),
      });
      const sourceIdentity = providerNativeResumeIdentity(sourceState.value.harness, sourceCursor);
      if (
        sourceState.value.harness !== input.selection.harness ||
        sourceIdentity === null ||
        sourceState.value.providerSessionId !== sourceIdentity
      ) {
        return yield* fail("The native fork source identity is not exact.");
      }
      return {
        sourceState: sourceState.value,
        sourceBinding: sourceBinding.value,
        sourceCursor,
        sourceIdentity,
      };
    });

    if (state === "pending") {
      const source = yield* readExactSource;
      yield* materializer.discard(input.targetGenerationId).pipe(
        Effect.andThen(
          materializer.clone({
            harness: input.selection.harness,
            providerSessionId: source.sourceIdentity,
            sourceStorage: "connection-profile",
            sourceConnectionId: source.sourceBinding.connectionId,
            targetConnectionId: input.selection.connectionId,
            sourceGenerationId: source.sourceState.nativeStateGenerationId,
            targetGenerationId: input.targetGenerationId,
          }),
        ),
        mapOperationError("Could not materialize the native fork source generation."),
      );
      yield* forkOperations
        .transition({
          id: input.operationId,
          state: "materialized",
          failureReason: null,
          updatedAt: new Date().toISOString(),
        })
        .pipe(mapOperationError("Could not persist the materialized native fork state."));
      state = "materialized";
    }
    if (state === "materialized") {
      const source = yield* readExactSource;
      const launch = yield* launches
        .resolveProfile({
          harness: input.selection.harness,
          connectionId: input.selection.connectionId,
          installationId: input.selection.installationId,
          internalProviderId: input.selection.internalProviderId,
          nativeStateIdentity: input.targetGenerationId,
        })
        .pipe(mapOperationError("Could not resolve the native fork target launch."));
      if (!provider.forkThread)
        return yield* fail("This provider does not support exact native thread forks.");
      const forked = yield* provider
        .forkThread({
          sourceThreadId: input.sourceThreadId,
          threadId: input.command.threadId,
          sourceResumeCursor: source.sourceCursor,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          modelSelection: input.command.modelSelection,
          runtimeMode: input.command.runtimeMode ?? "full-access",
          managedLaunch: {
            binaryPath: launch.binaryPath,
            isolationKey: launch.isolationKey,
            profileRoot: launch.profileRoot,
            nativeStateRoot: launch.nativeStateRoot,
            childEnvironment: (baseEnv) => launch.childEnvironment(baseEnv),
          } satisfies ProviderManagedLaunchContext,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderThreadSwitchCoordinatorError({
                detail: "Could not create the exact provider-native fork.",
                cause,
              }),
          ),
        );
      const forkIdentity = providerNativeResumeIdentity(
        input.selection.harness,
        forked?.resumeCursor,
      );
      if (
        !forked?.resumeCursor ||
        forkIdentity === null ||
        forkIdentity === source.sourceIdentity
      ) {
        return yield* fail("The provider did not return a distinct exact native fork identity.");
      }
      const verifiedAt = new Date().toISOString();
      forkResultJson = JSON.stringify({
        generationId: input.targetGenerationId,
        adapterSchemaVersion: "managed-native-state-v1",
        stateManifestJson: JSON.stringify({
          format: "managed-native-state-v1",
          sourceGenerationId: source.sourceState.nativeStateGenerationId,
          forkSourceThreadId: input.sourceThreadId,
        }),
        providerSessionId: forkIdentity,
        nativeStateLocatorJson: JSON.stringify(forked.resumeCursor),
        verifiedAt,
      } satisfies typeof VerifiedProviderNativeContinuation.Type);
      yield* forkOperations
        .transition({
          id: input.operationId,
          state: "forked",
          forkResultJson,
          failureReason: null,
          updatedAt: verifiedAt,
        })
        .pipe(mapOperationError("Could not persist the verified native fork state."));
      state = "forked";
    }
    if (state === "committed") {
      const result = yield* engine
        .dispatch(
          {
            ...input.command,
            connectionId: input.selection.connectionId,
            bindingRevision: input.selection.bindingRevision,
          },
          {
            attachmentPrincipal: input.attachmentPrincipal,
          },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderThreadSwitchCoordinatorError({
                detail: cause.message,
                cause,
              }),
          ),
        );
      yield* materializer
        .finalize(input.targetGenerationId)
        .pipe(mapOperationError("Could not finalize the committed native fork state."));
      return result;
    }
    if (state !== "forked" || forkResultJson === null)
      return yield* fail("The native fork verification evidence is missing.");
    const verified = yield* decodeVerification(forkResultJson);
    const result = yield* engine
      .dispatch(
        {
          ...input.command,
          connectionId: input.selection.connectionId,
          bindingRevision: input.selection.bindingRevision,
        },
        {
          attachmentPrincipal: input.attachmentPrincipal,
          acceptedInitialProviderBinding: {
            generation: {
              id: verified.generationId,
              ownerThreadId: input.command.threadId,
              harness: input.selection.harness,
              adapterSchemaVersion: verified.adapterSchemaVersion,
              stateManifestJson: verified.stateManifestJson,
              createdAt: verified.verifiedAt,
            },
            threadId: input.command.threadId,
            providerSessionId: verified.providerSessionId,
            nativeStateLocatorJson: verified.nativeStateLocatorJson,
            connectionId: input.selection.connectionId,
            installationId: input.selection.installationId,
            internalProviderId: input.selection.internalProviderId,
            modelId: input.selection.modelId,
            createdAt: input.command.createdAt,
          },
          acceptedInitialProviderForkOperationId: input.operationId,
        },
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderThreadSwitchCoordinatorError({
              detail: cause.message,
              cause,
            }),
        ),
      );
    yield* materializer
      .finalize(input.targetGenerationId)
      .pipe(mapOperationError("Could not finalize the committed native fork state."));
    return result;
  });

  const runForkClientOperation = (input: Parameters<typeof runForkOperation>[0]) =>
    runForkOperation(input).pipe(
      Effect.catch((cause) =>
        forkOperations.get(input.operationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(cause),
              onSome: (current) => {
                if (current.state === "committed") {
                  return runForkOperation({
                    ...input,
                    startingState: "committed",
                  });
                }
                if (current.state === "failed") return Effect.fail(cause);
                return forkOperations
                  .transition({
                    id: input.operationId,
                    state: "failed",
                    failureReason: cause.message,
                    updatedAt: new Date().toISOString(),
                  })
                  .pipe(
                    Effect.ignore,
                    Effect.andThen(
                      provider.stopSession({
                        threadId: input.command.threadId,
                      }),
                    ),
                    Effect.ignore,
                    Effect.andThen(materializer.discard(input.targetGenerationId)),
                    Effect.ignore,
                    Effect.andThen(Effect.fail(cause)),
                  );
              },
            }),
          ),
          Effect.catch(() => Effect.fail(cause)),
        ),
      ),
    );

  const dispatchTurnStart: ProviderThreadSwitchCoordinatorShape["dispatchTurnStart"] = (input) =>
    Effect.gen(function* () {
      const operationId = operationIdFor(input.command.commandId);
      const existing = Option.getOrUndefined(
        yield* operations
          .get(operationId)
          .pipe(mapOperationError("Could not inspect the provider-switch journal.")),
      );
      const commandJson = JSON.stringify(input.command);
      if (existing) {
        const persistedCommand = yield* decodeCommand(existing.commandJson);
        const persistedFingerprint = fingerprintOrchestrationCommand(persistedCommand);
        const inputFingerprint = fingerprintOrchestrationCommand(input.command);
        if (
          persistedFingerprint.version !== inputFingerprint.version ||
          persistedFingerprint.value !== inputFingerprint.value
        ) {
          return yield* fail("This command id already belongs to a different provider switch.");
        }
        const persistedSelection = yield* decodeSelection(existing.selectionJson);
        if (existing.state === "failed") {
          if (existing.failureReason?.startsWith(RUNTIME_COMPATIBILITY_FAILURE_PREFIX)) {
            return yield* dispatchRuntimeUpgradeFallback({
              command: persistedCommand,
              attachmentPrincipal: input.attachmentPrincipal,
              ...(existing.cwd === null ? {} : { cwd: existing.cwd }),
              selection: persistedSelection,
              operationId,
              targetGenerationId: existing.targetNativeStateGenerationId,
              startingState: "interrupted",
              verificationJson: existing.verificationJson,
            });
          }
          return yield* fail(existing.failureReason ?? "The provider switch previously failed.");
        }
        return yield* runClientOperation({
          command: persistedCommand,
          attachmentPrincipal: input.attachmentPrincipal,
          ...(existing.cwd === null ? {} : { cwd: existing.cwd }),
          selection: persistedSelection,
          operationId,
          targetGenerationId: existing.targetNativeStateGenerationId,
          startingState: existing.state,
          verificationJson: existing.verificationJson,
        });
      }

      const existingFork = Option.getOrUndefined(
        yield* forkOperations
          .get(forkOperationIdFor(input.command.commandId))
          .pipe(mapOperationError("Could not inspect the provider fork journal.")),
      );
      if (existingFork) {
        if (existingFork.state === "failed") {
          return yield* fail(existingFork.failureReason ?? "The provider fork previously failed.");
        }
        const persistedCommand = yield* decodeCommand(existingFork.commandJson);
        const persistedFingerprint = fingerprintOrchestrationCommand(persistedCommand);
        const inputFingerprint = fingerprintOrchestrationCommand(input.command);
        if (
          persistedFingerprint.version !== inputFingerprint.version ||
          persistedFingerprint.value !== inputFingerprint.value
        ) {
          return yield* fail("This command id already belongs to a different provider fork.");
        }
        const selection = yield* decodeSelection(existingFork.selectionJson);
        return yield* runForkClientOperation({
          command: persistedCommand,
          attachmentPrincipal: input.attachmentPrincipal,
          selection,
          sourceThreadId: existingFork.sourceThreadId,
          sourceStateRevision: existingFork.sourceStateRevision,
          sourceBindingRevision: existingFork.sourceBindingRevision,
          targetGenerationId: existingFork.targetNativeStateGenerationId,
          operationId: existingFork.id,
          startingState: existingFork.state,
          forkResultJson: existingFork.forkResultJson,
          ...(existingFork.cwd === null ? {} : { cwd: existingFork.cwd }),
        });
      }

      const harnessState = yield* threadBindings
        .getHarnessState(input.command.threadId)
        .pipe(mapOperationError("Could not inspect the thread's provider binding."));
      const runtimeBinding = yield* threadBindings
        .getRuntimeBinding(input.command.threadId)
        .pipe(mapOperationError("Could not inspect the thread's runtime binding."));
      if (Option.isNone(harnessState) !== Option.isNone(runtimeBinding)) {
        return yield* fail(
          "This Thread predates managed Connections and cannot continue. Start a new Thread.",
        );
      }
      if (Option.isNone(harnessState)) {
        if (input.command.bindingRevision !== 0 || input.command.modelSelection === undefined) {
          return yield* fail("The first message requires an exact model and binding revision 0.");
        }
        const projectedThread = yield* projections
          .getThreadShellById(input.command.threadId)
          .pipe(mapOperationError("Could not inspect the new thread before provider admission."));
        const existingThread = Option.getOrUndefined(projectedThread);
        if (
          existingThread !== undefined &&
          (existingThread.latestTurn != null || existingThread.latestUserMessageAt != null)
        ) {
          return yield* fail(
            "This Thread predates managed Connections and cannot continue. Start a new Thread.",
          );
        }
        const initial = yield* resolver
          .resolveInitial({
            threadId: input.command.threadId,
            nativeStateGenerationId: ProviderNativeStateGenerationId.makeUnsafe(
              `provider-initial-generation:${input.command.commandId}`,
            ),
            modelSelection: input.command.modelSelection,
            ...(input.command.connectionId === undefined
              ? {}
              : { connectionId: input.command.connectionId }),
            createdAt: input.command.createdAt,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderThreadSwitchCoordinatorError({
                  detail: cause.message,
                  cause,
                }),
            ),
          );
        const forkSourceThreadId = existingThread?.forkSourceThreadId;
        if (forkSourceThreadId) {
          const sourceState = yield* threadBindings
            .getHarnessState(forkSourceThreadId)
            .pipe(mapOperationError("Could not read the native fork source state."));
          const sourceBinding = yield* threadBindings
            .getRuntimeBinding(forkSourceThreadId)
            .pipe(mapOperationError("Could not read the native fork source binding."));
          if (Option.isNone(sourceState) || Option.isNone(sourceBinding)) {
            return yield* fail("The native fork source has no exact managed provider binding.");
          }
          if (
            sourceState.value.harness !== initial.selection.harness ||
            input.command.modelSelection.provider !== sourceState.value.harness
          ) {
            return yield* fail("A native fork cannot change provider harnesses.");
          }
          const now = new Date().toISOString();
          const operation = yield* forkOperations
            .begin({
              id: forkOperationIdFor(input.command.commandId),
              commandId: input.command.commandId,
              sourceThreadId: forkSourceThreadId,
              targetThreadId: input.command.threadId,
              state: "pending",
              sourceStateRevision: sourceState.value.revision,
              sourceBindingRevision: sourceBinding.value.revision,
              targetNativeStateGenerationId: initial.initialization.generation.id,
              selectionJson: JSON.stringify(initial.selection),
              commandJson,
              cwd: input.cwd ?? null,
              forkResultJson: null,
              failureReason: null,
              createdAt: now,
              updatedAt: now,
            })
            .pipe(mapOperationError("Could not create the native fork journal."));
          return yield* runForkClientOperation({
            command: input.command,
            attachmentPrincipal: input.attachmentPrincipal,
            selection: initial.selection,
            sourceThreadId: forkSourceThreadId,
            sourceStateRevision: sourceState.value.revision,
            sourceBindingRevision: sourceBinding.value.revision,
            targetGenerationId: operation.targetNativeStateGenerationId,
            operationId: operation.id,
            startingState: operation.state,
            forkResultJson: operation.forkResultJson,
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          });
        }
        return yield* engine
          .dispatch(
            {
              ...input.command,
              connectionId: initial.selection.connectionId,
              bindingRevision: initial.selection.bindingRevision,
            },
            {
              attachmentPrincipal: input.attachmentPrincipal,
              acceptedInitialProviderBinding: initial.initialization,
            },
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderThreadSwitchCoordinatorError({
                  detail: cause.message,
                  cause,
                }),
            ),
          );
      }

      const selection = yield* resolver
        .resolveExisting({
          threadId: input.command.threadId,
          ...(input.command.modelSelection === undefined
            ? {}
            : { modelSelection: input.command.modelSelection }),
          ...(input.command.connectionId === undefined
            ? {}
            : { connectionId: input.command.connectionId }),
          ...(input.command.bindingRevision === undefined
            ? {}
            : { bindingRevision: input.command.bindingRevision }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderThreadSwitchCoordinatorError({
                detail: cause.message,
                cause,
              }),
          ),
        );
      if (!selection.changed) {
        return yield* engine
          .dispatch(
            {
              ...input.command,
              connectionId: selection.connectionId,
              bindingRevision: selection.bindingRevision,
            },
            { attachmentPrincipal: input.attachmentPrincipal },
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderThreadSwitchCoordinatorError({
                  detail: cause.message,
                  cause,
                }),
            ),
          );
      }

      const operation = yield* operations
        .begin({
          id: operationId,
          threadId: input.command.threadId,
          commandId: input.command.commandId,
          kind: selection.requiresNativeStateMaterialization ? "native-state" : "runtime-binding",
          state: "pending",
          sourceStateRevision: selection.stateRevision,
          sourceBindingRevision: selection.bindingRevision,
          targetNativeStateGenerationId: selection.requiresNativeStateMaterialization
            ? generationIdFor(input.command.commandId)
            : null,
          selectionJson: JSON.stringify(selection),
          commandJson,
          cwd: input.cwd ?? null,
          verificationJson: null,
          failureReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .pipe(mapOperationError("Could not create the provider-switch journal."));

      return yield* runClientOperation({
        command: input.command,
        attachmentPrincipal: input.attachmentPrincipal,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        selection,
        operationId,
        targetGenerationId: operation.targetNativeStateGenerationId,
        startingState: "pending",
        verificationJson: operation.verificationJson,
      });
    });

  const recoverSwitches = operations.listOpen().pipe(
    Effect.flatMap((open) =>
      Effect.forEach(
        open,
        (operation) =>
          Effect.gen(function* () {
            if (operation.state === "failed" || operation.state === "committed") return;
            const decoded = yield* Effect.all([
              decodeCommand(operation.commandJson),
              decodeSelection(operation.selectionJson),
            ]).pipe(Effect.result);
            if (Result.isFailure(decoded)) {
              if (operation.targetNativeStateGenerationId !== null) {
                yield* materializer.discard(operation.targetNativeStateGenerationId);
              }
              yield* operations.transition({
                id: operation.id,
                state: "failed",
                failureReason: "Discarded an incompatible pre-cutover provider switch.",
                updatedAt: new Date().toISOString(),
              });
              return;
            }
            const [command, selection] = decoded.success;
            yield* runOperation({
              command,
              attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
              ...(operation.cwd === null ? {} : { cwd: operation.cwd }),
              selection,
              operationId: operation.id,
              targetGenerationId: operation.targetNativeStateGenerationId,
              startingState: operation.state,
              verificationJson: operation.verificationJson,
            });
          }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                console.error("provider thread switch recovery failed", {
                  operationId: operation.id,
                  threadId: operation.threadId,
                  cause: cause.message,
                });
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ),
    mapOperationError("Could not list open provider thread switches."),
    Effect.catch((cause) =>
      Effect.sync(() => {
        console.error("could not list open provider thread switches", {
          cause: cause.message,
        });
      }),
    ),
  );

  const recoverForks = forkOperations.listOpen().pipe(
    Effect.flatMap((open) =>
      Effect.forEach(
        open,
        (operation) =>
          Effect.gen(function* () {
            const decoded = yield* Effect.all([
              decodeCommand(operation.commandJson),
              decodeSelection(operation.selectionJson),
            ]).pipe(Effect.result);
            if (Result.isFailure(decoded)) {
              yield* materializer.discard(operation.targetNativeStateGenerationId);
              yield* forkOperations.transition({
                id: operation.id,
                state: "failed",
                failureReason: "Discarded an incompatible pre-cutover provider fork.",
                updatedAt: new Date().toISOString(),
              });
              return;
            }
            const [command, selection] = decoded.success;
            yield* runForkOperation({
              command,
              attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
              selection,
              sourceThreadId: operation.sourceThreadId,
              sourceStateRevision: operation.sourceStateRevision,
              sourceBindingRevision: operation.sourceBindingRevision,
              targetGenerationId: operation.targetNativeStateGenerationId,
              operationId: operation.id,
              startingState: operation.state,
              forkResultJson: operation.forkResultJson,
              ...(operation.cwd === null ? {} : { cwd: operation.cwd }),
            });
          }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                console.error("provider native fork recovery failed", {
                  operationId: operation.id,
                  threadId: operation.targetThreadId,
                  cause: cause.message,
                });
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ),
    mapOperationError("Could not list open provider native forks."),
    Effect.catch((cause) =>
      Effect.sync(() => {
        console.error("could not list open provider native forks", {
          cause: cause.message,
        });
      }),
    ),
  );

  const recoverOpen = Effect.all([recoverSwitches, recoverForks], {
    concurrency: 1,
    discard: true,
  });

  return {
    dispatchTurnStart,
    recoverOpen,
  } satisfies ProviderThreadSwitchCoordinatorShape;
});

export const ProviderThreadSwitchCoordinatorLive = Layer.effect(
  ProviderThreadSwitchCoordinator,
  makeProviderThreadSwitchCoordinator,
);
