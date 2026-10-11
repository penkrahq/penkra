// FILE: ProviderThreadSwitchCoordinator.ts
// Purpose: Crash-recoverable interrupt, verify, and atomic switch admission saga.

import * as SqlClient from "effect/unstable/sql/SqlClient";
import { findThread } from "../../cleanCore/threadList.ts";

import {
  OrchestrationCommand,
  ProviderNativeStateGenerationId,
  ThreadId,
  type RuntimeMode,
} from "@penkra/contracts";
import { Effect, Layer, Option, Result, Schema } from "effect";
import {
  committedQaProviderSwitch,
  requestedQaProviderSwitch,
} from "../../diagnostics/qaProviderSwitch.ts";

import { ServerConfig } from "../../config.ts";
import {
  LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
  type ManagedAttachmentPrincipal,
} from "../../managedAttachmentPrincipal.ts";
import { ProviderThreadSwitchOperationRepository } from "../../persistence/Services/ProviderThreadSwitchOperations.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { providerNativeResumeIdentity } from "../../provider/nativeResumeIdentity.ts";
import {
  discardClaudeThreadAccountTransition,
  revokeClaudeThreadAccountTransitionLinks,
  stageClaudeThreadAccountTransition,
} from "../../provider/claudeThreadNativeState.ts";
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
import { OrchestrationCommandInvariantError } from "../Errors.ts";
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
const generationIdFor = (commandId: string) =>
  ProviderNativeStateGenerationId.makeUnsafe(`provider-switch-generation:${commandId}`);
const anonymousConnectionLabel = (harness: string) =>
  harness === "opencode" ? "OpenCode" : "No Connection";
type TurnAdmissionCommand = Extract<
  typeof OrchestrationCommand.Type,
  { type: "thread.turn.start" | "thread.turn.dispatch-queued" }
>;

const isRetryableOperationFailure = (failure: ProviderThreadSwitchCoordinatorError): boolean => {
  if (failure.code === "switch_wait_timeout" || failure.code === "binding_revision_stale") {
    return true;
  }
  let current: unknown = failure.cause;
  const seen = new Set<Error>();
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof OrchestrationCommandInvariantError) {
      return (
        current.code === "thread_running" ||
        current.code === "provider_switch_commit_retryable" ||
        current.code === "queued_turn_stopped"
      );
    }
    seen.add(current);
    current = current.cause;
  }
  // Repository, provider, and filesystem errors retain their structured cause.
  return failure.code === "selection_failed" && failure.cause !== undefined;
};

export const makeProviderThreadSwitchCoordinator = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const operations = yield* ProviderThreadSwitchOperationRepository;
  const threadBindings = yield* ThreadProviderBindingRepository;
  const provider = yield* ProviderService;
  const projections = yield* ProjectionSnapshotQuery;
  const sql = yield* SqlClient.SqlClient;
  const launches = yield* ProviderLaunchResolver;
  const resolver = yield* ProviderTurnSelectionResolver;
  const verifier = yield* ProviderNativeContinuationVerifier;
  const materializer = yield* ProviderNativeStateMaterializer;

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
        command.type === "thread.turn.start" || command.type === "thread.turn.dispatch-queued"
          ? Effect.succeed(command)
          : fail("The persisted provider-switch command is not a turn admission."),
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
          return Effect.fail(
            new ProviderThreadSwitchCoordinatorError({
              code: "switch_wait_timeout",
              detail:
                "The active provider turn and its durable projection did not settle after interruption.",
            }),
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

  const stageClaudeTransition = (selection: ResolvedProviderTurnSelection, commandId: string) =>
    selection.claudeAccountTransition === undefined || selection.connectionId === null
      ? Effect.void
      : Effect.tryPromise({
          try: () =>
            stageClaudeThreadAccountTransition({
              stateDir: config.stateDir,
              threadId: selection.threadId,
              transition: {
                commandId,
                connectionId: selection.connectionId!,
                bindingRevision: selection.bindingRevision + 1,
                source: selection.claudeAccountTransition!.source,
                target: selection.claudeAccountTransition!.target,
              },
            }),
          catch: (cause) =>
            new ProviderThreadSwitchCoordinatorError({
              detail: "Could not stage the Claude account transition.",
              cause,
            }),
        });

  const finishFailedCleanup = (operation: {
    readonly id: string;
    readonly threadId: ThreadId;
    readonly commandId: string;
    readonly targetNativeStateGenerationId: typeof ProviderNativeStateGenerationId.Type | null;
    readonly failureReason: string | null;
  }) =>
    Effect.gen(function* () {
      // The journal remains recoverable until both resources are removed. A
      // crash after the pending write must never leave a terminal failed row
      // with a still-linked target profile.
      yield* Effect.tryPromise({
        try: () =>
          discardClaudeThreadAccountTransition({
            stateDir: config.stateDir,
            threadId: operation.threadId,
            commandId: operation.commandId,
          }),
        catch: (cause) =>
          new ProviderThreadSwitchCoordinatorError({
            detail: "Could not discard the failed Claude account transition.",
            cause,
          }),
      });
      if (operation.targetNativeStateGenerationId !== null) {
        yield* materializer
          .discard(operation.targetNativeStateGenerationId)
          .pipe(mapOperationError("Could not discard the failed native state generation."));
      }
      yield* operations
        .transition({
          id: operation.id,
          state: "failed",
          failureReason: operation.failureReason ?? "The provider switch failed.",
          updatedAt: new Date().toISOString(),
        })
        .pipe(mapOperationError("Could not finish failed provider-switch cleanup."));
    });

  const preflightSteeringTarget = (selection: ResolvedProviderTurnSelection) =>
    selection.harness !== "claudeAgent" || !selection.changed
      ? Effect.void
      : launches
          .resolveProfile({
            harness: selection.harness,
            connectionId: selection.connectionId,
            installationId: selection.installationId,
            internalProviderId: selection.internalProviderId,
            nativeStateIdentity: `provider-switch-preflight:${selection.threadId}`,
            // No thread id: preflight must not link an uncommitted target to
            // the source conversation before the interruption.
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderThreadSwitchCoordinatorError({
                  code: "switch_operation_failed",
                  detail: `The selected Claude Connection is unavailable before steering: ${cause.message}`,
                  cause,
                }),
            ),
            Effect.asVoid,
          );

  const runOperation = Effect.fnUntraced(function* (input: {
    readonly command: TurnAdmissionCommand;
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
        if (selection.harness === "claudeAgent" && selection.changed) {
          const current = yield* resolver
            .resolveExisting({
              threadId: input.command.threadId,
              ...(input.command.modelSelection === undefined
                ? {}
                : { modelSelection: input.command.modelSelection }),
              ...(input.command.connectionId === undefined
                ? {}
                : { connectionId: input.command.connectionId }),
              bindingRevision: selection.bindingRevision,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderThreadSwitchCoordinatorError({
                    code: cause.code,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          if (
            current.stateRevision !== selection.stateRevision ||
            current.bindingRevision !== selection.bindingRevision ||
            current.connectionId !== selection.connectionId ||
            current.modelId !== selection.modelId
          ) {
            return yield* fail("The Claude Thread binding changed before steering.");
          }
        }
        yield* preflightSteeringTarget(selection);
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
                code: cause.code,
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
        const preparation =
          input.verificationJson === null
            ? null
            : yield* decodeVerification(input.verificationJson);
        if (preparation?.kind !== "reconstructed") {
          yield* materializer
            .finalize(input.targetGenerationId)
            .pipe(mapOperationError("Could not finalize the committed provider-switch state."));
        }
      }
      return result;
    }

    if (state === "interrupted") {
      if (selection.requiresNativeStateMaterialization) {
        if (input.targetGenerationId === null) {
          return yield* fail("The native provider switch has no target state generation.");
        }
        if (selection.claudeAccountTransition !== undefined && verificationJson !== null) {
          // A process may have died after sending the paid probe but before
          // recording its result. Its outcome is unknown; keep the old binding
          // and fail this message rather than charging the account again.
          return yield* fail(
            "The Claude resume probe was interrupted before its result was saved.",
          );
        }
        // A settled turn can still leave its provider session alive and owning
        // the exact native conversation. Release that writer before a second
        // installation/profile verifies the cloned continuation. The durable
        // native state remains the source of truth and is cloned below.
        yield* provider
          .stopSession({ threadId: input.command.threadId })
          .pipe(
            mapOperationError("Could not release the source provider session before switching."),
          );
        yield* Effect.logInfo("provider switch released source session before verification", {
          threadId: input.command.threadId,
          harness: selection.harness,
          sourceConnectionId: selection.previousConnectionId,
          targetConnectionId: selection.connectionId,
          targetGenerationId: input.targetGenerationId,
        });
        yield* stageClaudeTransition(selection, input.command.commandId);
        if (selection.claudeAccountTransition !== undefined) {
          const marked = yield* operations
            .markResumeProbeAttempted({
              id: input.operationId,
              updatedAt: new Date().toISOString(),
            })
            .pipe(mapOperationError("Could not journal the Claude resume probe attempt."));
          if (!marked) return yield* fail("The Claude resume probe was already attempted.");
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
                  code: "switch_operation_failed",
                  detail: `Could not verify the selected Connection's native conversation: ${cause.message}`,
                  cause,
                }),
            ),
          );
        if (selection.claudeAccountTransition !== undefined) {
          // The completed verification prompt ran only against the disposable
          // target copy. Restore the exact settled source before binding it.
          yield* stageClaudeTransition(selection, input.command.commandId);
        }
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
      if (verified?.kind !== "reconstructed") {
        yield* materializer
          .finalize(input.targetGenerationId)
          .pipe(mapOperationError("Could not finalize the committed provider-switch state."));
      }
    }
    return result;
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
                  return Effect.fail(cause);
                }
                if (current.state === "failed-cleanup-pending") {
                  return finishFailedCleanup(current).pipe(Effect.andThen(Effect.fail(cause)));
                }
                if (isRetryableOperationFailure(cause)) {
                  return Effect.tryPromise({
                    try: () =>
                      revokeClaudeThreadAccountTransitionLinks({
                        stateDir: config.stateDir,
                        threadId: input.command.threadId,
                        commandId: input.command.commandId,
                      }),
                    catch: () => cause,
                  }).pipe(Effect.ignore, Effect.andThen(Effect.fail(cause)));
                }
                return operations
                  .transition({
                    id: input.operationId,
                    state: "failed-cleanup-pending",
                    failureReason: cause.message,
                    updatedAt: new Date().toISOString(),
                  })
                  .pipe(
                    Effect.flatMap((pending) =>
                      Option.isSome(pending)
                        ? finishFailedCleanup(pending.value)
                        : fail("The failed provider-switch journal was not found."),
                    ),
                    Effect.andThen(Effect.fail(cause)),
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

  const dispatchTurnAdmission = (input: {
    readonly command: TurnAdmissionCommand;
    readonly attachmentPrincipal: ManagedAttachmentPrincipal;
    readonly cwd?: string;
  }) =>
    Effect.gen(function* () {
      const operationId = operationIdFor(input.command.commandId);
      const finishQaSwitch = () =>
        Effect.gen(function* () {
          const latest = yield* operations
            .get(operationId)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          if (Option.getOrUndefined(latest)?.state === "committed")
            committedQaProviderSwitch(input.command.commandId, input.command.threadId);
        });
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
          return yield* Effect.fail(
            new ProviderThreadSwitchCoordinatorError({
              code: "switch_operation_failed",
              detail: existing.failureReason ?? "The provider switch previously failed.",
            }),
          );
        }
        if (existing.state === "failed-cleanup-pending") {
          yield* finishFailedCleanup(existing);
          return yield* fail(existing.failureReason ?? "The provider switch previously failed.");
        }
        const result = yield* runClientOperation({
          command: persistedCommand,
          attachmentPrincipal: input.attachmentPrincipal,
          ...(existing.cwd === null ? {} : { cwd: existing.cwd }),
          selection: persistedSelection,
          operationId,
          targetGenerationId: existing.targetNativeStateGenerationId,
          startingState: existing.state,
          verificationJson: existing.verificationJson,
        });
        yield* finishQaSwitch();
        return result;
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
        if (
          input.command.type !== "thread.turn.start" ||
          input.command.bindingRevision !== 0 ||
          input.command.modelSelection === undefined
        ) {
          return yield* fail("The first message requires an exact model and binding revision 0.");
        }
        const projectedThread = yield* projections
          .getThreadShellById(input.command.threadId)
          .pipe(mapOperationError("Could not inspect the new thread before provider admission."));
        const existingThread = Option.getOrUndefined(projectedThread);
        const canonical = yield* findThread(input.command.threadId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          mapOperationError("Could not inspect the new thread before provider admission."),
        );
        if (
          existingThread !== undefined &&
          (existingThread.latestTurn != null || canonical?.lastUserMessageAt != null)
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
                  code: cause.code,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
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
                code: cause.code,
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
      requestedQaProviderSwitch(input.command.commandId, input.command.threadId);

      const result = yield* runClientOperation({
        command: input.command,
        attachmentPrincipal: input.attachmentPrincipal,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        selection,
        operationId,
        targetGenerationId: operation.targetNativeStateGenerationId,
        startingState: "pending",
        verificationJson: operation.verificationJson,
      });
      yield* finishQaSwitch();
      return result;
    });

  const recoverSwitches = operations.listOpen().pipe(
    Effect.flatMap((open) =>
      Effect.forEach(
        open,
        (operation) =>
          Effect.gen(function* () {
            if (operation.state === "failed" || operation.state === "committed") return;
            if (operation.state === "failed-cleanup-pending") {
              yield* finishFailedCleanup(operation);
              return;
            }
            const decoded = yield* Effect.all([
              decodeCommand(operation.commandJson),
              decodeSelection(operation.selectionJson),
            ]).pipe(Effect.result);
            if (Result.isFailure(decoded)) {
              yield* Effect.tryPromise({
                try: () =>
                  discardClaudeThreadAccountTransition({
                    stateDir: config.stateDir,
                    threadId: operation.threadId,
                    commandId: operation.commandId,
                  }),
                catch: (cause) =>
                  new ProviderThreadSwitchCoordinatorError({
                    detail: "Could not clean up an incompatible Claude account transition.",
                    cause,
                  }),
              });
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
            yield* runClientOperation({
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
              operations.get(operation.id).pipe(
                Effect.flatMap((current) =>
                  Option.isSome(current) && current.value.state !== "committed"
                    ? Effect.tryPromise({
                        try: () =>
                          revokeClaudeThreadAccountTransitionLinks({
                            stateDir: config.stateDir,
                            threadId: operation.threadId,
                            commandId: operation.commandId,
                          }),
                        catch: () => cause,
                      })
                    : Effect.void,
                ),
                Effect.catch(() => Effect.void),
                Effect.andThen(
                  Effect.sync(() => {
                    console.error("provider thread switch recovery failed", {
                      operationId: operation.id,
                      threadId: operation.threadId,
                      cause: cause.message,
                    });
                  }),
                ),
              ),
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

  const recoverOpen = recoverSwitches;

  return {
    dispatchTurnStart: dispatchTurnAdmission,
    dispatchQueuedTurn: dispatchTurnAdmission,
    recoverOpen,
  } satisfies ProviderThreadSwitchCoordinatorShape;
});

export const ProviderThreadSwitchCoordinatorLive = Layer.effect(
  ProviderThreadSwitchCoordinator,
  makeProviderThreadSwitchCoordinator,
);
