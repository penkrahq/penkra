import {
  CommandId,
  EventId,
  ContainerId,
  SpaceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type ProviderKind,
  type PenkraCreateThreadsInput,
  type PenkraCreateThreadsResult,
} from "@penkra/contracts";
import { buildPromptThreadTitleFallback } from "@penkra/shared/chatThreads";
import { Cause, Effect, Option, Semaphore } from "effect";

import type { ServerConfigShape } from "../config.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import type { ProviderTurnSelectionResolverShape } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import type { ProviderThreadSwitchCoordinatorShape } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import type { ManagedAttachmentPrincipal } from "../managedAttachmentPrincipal.ts";
import type {
  AgentGatewayOperationRecord,
  AgentGatewayOperationRepositoryShape,
} from "./Services/AgentGatewayOperationRepository.ts";
import {
  canonicalJson,
  gatewayIsoNow,
  makeAgentCreationIds,
  stableGatewayDigest,
} from "./creationUtils.ts";
import { mcpToolResultError, mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import {
  AgentGatewayTargetError,
  resolveAgentGatewayTarget,
  type AgentGatewayProviderAvailability,
} from "./targetResolver.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import { GatewayToolError, gatewayToolErrorResult } from "./toolRuntime.ts";

const CREATION_REPLAY_WAIT_MS = 60_000;

interface CreationCoordinatorDependencies {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly providerTurnSelectionResolver: ProviderTurnSelectionResolverShape;
  readonly providerThreadSwitchCoordinator: ProviderThreadSwitchCoordinatorShape;
  readonly operationRepository: AgentGatewayOperationRepositoryShape;
  readonly serverConfig: ServerConfigShape;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown
  >;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, ToolInputError>;
}

export interface GatewayCreationContext {
  readonly kind: "provider-session";
  readonly callerThreadId: string;
  readonly callerTurnId: string | null;
  readonly assertAuthority: () => Effect.Effect<void, GatewayToolError>;
  readonly attachmentPrincipal: ManagedAttachmentPrincipal;
}

type CreationOperationRecord = AgentGatewayOperationRecord;

interface CreationOperationStore {
  readonly getExisting: () => Effect.Effect<CreationOperationRecord | null, Error>;
  readonly getById: (operationId: string) => Effect.Effect<CreationOperationRecord | null, Error>;
  readonly reserve: (input: {
    readonly operationId: string;
    readonly requestId: string;
    readonly fingerprint: string;
    readonly requestedCount: number;
    readonly planJson: string;
    readonly now: string;
  }) => Effect.Effect<
    | {
        readonly kind: "reserved" | "replay" | "idempotency_conflict" | "creation_plan_locked";
        readonly operation: CreationOperationRecord;
      }
    | {
        readonly kind: "concurrency_limited";
        readonly activeCount: number;
        readonly limit: number;
      },
    Error
  >;
  readonly markDispatching: AgentGatewayOperationRepositoryShape["markDispatching"];
  readonly markCompensating: AgentGatewayOperationRepositoryShape["markCompensating"];
  readonly recordCompensationFailure: AgentGatewayOperationRepositoryShape["recordCompensationFailure"];
  readonly complete: AgentGatewayOperationRepositoryShape["complete"];
  readonly fail: AgentGatewayOperationRepositoryShape["fail"];
  readonly registerTask: (input: {
    readonly operationId: string;
    readonly requestId: string;
    readonly threadId: string;
    readonly projectId: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly markTaskStatus: (
    operationId: string,
    status: "created" | "failed",
  ) => Effect.Effect<void, Error>;
}

/**
 * Build the durable, exactly-once thread-creation coordinator.
 *
 * The coordinator owns its per-caller-turn locks and all orchestration
 * compensation state. Keeping that state beside the saga prevents the MCP
 * transport and unrelated tools from becoming accidental recovery owners.
 */
export const makeCreateThreadsHandler = Effect.fn(function* (
  dependencies: CreationCoordinatorDependencies,
) {
  const {
    snapshotQuery,
    orchestrationEngine,
    providerDiscovery,
    providerTurnSelectionResolver,
    providerThreadSwitchCoordinator,
    operationRepository,
    serverConfig,
    loadProviderAvailabilities,
    requireThreadShell,
  } = dependencies;
  const lockIndex = yield* Semaphore.make(1);
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();

  const withCreationPlanLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      lockIndex.withPermits(1)(
        Effect.gen(function* () {
          const existing = locks.get(key);
          if (existing) {
            existing.users += 1;
            return existing;
          }
          const entry = { lock: yield* Semaphore.make(1), users: 1 };
          locks.set(key, entry);
          return entry;
        }),
      ),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        lockIndex.withPermits(1)(
          Effect.sync(() => {
            entry.users -= 1;
            if (entry.users === 0 && locks.get(key) === entry) locks.delete(key);
          }),
        ),
    );

  const awaitCreationReplay = (
    operationStore: CreationOperationStore,
    operationId: string,
    assertAuthority: () => Effect.Effect<void, GatewayToolError>,
  ): Effect.Effect<McpToolCallResult, GatewayToolError | ToolInputError> =>
    Effect.gen(function* () {
      const deadline = Date.now() + CREATION_REPLAY_WAIT_MS;
      let operation = yield* operationStore
        .getById(operationId)
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      while (
        operation !== null &&
        operation.status !== "completed" &&
        operation.status !== "failed" &&
        Date.now() < deadline
      ) {
        yield* assertAuthority();
        yield* Effect.sleep(25);
        operation = yield* operationStore
          .getById(operationId)
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      }
      yield* assertAuthority();
      if (operation?.status === "completed") {
        return mcpToolResultJson(JSON.parse(operation.resultJson ?? "{}"));
      }
      if (operation?.status === "failed") {
        return yield* Effect.fail(
          new GatewayToolError(
            "operation_failed",
            "The original thread-creation operation failed; it will not create replacement threads.",
            {
              operationId,
              error: operation.errorJson ? JSON.parse(operation.errorJson) : null,
            },
          ),
        );
      }
      return yield* Effect.fail(
        new GatewayToolError(
          "operation_failed",
          "The original thread-creation operation is still in progress. Retry only with the same request id; Penkra will not create replacement threads.",
          { operationId, status: operation?.status ?? "missing" },
        ),
      );
    });

  const appendThreadCreationRecap = (input: {
    readonly callerThreadId: string;
    readonly callerTurnId: string;
    readonly result: PenkraCreateThreadsResult;
  }) => {
    const marker = stableGatewayDigest({
      operationId: input.result.operationId,
      kind: "threads-created-recap",
    });
    const createdAt = gatewayIsoNow();
    const threadLabel = input.result.createdCount === 1 ? "thread" : "threads";
    return orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`agent:${marker}:threads-created-recap`),
        threadId: ThreadId.makeUnsafe(input.callerThreadId),
        activity: {
          id: EventId.makeUnsafe(`gateway:${marker}:threads-created-recap`),
          tone: "info",
          kind: "penkra.threads.created",
          summary: `Created ${input.result.createdCount} Penkra ${threadLabel}`,
          payload: {
            source: "penkra_mcp",
            operationId: input.result.operationId,
            requestId: input.result.requestId,
            requestedCount: input.result.requestedCount,
            createdCount: input.result.createdCount,
            threads: JSON.parse(JSON.stringify(input.result.threads)),
          },
          turnId: TurnId.makeUnsafe(input.callerTurnId),
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("agent gateway could not append thread creation recap", {
            operationId: input.result.operationId,
            callerThreadId: input.callerThreadId,
            error: errorText(error),
          }),
        ),
      );
  };

  const run = (input: typeof PenkraCreateThreadsInput.Type, context: GatewayCreationContext) => {
    return Effect.gen(function* () {
      if (context.callerTurnId === null) {
        return yield* Effect.fail(
          new GatewayToolError(
            "caller_turn_inactive",
            "Thread creation requires an active caller turn.",
          ),
        );
      }
      const callerTurnId = context.callerTurnId;
      const caller = yield* requireThreadShell(context.callerThreadId);
      const callerProject = yield* snapshotQuery.getProjectShellById(caller.projectId).pipe(
        Effect.mapError((error) => new ToolInputError(errorText(error))),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new ToolInputError(`Project "${caller.projectId}" was not found.`)),
            onSome: Effect.succeed,
          }),
        ),
      );
      const callerSpaceId = SpaceId.makeUnsafe(caller.spaceId ?? callerProject.spaceId ?? "");
      if (callerSpaceId.length === 0) {
        return yield* Effect.fail(
          new ToolInputError(`The caller Thread is not assigned to a Space.`),
        );
      }
      const operationId = `gateway:create:${stableGatewayDigest({
        principalKind: context.kind,
        principalId: context.callerThreadId,
        callerTurnId,
        requestId: input.requestId,
      })}`;
      const fingerprint = stableGatewayDigest(input, 64);
      const operationStore: CreationOperationStore = {
        getExisting: () =>
          operationRepository.getByScope({
            callerThreadId: context.callerThreadId,
            callerTurnId,
            operationKind: "create_threads",
          }),
        getById: operationRepository.getById,
        reserve: (reservation) =>
          operationRepository.reserve({
            ...reservation,
            callerThreadId: context.callerThreadId,
            callerTurnId,
            operationKind: "create_threads",
          }),
        markDispatching: operationRepository.markDispatching,
        markCompensating: operationRepository.markCompensating,
        recordCompensationFailure: operationRepository.recordCompensationFailure,
        complete: operationRepository.complete,
        fail: operationRepository.fail,
        registerTask: () => Effect.void,
        markTaskStatus: () => Effect.void,
      };
      const existingOperation = yield* operationStore
        .getExisting()
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      if (existingOperation !== null) {
        yield* context.assertAuthority();
        if (existingOperation.requestId !== input.requestId) {
          return yield* Effect.fail(
            new GatewayToolError(
              "creation_plan_locked",
              "This caller turn already committed a different thread-creation plan. A new user turn is required for another plan.",
              {
                operationId: existingOperation.operationId,
                requestId: existingOperation.requestId,
                requestedCount: existingOperation.requestedCount,
                status: existingOperation.status,
              },
            ),
          );
        }
        if (existingOperation.fingerprint !== fingerprint) {
          return yield* Effect.fail(
            new GatewayToolError(
              "idempotency_conflict",
              `Request id "${input.requestId}" was already used with a different creation plan.`,
              { operationId: existingOperation.operationId },
            ),
          );
        }
        if (existingOperation.status === "completed") {
          return mcpToolResultJson(JSON.parse(existingOperation.resultJson ?? "{}"));
        }
        if (existingOperation.status === "failed") {
          return yield* Effect.fail(
            new GatewayToolError(
              "operation_failed",
              "The original thread-creation operation failed; it will not create replacement threads.",
              {
                operationId: existingOperation.operationId,
                error: existingOperation.errorJson ? JSON.parse(existingOperation.errorJson) : null,
              },
            ),
          );
        }
        return yield* awaitCreationReplay(
          operationStore,
          existingOperation.operationId,
          context.assertAuthority,
        );
      }
      const providerAvailabilities = yield* loadProviderAvailabilities;

      const prepared = yield* Effect.forEach(input.threads, (spec, index) =>
        Effect.gen(function* () {
          const projectId = ContainerId.makeUnsafe(spec.projectId ?? caller.projectId);
          const project = yield* snapshotQuery.getProjectShellById(projectId).pipe(
            Effect.mapError((error) => new ToolInputError(errorText(error))),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new ToolInputError(`Project "${projectId}" was not found.`)),
                onSome: Effect.succeed,
              }),
            ),
          );
          const projectSpaceId = project.kind === "chat" ? callerSpaceId : project.spaceId;
          if (projectSpaceId !== callerSpaceId) {
            return yield* Effect.fail(
              new ToolInputError("Created Threads must remain in the caller Thread's Space."),
            );
          }
          const workspaceRoot =
            (caller.projectId === projectId
              ? (caller.workingDirectory ?? project.workspaceRoot)
              : project.workspaceRoot) ?? process.cwd();
          const target = yield* resolveAgentGatewayTarget({
            target: spec.target,
            discovery: providerDiscovery,
            ...(providerAvailabilities.get(spec.target.provider) !== undefined
              ? { availability: providerAvailabilities.get(spec.target.provider)! }
              : {}),
            cwd: workspaceRoot,
          });
          const connectionId = yield* providerTurnSelectionResolver
            .resolveNewThreadConnection({ modelSelection: target })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
          if (spec.runtimeMode === "full-access" && caller.runtimeMode !== "full-access") {
            return yield* Effect.fail(
              new ToolInputError(
                'Your thread runs in "approval-required" mode, so created threads cannot use "full-access".',
              ),
            );
          }
          const runtimeMode = spec.runtimeMode ?? caller.runtimeMode;
          const title = spec.title ?? buildPromptThreadTitleFallback(spec.prompt);
          return {
            index,
            spec,
            projectId,
            workspaceRoot,
            target,
            connectionId,
            spaceId: project.kind === "chat" ? callerSpaceId : null,
            runtimeMode,
            title,
            ids: makeAgentCreationIds(operationId, index),
          };
        }),
      );

      yield* context.assertAuthority();

      const createdThreads: Array<(typeof prepared)[number]> = [];

      const compensateClaimedOperation = (cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          const interrupted = Cause.hasInterrupts(cause);
          const failureMessage = interrupted
            ? "The MCP request was interrupted after thread creation dispatch began."
            : errorText(Cause.squash(cause));
          yield* operationStore.markCompensating({ operationId, now: gatewayIsoNow() }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("agent gateway could not persist compensating status", {
                operationId,
                error: errorText(error),
              }),
            ),
          );
          const compensationErrors: string[] = [];
          let compensatedThreadCount = 0;
          yield* Effect.forEach(
            [...createdThreads].reverse(),
            (entry) =>
              orchestrationEngine
                .dispatch({
                  type: "thread.delete",
                  commandId: entry.ids.compensateCommandId,
                  threadId: entry.ids.threadId,
                })
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      compensatedThreadCount += 1;
                    }),
                  ),
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      compensationErrors.push(`thread ${entry.ids.threadId}: ${errorText(error)}`),
                    ),
                  ),
                ),
            { discard: true },
          );
          // Do not make a task terminal before cleanup has been attempted. The
          // durable capacity view treats planned/created tasks and non-terminal
          // failed compensation as active, so projector lag and restart cannot
          // briefly admit a replacement while this task may still be running.
          yield* operationStore.markTaskStatus(operationId, "failed").pipe(
            Effect.catch((error) =>
              Effect.logWarning("agent gateway could not mark created task failed", {
                operationId,
                error: errorText(error),
              }),
            ),
          );
          const failure = {
            code: interrupted ? "request_interrupted" : "dispatch_failed",
            message: failureMessage,
            createdThreadCount: createdThreads.length,
            compensatedThreadCount,
            compensationErrors,
          };
          if (compensationErrors.length > 0) {
            yield* operationStore
              .recordCompensationFailure({
                operationId,
                errorJson: JSON.stringify(failure),
                now: gatewayIsoNow(),
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("agent gateway compensation status could not be persisted", {
                    operationId,
                    error: errorText(error),
                  }),
                ),
              );
            yield* Effect.logWarning("agent gateway compensation remains pending", {
              operationId,
              errors: compensationErrors,
            });
            return new GatewayToolError(
              "operation_failed",
              "Penkra could not dispatch the exact creation plan and cleanup is still pending. The durable operation remains compensating and will never create replacements.",
              { operationId, ...failure, compensationPending: true },
            );
          }

          const statusFailure = yield* operationStore
            .fail({
              operationId,
              errorJson: JSON.stringify(failure),
              now: gatewayIsoNow(),
            })
            .pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: () => null,
              }),
            );
          if (statusFailure !== null) {
            const statusError = `operation status: ${errorText(statusFailure)}`;
            compensationErrors.push(statusError);
            yield* operationStore
              .recordCompensationFailure({
                operationId,
                errorJson: JSON.stringify(failure),
                now: gatewayIsoNow(),
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("agent gateway fallback status could not be persisted", {
                    operationId,
                    error: errorText(error),
                  }),
                ),
              );
            return new GatewayToolError(
              "operation_failed",
              "Penkra compensated the created resources but could not persist a terminal operation status. The operation remains compensating and will never create replacements.",
              { operationId, ...failure, compensationPending: true },
            );
          }
          return new GatewayToolError(
            "operation_failed",
            "Penkra could not dispatch the exact creation plan. Created operation-owned resources were compensated; no replacements were created.",
            { operationId, ...failure },
          );
        });

      let claimedByThisFiber = false;
      const outcome = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Reservation and claim form one uninterruptible handshake. Once the
          // durable reservation exists, this fiber either claims it while the
          // compensation boundary is already installed or returns a replay.
          const reservation = yield* operationStore
            .reserve({
              operationId,
              requestId: input.requestId,
              fingerprint,
              requestedCount: prepared.length,
              planJson: canonicalJson(
                prepared.map((entry) => ({
                  index: entry.index,
                  projectId: entry.projectId,
                  workspaceRoot: entry.workspaceRoot,
                  runtimeMode: entry.runtimeMode,
                  ids: entry.ids,
                })),
              ),
              now: gatewayIsoNow(),
            })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));

          if (reservation.kind === "idempotency_conflict") {
            return yield* Effect.fail(
              new GatewayToolError(
                "idempotency_conflict",
                `Request id "${input.requestId}" was already used with a different creation plan.`,
                { operationId: reservation.operation.operationId },
              ),
            );
          }
          if (reservation.kind === "concurrency_limited") {
            return yield* Effect.fail(
              new GatewayToolError(
                "concurrency_limited",
                `The gateway already has ${reservation.activeCount} active creation operations (limit ${reservation.limit}).`,
              ),
            );
          }
          if (reservation.kind === "creation_plan_locked") {
            return yield* Effect.fail(
              new GatewayToolError(
                "creation_plan_locked",
                "This caller turn already committed a different thread-creation plan. A new user turn is required for another plan.",
                {
                  operationId: reservation.operation.operationId,
                  requestId: reservation.operation.requestId,
                  requestedCount: reservation.operation.requestedCount,
                  status: reservation.operation.status,
                },
              ),
            );
          }
          if (reservation.kind === "replay" && reservation.operation.status === "completed") {
            return {
              kind: "replay" as const,
              result: mcpToolResultJson(JSON.parse(reservation.operation.resultJson ?? "{}")),
            };
          }
          if (reservation.kind === "replay" && reservation.operation.status === "failed") {
            return yield* Effect.fail(
              new GatewayToolError(
                "operation_failed",
                "The original thread-creation operation failed; it will not create replacement threads.",
                {
                  operationId: reservation.operation.operationId,
                  error: reservation.operation.errorJson
                    ? JSON.parse(reservation.operation.errorJson)
                    : null,
                },
              ),
            );
          }
          if (reservation.kind === "replay" && reservation.operation.status !== "reserved") {
            return {
              kind: "replay" as const,
              result: yield* restore(
                awaitCreationReplay(operationStore, operationId, context.assertAuthority),
              ),
            };
          }

          const claimed = yield* operationStore
            .markDispatching({ operationId, now: gatewayIsoNow() })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
          if (!claimed) {
            return {
              kind: "replay" as const,
              result: yield* restore(
                awaitCreationReplay(operationStore, operationId, context.assertAuthority),
              ),
            };
          }
          claimedByThisFiber = true;

          yield* Effect.forEach(
            prepared,
            (entry) =>
              operationStore.registerTask({
                operationId,
                requestId: input.requestId,
                threadId: entry.ids.threadId,
                projectId: entry.projectId,
                now: gatewayIsoNow(),
              }),
            { discard: true },
          );

          const results = yield* restore(
            Effect.forEach(
              prepared,
              (entry) =>
                Effect.gen(function* () {
                  yield* context.assertAuthority();
                  yield* context.assertAuthority();
                  yield* orchestrationEngine
                    .dispatch({
                      type: "thread.create",
                      commandId: entry.ids.threadCreateCommandId,
                      threadId: entry.ids.threadId,
                      projectId: entry.projectId,
                      ...(entry.spaceId === null ? {} : { spaceId: entry.spaceId }),
                      title: entry.title,
                      modelSelection: entry.target,
                      runtimeMode: entry.runtimeMode,
                      creationSource: "penkra_mcp",
                      sourceThreadId: ThreadId.makeUnsafe(context.callerThreadId),
                      sourceTurnId: TurnId.makeUnsafe(callerTurnId),
                      gatewayOperationId: operationId,
                      gatewayOperationIndex: entry.index,
                      createdAt: gatewayIsoNow(),
                    })
                    .pipe(
                      Effect.tap(() => Effect.sync(() => createdThreads.push(entry))),
                      Effect.uninterruptible,
                    );

                  yield* context.assertAuthority();
                  yield* providerThreadSwitchCoordinator.dispatchTurnStart({
                    command: {
                      type: "thread.turn.start",
                      commandId: entry.ids.turnStartCommandId,
                      threadId: entry.ids.threadId,
                      message: {
                        messageId: entry.ids.messageId,
                        role: "user",
                        text: entry.spec.prompt,
                        attachments: [],
                      },
                      modelSelection: entry.target,
                      connectionId: entry.connectionId,
                      bindingRevision: 0,
                      dispatchMode: "queue",
                      dispatchOrigin: "agent",
                      runtimeMode: entry.runtimeMode,
                      createdAt: gatewayIsoNow(),
                    },
                    attachmentPrincipal: context.attachmentPrincipal,
                    cwd: entry.workspaceRoot,
                  });
                  // The dispatch can outlive the caller turn. Recheck after it returns so
                  // a child started in that final race window is compensated as part of
                  // the same durable operation instead of being left detached.
                  yield* context.assertAuthority();

                  yield* operationStore.markTaskStatus(operationId, "created");

                  return {
                    index: entry.index,
                    threadId: entry.ids.threadId,
                    projectId: entry.projectId,
                    title: entry.title,
                    target: entry.target,
                    provider: entry.target.provider,
                    model: entry.target.model,
                    runtimeMode: entry.runtimeMode,
                    status: "task_dispatched" as const,
                  };
                }),
              { concurrency: 1 },
            ),
          );
          const result = {
            operationId,
            requestId: input.requestId,
            requestedCount: input.threads.length,
            createdCount: results.length,
            threadIds: results.map((entry) => entry.threadId),
            threads: results,
          } satisfies PenkraCreateThreadsResult;
          // Once every deterministic dispatch succeeded, durable completion is
          // the commit point. A late client cancellation must not roll back a
          // fully-created operation or strand it between dispatching/completed.
          yield* operationStore.complete({
            operationId,
            resultJson: JSON.stringify(result),
            now: gatewayIsoNow(),
          });
          return { kind: "created" as const, result };
        }).pipe(
          Effect.catchCause((cause) =>
            claimedByThisFiber
              ? compensateClaimedOperation(cause).pipe(
                  Effect.flatMap((compensationError) =>
                    Cause.hasInterrupts(cause) || Cause.hasDies(cause)
                      ? Effect.failCause(cause)
                      : Effect.fail(compensationError),
                  ),
                )
              : Effect.failCause(cause),
          ),
        ),
      );

      if (outcome.kind === "replay") return outcome.result;
      const result = outcome.result;
      yield* appendThreadCreationRecap({
        callerThreadId: context.callerThreadId,
        callerTurnId,
        result,
      });
      return mcpToolResultJson(result);
    }).pipe(
      (effect) =>
        withCreationPlanLock(
          `${context.callerThreadId}\u0000${context.callerTurnId ?? "inactive"}`,
          effect,
        ),
      Effect.catch((error) =>
        Effect.succeed(
          error instanceof GatewayToolError || error instanceof AgentGatewayTargetError
            ? gatewayToolErrorResult(error)
            : mcpToolResultError(errorText(error)),
        ),
      ),
    );
  };

  return run;
});
