import {
  applyProviderDeltaRun,
  consumeProviderRuntimeEvent,
} from "../../cleanCore/providerStreamConsumer.ts";
import { ConnectionRateLimits } from "../../providerUsage/ConnectionRateLimits.ts";
import { ProviderAuthCircuits } from "../providerAuthCircuit.ts";
/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ProviderCompactThreadInput,
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderStopTaskInput,
  ProviderBackgroundTaskInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderStartReviewInput,
  ProviderSteerTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderStartOptions,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderKind,
  type ProviderSession,
} from "@penkra/contracts";
import {
  Array as EffectArray,
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Schema,
  SchemaIssue,
  Scope,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { nonEmptyTrimmed } from "@penkra/shared/text";

import {
  ProviderValidationError,
  type ProviderServiceError,
  type ProviderSessionDirectoryPersistenceError,
} from "../Errors.ts";
import { PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE } from "@penkra/shared/threadSummary";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderManagedLaunchContext } from "../Services/ProviderAdapter.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryWriteError,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { readThreadNativeState } from "../../cleanCore/threadNativeState.ts";
import { ThreadPublisher } from "../../cleanCore/ThreadPublisher.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { parseOpenCodeModelSlug } from "../opencodeRuntime.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  classifyTerminalTurnApplicability,
  isStartedTurnApplicable,
} from "../terminalTurnApplicability.ts";
import { makeThreadRuntime } from "../ThreadRuntime.ts";
import { carryProviderAttachmentPaths } from "../providerAttachmentPaths.ts";
import { providerNativeResumeIdentity } from "../nativeResumeIdentity.ts";

/**
 * Preserve the adapter's per-occurrence identity. A content-derived id cannot distinguish two
 * legitimate notifications with identical payloads (assistant streams commonly repeat spaces,
 * punctuation, and short token chunks), so replay stability belongs to adapters that expose a
 * native cursor or other occurrence identity.
 */
export function normalizeProviderRuntimeEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  return normalizeProviderAuthoredText(event);
}

/**
 * Provider display text is not an identifier and is not authored by Penkra.
 * Normalize its outer whitespace at the shared ingress boundary so an otherwise
 * valid native event cannot be permanently rejected by the encoded contract.
 * Internal newlines and indentation remain intact. Blank optional display fields
 * are omitted instead of turning harmless provider output into data loss.
 */
function normalizeProviderAuthoredText(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return event;
  }
  const { title: originalTitle, detail: originalDetail, ...payload } = event.payload;
  const title = originalTitle?.trim();
  // Assistant completion detail is the provider's authoritative accumulated message text.
  // Preserve it byte-for-byte so completion can repair a missing or duplicated stream fragment.
  const detail =
    event.payload.itemType === "assistant_message" ? originalDetail : originalDetail?.trim();
  return {
    ...event,
    payload: {
      ...payload,
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
    },
  };
}

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
  readonly threadSessionIdleMs?: number;
  /** Canonical queue/question eligibility, evaluated only when idle disposal begins. */
  readonly canIdleStop?: (threadId: ThreadId) => Effect.Effect<boolean, unknown>;
  /** Test/embedding override for the lossless runtime-event fan-out budget. */
  readonly runtimeEventBufferCapacity?: number;
  /** Commit the canonical thread event before publishing it to observers. */
  readonly consumeRuntimeEvent?: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<ProviderRuntimeEvent | null, unknown>;
  /** Commit one ordered run of content deltas before its observer fan-out. */
  readonly consumeRuntimeDeltaRun?: (
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ) => Effect.Effect<void, unknown>;
  /** Persist an exact provider-native cursor into the managed thread binding. */
  readonly persistNativeResumeCursor?: (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderSession["provider"];
    readonly resumeCursor: unknown;
  }) => Effect.Effect<void, unknown>;
  /** Production resolver for every start/recovery not already admitted with an exact launch. */
  readonly resolveManagedLaunch?: (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderSession["provider"];
  }) => Effect.Effect<ProviderManagedLaunchContext, unknown>;
}

// Claude owns one process per thread; idle conversations resume after a 30-minute stop.
export const THREAD_SESSION_IDLE_MS = 30 * 60 * 1000;
export const PROVIDER_RUNTIME_EVENT_BUFFER_CAPACITY = 2_048;
const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
  beforeTurnId: Schema.optional(TurnId),
});

const ClearSessionResumeCursorInput = Schema.Struct({
  threadId: ThreadId,
  preserveActiveRuntime: Schema.optional(Schema.Boolean),
});

type StopRuntimeSession = NonNullable<ProviderServiceShape["stopRuntimeSession"]>;
type StopRuntimeSessionInput = Parameters<StopRuntimeSession>[0];
type StopRuntimeSessionEffect = ReturnType<StopRuntimeSession>;

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
  code?: typeof PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(code === undefined ? {} : { code }),
    ...(cause !== undefined ? { cause } : {}),
  });
}

const mapManagedLaunchError = (operation: string) => (cause: unknown) =>
  toValidationError(operation, "Could not resolve the exact managed provider launch.", cause);

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  if (session.status === "connecting") return "starting";
  if (session.status === "closed") return "stopped";
  return session.status === "error" ? "error" : "running";
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly providerOptions?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    readonly lifecycleGeneration?: string;
    readonly managedIsolationKey?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: nonEmptyTrimmed(session.activeTurnId) ?? null,
    // `thread.session.set` types both as trimmed-non-empty-or-null, so a blank
    // provider string has to become an explicit "absent" rather than reaching
    // the schema as "".
    lastError: nonEmptyTrimmed(session.lastError) ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.providerOptions !== undefined ? { providerOptions: extra.providerOptions } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: extra.lifecycleGeneration }
      : {}),
    ...(extra?.managedIsolationKey !== undefined
      ? { managedIsolationKey: extra.managedIsolationKey }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  const raw = runtimePayloadRecord(runtimePayload).modelSelection;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

function readPersistedProviderOptions(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ProviderStartOptions | undefined {
  const raw = runtimePayloadRecord(runtimePayload).providerOptions;
  return Option.getOrUndefined(Schema.decodeUnknownOption(ProviderStartOptions)(raw));
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  const rawCwd = runtimePayloadRecord(runtimePayload).cwd;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedManagedIsolationKey(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  const value = runtimePayloadRecord(runtimePayload).managedIsolationKey;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function shouldRestartForManagedIsolationChange(input: {
  readonly persistedIsolationKey: string | undefined;
  readonly currentIsolationKey: string;
  readonly activeTurnId: string | undefined;
}): boolean {
  return (
    input.persistedIsolationKey !== input.currentIsolationKey && input.activeTurnId === undefined
  );
}

function runtimePayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function runtimeActiveTurnId(value: unknown): string | undefined {
  const activeTurnId = runtimePayloadRecord(value).activeTurnId;
  return typeof activeTurnId === "string" ? activeTurnId : undefined;
}

function hasResumeCursor(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function makeKeyedThreadLock() {
  const entries = new Map<ThreadId, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  const withLock = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    let entry = entries.get(threadId);
    if (entry === undefined) {
      entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      entries.set(threadId, entry);
    }
    entry.users += 1;
    const acquiredEntry = entry;
    return acquiredEntry.semaphore
      .withPermits(1)(effect)
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            acquiredEntry.users -= 1;
            if (acquiredEntry.users === 0 && entries.get(threadId) === acquiredEntry) {
              entries.delete(threadId);
            }
          }),
        ),
      );
  };
  return withLock;
}

function runtimeStatusForEvent(
  event: ProviderRuntimeEvent,
  activeTurnId?: unknown,
): "running" | "stopped" | "error" {
  switch (event.type) {
    case "session.state.changed":
      if (event.payload.state === "stopped") return "stopped";
      return event.payload.state === "error" ? "error" : "running";
    case "thread.state.changed":
      if (event.payload.state === "error") return "error";
      if (event.payload.state === "archived" || event.payload.state === "closed") return "stopped";
      return event.payload.state === "compacted" &&
        event.turnId === undefined &&
        activeTurnId == null
        ? "stopped"
        : "running";
    case "session.exited":
    case "turn.completed":
    case "turn.aborted":
      // A completed turn can still carry a resume cursor, but it must not keep
      // the desktop app treating the provider process as active after restart.
      return "stopped";
    case "runtime.error":
      return "error";
    default:
      return "running";
  }
}

function shouldRefreshResumeCursorForEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "thread.started" ||
    event.type === "model.rerouted" ||
    (event.type === "thread.state.changed" &&
      event.payload.state === "compacted" &&
      event.turnId === undefined) ||
    event.type === "turn.tasks.updated" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted"
  );
}

function runtimeLastErrorForEvent(event: ProviderRuntimeEvent): string | null | undefined {
  // A blank message must not degrade to `null`: null means "clear the error",
  // which would erase the very failure being reported. Fall back to an honest
  // constant instead.
  if (event.type === "runtime.error")
    return nonEmptyTrimmed(event.payload.message) ?? "Provider runtime reported an error.";
  if (event.type === "session.state.changed")
    return event.payload.state === "error"
      ? (nonEmptyTrimmed(event.payload.reason) ?? "Session error")
      : null;
  if (event.type === "thread.state.changed")
    return event.payload.state === "error" ? "Thread error" : null;
  return event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited"
    ? null
    : undefined;
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const analytics = yield* Effect.service(AnalyticsService);
    const canonicalEventLogger =
      options?.canonicalEventLogger ??
      (options?.canonicalEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
            stream: "canonical",
          })
        : undefined);

    const registry = yield* ProviderAdapterRegistry;
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const directory = yield* ProviderSessionDirectory;
    const removeBinding = (
      threadId: ThreadId,
      path: "stop" | "retire" | "replacement-failed",
      reason: string,
    ) =>
      Effect.gen(function* () {
        const binding = yield* directory.getBinding(threadId);
        yield* directory.remove(threadId);
        if (Option.isSome(binding)) {
          yield* Effect.logInfo("provider.binding.removed", {
            threadId,
            provider: binding.value.provider,
            path,
            reason,
          });
        }
      });
    const lifecycle = makeThreadRuntime({
      retireNativeContinuation: (threadId, provider) =>
        withNativeCommitLock(
          threadId,
          withBindingWriteLock(
            threadId,
            Effect.gen(function* () {
              if (options?.persistNativeResumeCursor)
                yield* options.persistNativeResumeCursor({
                  threadId,
                  provider,
                  resumeCursor: null,
                });
              yield* removeBinding(threadId, "retire", "native continuation retired");
              const state = getDispatchState(threadId);
              state.nextGeneration++;
              state.latestGeneration = state.nextGeneration;
              state.ownerGeneration = state.nextGeneration;
              state.outstandingTurnIds.clear();
              state.successfulResults.clear();
              liveRuntimeTaskIds.delete(threadId);
              recentlyCompletedTurnsByThread.delete(threadId);
              cleanupDispatchState(threadId);
            }),
          ),
        ),
    });
    for (const binding of yield* directory.listBindings()) {
      if (binding.lifecycleGeneration !== undefined) {
        lifecycle.adoptCurrent(binding.threadId, binding.lifecycleGeneration, binding.provider);
      }
    }
    const runtimeEventBufferCapacity = Math.max(
      1,
      Math.floor(options?.runtimeEventBufferCapacity ?? PROVIDER_RUNTIME_EVENT_BUFFER_CAPACITY),
    );
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      runtimeEventBufferCapacity,
    );
    const runtimeEventProducerScope = yield* Scope.make("sequential");
    const liveRuntimeTaskIds = new Map<ThreadId, Set<string>>();
    const threadSessionIdleMs = Math.max(0, options?.threadSessionIdleMs ?? THREAD_SESSION_IDLE_MS);
    const clearRuntimeIdleTimer = lifecycle.cancelIdle;
    const waitForRuntimeIdleStop = lifecycle.waitIdle;
    const idleHolds = new Map<ThreadId, { count: number; pendingProvider?: ProviderKind }>();

    const scheduleRuntimeIdleStop = (threadId: ThreadId, provider: ProviderSession["provider"]) => {
      clearRuntimeIdleTimer(threadId);
      if (provider !== "claudeAgent") return;
      const hold = idleHolds.get(threadId);
      if (hold) {
        hold.pendingProvider = provider;
        return;
      }
      const dispatch = dispatchStateByThread.get(threadId);
      if (
        (dispatch?.outstandingTurnIds.size ?? 0) > 0 ||
        (dispatch?.inFlightGenerations.size ?? 0) > 0 ||
        (liveRuntimeTaskIds.get(threadId)?.size ?? 0) > 0
      )
        return;
      lifecycle.scheduleIdle(
        threadId,
        threadSessionIdleMs,
        Effect.suspend(() => stopIdleRuntimeSession(threadId)),
      );
    };

    const markRuntimeTaskLive = (threadId: ThreadId, taskId: string): void => {
      const taskIds = liveRuntimeTaskIds.get(threadId) ?? new Set<string>();
      taskIds.add(taskId);
      liveRuntimeTaskIds.set(threadId, taskIds);
      clearRuntimeIdleTimer(threadId);
    };

    const markRuntimeTaskSettled = (
      threadId: ThreadId,
      taskId: string,
      provider: ProviderSession["provider"],
    ): void => {
      const taskIds = liveRuntimeTaskIds.get(threadId);
      taskIds?.delete(taskId);
      if (taskIds && taskIds.size > 0) return;
      liveRuntimeTaskIds.delete(threadId);
      scheduleRuntimeIdleStop(threadId, provider);
    };

    const runIdleSensitiveProviderWork = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
      options?: { readonly scheduleIdleStopOnSuccess?: boolean },
    ): Effect.Effect<A, E | ProviderSessionDirectoryPersistenceError, R> =>
      Effect.suspend(() => {
        const hadIdleJob = lifecycle.hasIdleJob(threadId);
        const hold = idleHolds.get(threadId) ?? { count: 0 };
        hold.count += 1;
        idleHolds.set(threadId, hold);
        clearRuntimeIdleTimer(threadId);
        return waitForRuntimeIdleStop(threadId).pipe(
          Effect.andThen(effect),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const shouldSchedule = Exit.isSuccess(exit)
                ? options?.scheduleIdleStopOnSuccess === true
                : hadIdleJob;
              if (shouldSchedule) {
                const binding = yield* directory.getBinding(threadId);
                if (Option.isSome(binding))
                  scheduleRuntimeIdleStop(threadId, binding.value.provider);
              }
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  hold.count -= 1;
                  if (hold.count === 0) {
                    idleHolds.delete(threadId);
                    if (hold.pendingProvider)
                      scheduleRuntimeIdleStop(threadId, hold.pendingProvider);
                  }
                }),
              ),
            ),
          ),
        );
      });

    const reconcileRuntimeIdleTimer = (event: ProviderRuntimeEvent) => {
      clearRuntimeIdleTimer(event.threadId);
      switch (event.type) {
        case "turn.started":
          return;
        case "task.started":
        case "task.progress":
          markRuntimeTaskLive(event.threadId, event.payload.taskId);
          return;
        case "task.updated":
          if (
            event.payload.status === "completed" ||
            event.payload.status === "failed" ||
            event.payload.status === "killed" ||
            event.payload.status === "paused"
          ) {
            markRuntimeTaskSettled(event.threadId, event.payload.taskId, event.provider);
          } else {
            markRuntimeTaskLive(event.threadId, event.payload.taskId);
          }
          return;
        case "task.completed":
          markRuntimeTaskSettled(event.threadId, event.payload.taskId, event.provider);
          return;
        case "session.started":
        case "thread.started":
        case "turn.completed":
        case "turn.aborted":
          scheduleRuntimeIdleStop(event.threadId, event.provider);
          return;
        case "thread.state.changed":
          if (
            event.payload.state === "compacted" ||
            event.payload.state === "archived" ||
            event.payload.state === "closed"
          ) {
            if (event.payload.state === "archived" || event.payload.state === "closed") {
              liveRuntimeTaskIds.delete(event.threadId);
            }
          }
          scheduleRuntimeIdleStop(event.threadId, event.provider);
          return;
        case "session.exited":
          liveRuntimeTaskIds.delete(event.threadId);
          clearRuntimeIdleTimer(event.threadId);
          return;
        default:
          scheduleRuntimeIdleStop(event.threadId, event.provider);
      }
    };

    const commitRuntimeEvent = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<ProviderRuntimeEvent | null, unknown> =>
      Effect.uninterruptible(
        (options?.consumeRuntimeEvent
          ? options.consumeRuntimeEvent(event)
          : Effect.succeed<ProviderRuntimeEvent | null>(event)
        ).pipe(
          Effect.flatMap((admittedEvent) =>
            admittedEvent === null
              ? Effect.succeed(null)
              : (canonicalEventLogger
                  ? canonicalEventLogger.write(admittedEvent, null)
                  : Effect.void
                ).pipe(Effect.as(admittedEvent)),
          ),
        ),
      );

    const upsertSessionBinding = (
      session: ProviderSession,
      threadId: ThreadId,
      extra?: {
        readonly lifecycleGeneration?: string;
        readonly modelSelection?: unknown;
        readonly providerOptions?: unknown;
        readonly lastRuntimeEvent?: string;
        readonly lastRuntimeEventAt?: string;
        readonly managedIsolationKey?: string;
      },
    ) =>
      directory.upsert({
        threadId,
        provider: session.provider,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(extra?.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: extra.lifecycleGeneration }
          : {}),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });

    const markThreadStopped = (
      threadId: ThreadId,
      stoppedAt: string,
      lifecycleGeneration: string,
      session?: ProviderSession,
    ): Effect.Effect<void, ProviderSessionDirectoryWriteError> =>
      session
        ? directory.upsert({
            threadId,
            provider: session.provider,
            runtimeMode: session.runtimeMode,
            status: "stopped",
            lifecycleGeneration,
            ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
            runtimePayload: {
              ...toRuntimePayloadFromSession(session, {
                lastRuntimeEvent: "provider.stopAll",
                lastRuntimeEventAt: stoppedAt,
                lifecycleGeneration,
              }),
              activeTurnId: null,
            },
          })
        : directory.getProvider(threadId).pipe(
            Effect.flatMap((provider) =>
              directory.upsert({
                threadId,
                provider,
                status: "stopped",
                lifecycleGeneration,
                runtimePayload: {
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.stopAll",
                  lastRuntimeEventAt: stoppedAt,
                  lifecycleGeneration,
                },
              }),
            ),
          );

    // Runtime events are where adapters surface provider-native ids; refresh
    // from the live session before idle stop/recovery freezes an old cursor.
    const refreshResumeCursorFromActiveSession = (
      event: ProviderRuntimeEvent,
      binding: ProviderRuntimeBinding,
    ): Effect.Effect<unknown | null | undefined> => {
      if (!shouldRefreshResumeCursorForEvent(event)) {
        return Effect.succeed(binding.resumeCursor);
      }

      return Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(binding.provider);
        const sessions = yield* adapter.listSessions();
        const activeSession = sessions.find((session) => session.threadId === event.threadId);
        if (activeSession === undefined || activeSession.resumeCursor === undefined) {
          return binding.resumeCursor;
        }
        // `null` is the adapter's explicit invalidation tombstone. It must not
        // be replaced by the older persisted cursor.
        return activeSession.resumeCursor;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.resume_cursor_refresh_failed", {
            threadId: event.threadId,
            provider: binding.provider,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(binding.resumeCursor)),
        ),
      );
    };

    // Turn ids whose terminal runtime event has already been observed, keyed by
    // thread. sendTurn consults this immediately before its post-dispatch
    // "running" upsert: a turn that settles before that write lands (e.g. a
    // pre-start cancellation) must not be re-marked as running afterwards.
    // A single slot per thread is not enough — sendTurn is not serialized per
    // thread, so overlapping sends can both settle pre-write and the second
    // completion would evict the first turn's marker before its send checked
    // it. Markers are retained only while dispatches are in flight, and each
    // sendTurn consumes its own marker.
    const recentlyCompletedTurnsByThread = new Map<ThreadId, Set<string>>();
    const recordRecentlyCompletedTurn = (threadId: ThreadId, turnId: string): void => {
      let turns = recentlyCompletedTurnsByThread.get(threadId);
      if (turns === undefined) {
        turns = new Set();
        recentlyCompletedTurnsByThread.set(threadId, turns);
      }
      turns.delete(turnId);
      turns.add(turnId);
    };
    const consumeRecentlyCompletedTurn = (threadId: ThreadId, turnId: string): boolean => {
      const turns = recentlyCompletedTurnsByThread.get(threadId);
      if (turns === undefined || !turns.has(turnId)) {
        return false;
      }
      turns.delete(turnId);
      if (turns.size === 0) {
        recentlyCompletedTurnsByThread.delete(threadId);
      }
      return true;
    };

    // Serializes binding writes for a thread between the runtime-event handler
    // and sendTurn's post-dispatch write. Without it a terminal event could
    // land between sendTurn's settled-turn check and its "running" upsert and
    // still be overwritten. Lifecycle events are low-frequency, so a per-thread
    // mutex adds no meaningful contention. Creation is synchronous
    // (Semaphore.makeUnsafe), so concurrent callers cannot mint two locks.
    const withBindingWriteLock = makeKeyedThreadLock();
    // Canonical native writes and retirement share one per-thread boundary.
    // Observer backpressure stays outside it so a slow client cannot hold stop.
    const withNativeCommitLock = makeKeyedThreadLock();

    interface StartedTurnPersistenceInput {
      readonly threadId: ThreadId;
      readonly provider: ProviderRuntimeBinding["provider"];
      readonly turnId: string;
      readonly generation: number;
      readonly resumeCursor?: unknown;
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent: string;
    }
    interface ThreadDispatchState {
      nextGeneration: number;
      latestGeneration: number;
      ownerGeneration: number;
      readonly inFlightGenerations: Set<number>;
      readonly outstandingTurnIds: Set<string>;
      readonly successfulResults: Map<number, StartedTurnPersistenceInput>;
    }
    const dispatchStateByThread = new Map<ThreadId, ThreadDispatchState>();
    const getDispatchState = (threadId: ThreadId): ThreadDispatchState => {
      let state = dispatchStateByThread.get(threadId);
      if (!state) {
        state = {
          nextGeneration: 0,
          latestGeneration: 0,
          ownerGeneration: 0,
          inFlightGenerations: new Set(),
          outstandingTurnIds: new Set(),
          successfulResults: new Map(),
        };
        dispatchStateByThread.set(threadId, state);
      }
      return state;
    };
    const beginTurnDispatch = (threadId: ThreadId): number => {
      const state = getDispatchState(threadId);
      const generation = state.nextGeneration + 1;
      state.nextGeneration = generation;
      state.latestGeneration = generation;
      state.inFlightGenerations.add(generation);
      return generation;
    };
    const cleanupDispatchState = (threadId: ThreadId): void => {
      const state = dispatchStateByThread.get(threadId);
      if (
        state &&
        state.inFlightGenerations.size === 0 &&
        state.outstandingTurnIds.size === 0 &&
        state.successfulResults.size === 0
      ) {
        dispatchStateByThread.delete(threadId);
      }
    };
    const rememberSuccessfulTurnDispatch = (input: StartedTurnPersistenceInput): void => {
      const state = getDispatchState(input.threadId);
      state.outstandingTurnIds.add(input.turnId);
      state.successfulResults.set(input.generation, input);
    };
    const hasAmbiguousTerminalTurn = (threadId: ThreadId): boolean => {
      const state = dispatchStateByThread.get(threadId);
      return (
        state !== undefined &&
        (state.outstandingTurnIds.size > 1 ||
          state.inFlightGenerations.size > 1 ||
          (state.outstandingTurnIds.size > 0 && state.inFlightGenerations.size > 0))
      );
    };

    const persistStartedTurn = (input: StartedTurnPersistenceInput) => {
      let persistenceAttempted = false;
      const rollbackFailedPersistence = Effect.sync(() => {
        if (!persistenceAttempted) return;
        const state = dispatchStateByThread.get(input.threadId);
        state?.successfulResults.delete(input.generation);
        state?.outstandingTurnIds.delete(input.turnId);
        cleanupDispatchState(input.threadId);
      });
      const markPersistenceSucceeded = (ownsLifecycle: boolean): void => {
        const state = getDispatchState(input.threadId);
        if (ownsLifecycle) state.ownerGeneration = input.generation;
        for (const generation of state.successfulResults.keys()) {
          if (generation <= input.generation) state.successfulResults.delete(generation);
        }
      };

      return withBindingWriteLock(
        input.threadId,
        Effect.gen(function* () {
          // Older successful results stay retained while newer invocations are
          // unresolved. If every newer generation fails, settlement promotes
          // the newest retained result through this same persistence path.
          if (getDispatchState(input.threadId).latestGeneration !== input.generation) {
            return;
          }
          const completedBeforePersistence = consumeRecentlyCompletedTurn(
            input.threadId,
            input.turnId,
          );
          if (completedBeforePersistence) {
            getDispatchState(input.threadId).outstandingTurnIds.delete(input.turnId);
          }
          persistenceAttempted = true;
          if (completedBeforePersistence) {
            // An existing row may already belong to a newer overlapping turn;
            // the delayed result must not overwrite any of its metadata. With
            // no row, preserve the live-fallback behavior by creating an
            // explicitly stopped binding from the settled dispatch result.
            if (Option.isSome(yield* directory.getBinding(input.threadId))) {
              markPersistenceSucceeded(false);
              return;
            }
            yield* directory.upsert({
              threadId: input.threadId,
              provider: input.provider,
              status: "stopped",
              ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
              ...(input.modelSelection !== undefined
                ? { runtimePayload: { modelSelection: input.modelSelection } }
                : {}),
            });
            markPersistenceSucceeded(false);
            return;
          }

          // Clear again under the binding lock. This orders active-turn writes
          // against terminal-event scheduling even if dispatch took long
          // enough for an older terminal event to arrive in the meantime.
          clearRuntimeIdleTimer(input.threadId);
          yield* directory.upsert({
            threadId: input.threadId,
            provider: input.provider,
            status: "running",
            ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
            runtimePayload: {
              ...(input.modelSelection !== undefined
                ? { modelSelection: input.modelSelection }
                : {}),
              activeTurnId: input.turnId,
              lastRuntimeEvent: input.lastRuntimeEvent,
              lastRuntimeEventAt: new Date().toISOString(),
            },
          });
          markPersistenceSucceeded(true);
        }),
      ).pipe(Effect.onError(() => rollbackFailedPersistence));
    };

    const finishTurnDispatch = (
      threadId: ThreadId,
      generation: number,
    ): Effect.Effect<void, ProviderSessionDirectoryWriteError> =>
      Effect.gen(function* () {
        const candidate = yield* Effect.sync(() => {
          const state = getDispatchState(threadId);
          state.inFlightGenerations.delete(generation);
          if (state.latestGeneration === generation && !state.successfulResults.has(generation)) {
            state.latestGeneration = Math.max(
              state.ownerGeneration,
              ...state.inFlightGenerations,
              ...state.successfulResults.keys(),
            );
          }
          return state.successfulResults.get(state.latestGeneration);
        });
        if (candidate !== undefined) {
          yield* persistStartedTurn(candidate);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const state = dispatchStateByThread.get(threadId);
            if (state?.inFlightGenerations.size === 0) {
              recentlyCompletedTurnsByThread.delete(threadId);
            }
            cleanupDispatchState(threadId);
          }),
        ),
      );

    const runTurnDispatch = <A, E, R>(
      threadId: ThreadId,
      dispatch: (generation: number) => Effect.Effect<A, E, R>,
    ) =>
      runIdleSensitiveProviderWork(
        threadId,
        Effect.suspend(() => {
          const generation = beginTurnDispatch(threadId);
          return dispatch(generation).pipe(
            Effect.ensuring(finishTurnDispatch(threadId, generation).pipe(Effect.ignore)),
          );
        }),
      );

    const updateSessionBindingFromRuntimeEvent = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<void> => {
      // Subagent-scoped events carry the parent thread id with the child
      // identity in providerRefs. Their turn/session lifecycle belongs to the
      // child thread and must not touch the parent binding — a stopped
      // subagent would otherwise clear the parent's active turn and break
      // main-thread interrupts for the rest of the turn.
      if (event.providerRefs?.providerParentThreadId !== undefined) {
        return Effect.void;
      }
      // A diagnostic does not end the active turn. Foreground RPC rejection
      // settles its own delivery; only an explicit terminal event owns lifecycle.
      if (event.type === "runtime.error" && !event.payload.terminal) {
        return Effect.void;
      }
      switch (event.type) {
        case "session.started":
        case "session.state.changed":
        case "thread.started":
        case "thread.state.changed":
        case "turn.started":
        case "turn.tasks.updated":
        case "model.rerouted":
        case "turn.completed":
        case "turn.aborted":
        case "session.exited":
        case "runtime.error":
          break;
        default:
          return Effect.sync(() => reconcileRuntimeIdleTimer(event));
      }

      return withBindingWriteLock(
        event.threadId,
        Effect.gen(function* () {
          if (event.type === "turn.started" && event.turnId !== undefined) {
            getDispatchState(event.threadId).outstandingTurnIds.add(String(event.turnId));
          }
          if (
            (event.type === "turn.completed" || event.type === "turn.aborted") &&
            event.turnId !== undefined &&
            (dispatchStateByThread.get(event.threadId)?.inFlightGenerations.size ?? 0) > 0
          ) {
            recordRecentlyCompletedTurn(event.threadId, String(event.turnId));
          }
          const binding = Option.getOrUndefined(yield* directory.getBinding(event.threadId));
          if (!binding) {
            reconcileRuntimeIdleTimer(event);
            return;
          }
          if (binding.provider !== event.provider) {
            return;
          }
          if (
            event.lifecycleGeneration !== undefined &&
            binding.lifecycleGeneration !== event.lifecycleGeneration
          ) {
            return;
          }

          const currentActiveTurnId = runtimeActiveTurnId(binding.runtimePayload);
          let resolvedTerminalTurnId: string | undefined;
          if (
            event.type === "turn.started" &&
            !isStartedTurnApplicable({
              activeTurnId: currentActiveTurnId,
              eventTurnId: event.turnId === undefined ? undefined : String(event.turnId),
            })
          ) {
            return;
          }
          if (event.type === "turn.completed" || event.type === "turn.aborted") {
            const applicability = classifyTerminalTurnApplicability({
              activeTurnId: currentActiveTurnId,
              eventTurnId: event.turnId === undefined ? undefined : String(event.turnId),
              hasAmbiguousTurns: hasAmbiguousTerminalTurn(event.threadId),
            });
            if (!applicability.applicable) {
              if (event.turnId !== undefined) {
                dispatchStateByThread
                  .get(event.threadId)
                  ?.outstandingTurnIds.delete(String(event.turnId));
                cleanupDispatchState(event.threadId);
              }
              if (applicability.reason === "ambiguous-missing-turn-id") {
                yield* Effect.logWarning("provider.session.ambiguous_terminal_event_ignored", {
                  threadId: event.threadId,
                  eventType: event.type,
                });
              }
              return;
            }
            resolvedTerminalTurnId = applicability.resolvedTurnId;
            if (event.turnId === undefined && applicability.resolvedTurnId !== undefined) {
              recordRecentlyCompletedTurn(event.threadId, applicability.resolvedTurnId);
            }
            if (applicability.resolvedTurnId !== undefined) {
              dispatchStateByThread
                .get(event.threadId)
                ?.outstandingTurnIds.delete(applicability.resolvedTurnId);
              cleanupDispatchState(event.threadId);
            }
          }
          const activeTurnId =
            event.type === "turn.started"
              ? (event.turnId ?? null)
              : event.type === "thread.state.changed" && event.payload.state === "compacted"
                ? (event.turnId ?? currentActiveTurnId)
                : event.type === "turn.completed" ||
                    event.type === "turn.aborted" ||
                    (event.type === "thread.state.changed" &&
                      (event.payload.state === "archived" ||
                        event.payload.state === "closed" ||
                        event.payload.state === "error")) ||
                    event.type === "session.exited" ||
                    event.type === "runtime.error" ||
                    (event.type === "session.state.changed" &&
                      (event.payload.state === "ready" ||
                        event.payload.state === "stopped" ||
                        event.payload.state === "error"))
                  ? null
                  : currentActiveTurnId;
          const lastError = runtimeLastErrorForEvent(event);
          const resumeCursor = yield* refreshResumeCursorFromActiveSession(event, binding);

          yield* directory.upsert({
            threadId: event.threadId,
            provider: binding.provider,
            ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
            ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
            status: runtimeStatusForEvent(event, activeTurnId),
            ...(resumeCursor !== undefined ? { resumeCursor } : {}),
            runtimePayload: {
              activeTurnId,
              lastRuntimeEvent: event.type,
              lastRuntimeEventAt: event.createdAt,
              ...(event.type === "turn.completed" || event.type === "turn.aborted"
                ? {
                    // Preserve terminal ownership after activeTurnId clears so
                    // inferred stale-state recovery cannot race the durable
                    // terminal event while ingestion is still projecting it.
                    lastTerminalEvent: event.type,
                    lastTerminalEventAt: event.createdAt,
                    lastTerminalTurnId: resolvedTerminalTurnId ?? null,
                    lastTerminalState:
                      event.type === "turn.completed" ? event.payload.state : "interrupted",
                  }
                : {}),
              ...(lastError !== undefined ? { lastError } : {}),
            },
          });
          if (resumeCursor !== undefined && options?.persistNativeResumeCursor !== undefined) {
            yield* options.persistNativeResumeCursor({
              threadId: event.threadId,
              provider: binding.provider,
              resumeCursor,
            });
          }
          if (event.type === "session.exited") {
            const dispatchState = dispatchStateByThread.get(event.threadId);
            if (dispatchState) {
              // Invalidate adapter calls that were already in flight when the
              // session exited, then retain only the generations needed for
              // their eventual settlement/cleanup.
              dispatchState.latestGeneration = dispatchState.nextGeneration + 1;
              dispatchState.nextGeneration = dispatchState.latestGeneration;
              dispatchState.outstandingTurnIds.clear();
              dispatchState.successfulResults.clear();
            }
            recentlyCompletedTurnsByThread.delete(event.threadId);
            cleanupDispatchState(event.threadId);
          }
          reconcileRuntimeIdleTimer(event);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.runtime_binding_update_failed", {
            threadId: event.threadId,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    };

    const providers = yield* registry.listProviders();
    const adapters = yield* Effect.forEach(providers, (provider) =>
      registry.getByProvider(provider),
    );
    const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void, unknown> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const admitted = yield* withNativeCommitLock(
            event.threadId,
            Effect.suspend(() => {
              if (
                event.lifecycleGeneration !== undefined &&
                lifecycle.currentGeneration(event.threadId) !== event.lifecycleGeneration
              ) {
                return Effect.logDebug("provider.session.stale_generation_event_ignored", {
                  threadId: event.threadId,
                  provider: event.provider,
                  eventType: event.type,
                  eventLifecycleGeneration: event.lifecycleGeneration,
                }).pipe(Effect.as(null));
              }
              const canonicalEvent = normalizeProviderRuntimeEvent(event);
              return Effect.sync(() => {
                // Child runtime events are attributed to the parent thread but do
                // not own its gateway session or turn.
                if (canonicalEvent.providerRefs?.providerParentThreadId === undefined) {
                  if (
                    canonicalEvent.type === "turn.started" &&
                    canonicalEvent.turnId !== undefined
                  ) {
                    agentGatewayCredentials?.beginTurn(
                      canonicalEvent.threadId,
                      canonicalEvent.provider,
                      String(canonicalEvent.turnId),
                      canonicalEvent.lifecycleGeneration,
                      "runtime-event",
                    );
                  } else if (
                    (canonicalEvent.type === "turn.completed" ||
                      canonicalEvent.type === "turn.aborted") &&
                    canonicalEvent.turnId !== undefined
                  ) {
                    agentGatewayCredentials?.endTurn(
                      canonicalEvent.threadId,
                      canonicalEvent.provider,
                      String(canonicalEvent.turnId),
                      canonicalEvent.lifecycleGeneration,
                    );
                  } else if (canonicalEvent.type === "session.exited") {
                    agentGatewayCredentials?.endSession(
                      canonicalEvent.threadId,
                      canonicalEvent.provider,
                      canonicalEvent.lifecycleGeneration,
                    );
                  }
                }
                if (canonicalEvent.type === "turn.started") {
                  reconcileRuntimeIdleTimer(canonicalEvent);
                }
              }).pipe(
                Effect.andThen(updateSessionBindingFromRuntimeEvent(canonicalEvent)),
                Effect.andThen(
                  canonicalEvent.providerRefs?.providerParentThreadId === undefined
                    ? lifecycle.observe(canonicalEvent)
                    : Effect.void,
                ),
                Effect.andThen(commitRuntimeEvent(canonicalEvent)),
              );
            }),
          );
          if (admitted !== null) yield* PubSub.publish(runtimeEventPubSub, admitted);
        }),
      );

    const processRuntimeEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
      Effect.gen(function* () {
        let index = 0;
        while (index < events.length) {
          const event = events[index]!;
          const current = (event: ProviderRuntimeEvent) =>
            event.lifecycleGeneration === undefined ||
            lifecycle.currentGeneration(event.threadId) === event.lifecycleGeneration;
          if (
            event.type !== "content.delta" ||
            !current(event) ||
            !options?.consumeRuntimeDeltaRun
          ) {
            yield* processRuntimeEvent(event);
            index++;
            continue;
          }
          const run: ProviderRuntimeEvent[] = [];
          while (index < events.length) {
            const next = events[index]!;
            if (next.type !== "content.delta" || !current(next)) break;
            run.push(normalizeProviderRuntimeEvent(next));
            index++;
          }
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const commit = Effect.gen(function* () {
                const admitted = run.filter(current);
                if (admitted.length !== 0) yield* options.consumeRuntimeDeltaRun!(admitted);
                for (const delta of admitted)
                  if (canonicalEventLogger) yield* canonicalEventLogger.write(delta, null);
                return admitted;
              });
              const threadIds = [...new Set(run.map((delta) => delta.threadId))].toSorted();
              const committed = yield* threadIds.reduceRight(
                (operation, threadId) => withNativeCommitLock(threadId, operation),
                commit,
              );
              for (const delta of committed) yield* PubSub.publish(runtimeEventPubSub, delta);
            }),
          );
        }
      });

    // The provider stream itself is the completion boundary. A failed canonical
    // write fails the consumer; there is no journal replay, retry or quarantine.
    yield* Effect.forEach(adapters, (adapter) =>
      Stream.runForEachArray(adapter.streamEvents, processRuntimeEvents).pipe(
        Effect.orDie,
        Effect.forkIn(runtimeEventProducerScope),
      ),
    ).pipe(Effect.asVoid);

    const recoverSessionForThread = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly operation: string;
    }) =>
      lifecycle.ensure(input.binding.threadId, input.binding.provider, (lease) =>
        Effect.gen(function* () {
          const binding = Option.getOrUndefined(
            yield* directory.getBinding(input.binding.threadId),
          );
          if (!binding) {
            return yield* toValidationError(
              input.operation,
              `Cannot recover thread '${input.binding.threadId}' because its provider binding was removed.`,
            );
          }
          const adapter = yield* registry.getByProvider(binding.provider);
          const hasPersistedResumeCursor = hasResumeCursor(binding.resumeCursor);
          const hasActiveSession = yield* adapter.hasSession(binding.threadId);
          const managedLaunch = options?.resolveManagedLaunch
            ? yield* options
                .resolveManagedLaunch({
                  threadId: binding.threadId,
                  provider: binding.provider,
                })
                .pipe(Effect.mapError(mapManagedLaunchError(input.operation)))
            : undefined;
          if (hasActiveSession) {
            const activeTurnId = runtimeActiveTurnId(binding.runtimePayload);
            const persistedIsolationKey = readPersistedManagedIsolationKey(binding.runtimePayload);
            if (
              managedLaunch !== undefined &&
              shouldRestartForManagedIsolationChange({
                persistedIsolationKey,
                currentIsolationKey: managedLaunch.isolationKey,
                activeTurnId,
              })
            ) {
              yield* lifecycle.dispose(adapter, binding.threadId, "selection-change");
            } else {
              const activeSessions = yield* adapter.listSessions();
              const existing = activeSessions.find(
                (session) => session.threadId === binding.threadId,
              );
              if (existing) {
                lease.adopt(binding.lifecycleGeneration ?? "legacy");
                yield* lifecycle.adoptSession(existing);
                yield* analytics.record("provider.session.recovered", {
                  provider: existing.provider,
                  strategy: "adopt-existing",
                  hasResumeCursor: hasResumeCursor(existing.resumeCursor),
                });
                return adapter;
              }
            }
          }

          if (!hasPersistedResumeCursor) {
            return yield* toValidationError(
              input.operation,
              `Cannot recover thread '${binding.threadId}' because no provider resume state is persisted.`,
            );
          }

          const persistedCwd = readPersistedCwd(binding.runtimePayload);
          const persistedModelSelection = readPersistedModelSelection(binding.runtimePayload);
          const persistedProviderOptions = readPersistedProviderOptions(binding.runtimePayload);
          const resumed = yield* lifecycle.startNative(adapter, {
            threadId: binding.threadId,
            provider: binding.provider,
            lifecycleGeneration: lease.generation,
            ...(persistedCwd ? { cwd: persistedCwd } : {}),
            ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
            ...(persistedProviderOptions ? { providerOptions: persistedProviderOptions } : {}),
            ...(managedLaunch ? { managedLaunch } : {}),
            ...(hasPersistedResumeCursor ? { resumeCursor: binding.resumeCursor } : {}),
            runtimeMode: binding.runtimeMode ?? "full-access",
          });
          if (resumed.provider !== adapter.provider) {
            return yield* toValidationError(
              input.operation,
              `Adapter/provider mismatch while recovering thread '${binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
            );
          }

          yield* withBindingWriteLock(
            binding.threadId,
            upsertSessionBinding(resumed, binding.threadId, {
              lifecycleGeneration: lease.generation,
              ...(managedLaunch === undefined
                ? {}
                : { managedIsolationKey: managedLaunch.isolationKey }),
            }),
          );
          lease.commit();
          yield* analytics.record("provider.session.recovered", {
            provider: resumed.provider,
            strategy: "resume-thread",
            hasResumeCursor: hasResumeCursor(resumed.resumeCursor),
          });
          return adapter;
        }),
      );

    const findLiveSessionAdapter = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const matches = yield* Effect.forEach(
          adapters,
          (adapter) =>
            adapter.hasSession(threadId).pipe(
              Effect.map((hasSession) => (hasSession ? adapter : null)),
              Effect.orElseSucceed(() => null),
            ),
          { concurrency: "unbounded" },
        );
        return matches.find((adapter) => adapter !== null) ?? null;
      });

    const resolveRoutableSession = (input: {
      readonly threadId: ThreadId;
      readonly operation: string;
      readonly allowRecovery: boolean;
      readonly missingBindingFailureCode?: typeof PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE;
    }) =>
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        if (!binding) {
          // Startup extension prompts can fire before startSession has persisted
          // the provider binding, but the adapter already owns a live session.
          const liveAdapter = yield* findLiveSessionAdapter(input.threadId);
          if (liveAdapter) {
            return {
              adapter: liveAdapter,
              isActive: true,
              lifecycleGeneration: lifecycle.currentGeneration(input.threadId),
            } as const;
          }
          return yield* toValidationError(
            input.operation,
            `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
            undefined,
            input.missingBindingFailureCode,
          );
        }
        const adapter = yield* registry.getByProvider(binding.provider);

        if (yield* adapter.hasSession(input.threadId)) {
          return {
            adapter,
            isActive: true,
            lifecycleGeneration: binding.lifecycleGeneration,
          } as const;
        }

        if (!input.allowRecovery) {
          return {
            adapter,
            isActive: false,
            lifecycleGeneration: binding.lifecycleGeneration,
          } as const;
        }

        return {
          adapter: yield* recoverSessionForThread({
            binding,
            operation: input.operation,
          }),
          isActive: true,
          lifecycleGeneration: lifecycle.currentGeneration(input.threadId),
        } as const;
      });

    const isRoutable: ProviderServiceShape["isRoutable"] = (threadId) =>
      Effect.gen(function* () {
        const binding = yield* directory.getBinding(threadId);
        if (Option.isNone(binding)) return (yield* findLiveSessionAdapter(threadId)) !== null;
        const adapter = yield* registry.getByProvider(binding.value.provider);
        return yield* adapter.hasSession(threadId);
      });

    const ensure: ProviderServiceShape["ensure"] = (threadId, rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.ensure",
          schema: ProviderSessionStartInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          threadId,
          provider: parsed.provider ?? "codex",
        };
        clearRuntimeIdleTimer(threadId);
        yield* waitForRuntimeIdleStop(threadId);
        return yield* lifecycle.ensure(threadId, input.provider, (lease) =>
          Effect.gen(function* () {
            const managedLaunch =
              rawInput.managedLaunch ??
              (options?.resolveManagedLaunch
                ? yield* options
                    .resolveManagedLaunch({ threadId, provider: input.provider })
                    .pipe(Effect.mapError(mapManagedLaunchError("ProviderService.ensure")))
                : undefined);
            const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
            const effectiveResumeCursor =
              rawInput.resumePolicy === "fresh"
                ? undefined
                : (input.resumeCursor ??
                  (persistedBinding?.provider === input.provider
                    ? persistedBinding.resumeCursor
                    : undefined));
            const effectiveProviderOptions =
              input.providerOptions ??
              (persistedBinding?.provider === input.provider
                ? readPersistedProviderOptions(persistedBinding.runtimePayload)
                : undefined);
            const adapter = yield* registry.getByProvider(input.provider);
            let replacementStarted = false;
            const startAndPersistReplacement = Effect.gen(function* () {
              const session = yield* lifecycle.startNative(adapter, {
                ...input,
                ...(managedLaunch !== undefined ? { managedLaunch } : {}),
                lifecycleGeneration: lease.generation,
                ...(effectiveProviderOptions !== undefined
                  ? { providerOptions: effectiveProviderOptions }
                  : {}),
                ...(effectiveResumeCursor !== undefined
                  ? { resumeCursor: effectiveResumeCursor }
                  : {}),
              });
              replacementStarted = true;

              if (session.provider !== adapter.provider) {
                return yield* toValidationError(
                  "ProviderService.ensure",
                  `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
                );
              }

              yield* withBindingWriteLock(
                threadId,
                upsertSessionBinding(session, threadId, {
                  modelSelection: input.modelSelection,
                  providerOptions: effectiveProviderOptions,
                  lifecycleGeneration: lease.generation,
                  ...(managedLaunch === undefined
                    ? {}
                    : { managedIsolationKey: managedLaunch.isolationKey }),
                }),
              );
              if (
                session.resumeCursor !== undefined &&
                options?.persistNativeResumeCursor !== undefined
              ) {
                yield* options
                  .persistNativeResumeCursor({
                    threadId,
                    provider: session.provider,
                    resumeCursor: session.resumeCursor,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderValidationError({
                          operation: "ProviderService.ensure",
                          issue: "Could not persist the exact provider-native session state.",
                          cause,
                        }),
                    ),
                  );
              }
              lease.commit();
              yield* analytics.record("provider.session.started", {
                provider: session.provider,
                runtimeMode: input.runtimeMode,
                hasResumeCursor: hasResumeCursor(session.resumeCursor),
                hasCwd: typeof input.cwd === "string" && input.cwd.trim().length > 0,
                hasModel:
                  typeof input.modelSelection?.model === "string" &&
                  input.modelSelection.model.trim().length > 0,
              });

              return session;
            }).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) && replacementStarted
                  ? lifecycle
                      .dispose(adapter, threadId, null)
                      .pipe(
                        Effect.andThen(
                          withBindingWriteLock(
                            threadId,
                            removeBinding(
                              threadId,
                              "replacement-failed",
                              "session replacement failed",
                            ),
                          ),
                        ),
                        Effect.andThen(Effect.sync(lease.retire)),
                      )
                  : Effect.void,
              ),
            );

            if (!persistedBinding || persistedBinding.provider === input.provider) {
              return yield* startAndPersistReplacement;
            }

            if (options?.resolveManagedLaunch) {
              return yield* toValidationError(
                "ProviderService.ensure",
                "This thread uses a different provider. To use another provider, start a new thread.",
              );
            }

            const previousAdapter = yield* registry.getByProvider(persistedBinding.provider);
            if (!(yield* previousAdapter.hasSession(threadId))) {
              return yield* startAndPersistReplacement;
            }

            yield* lifecycle.dispose(previousAdapter, threadId, "selection-change");
            yield* withBindingWriteLock(
              threadId,
              directory.upsert({
                ...persistedBinding,
                status: "stopped",
                lifecycleGeneration: lease.generation,
                runtimePayload: {
                  ...runtimePayloadRecord(persistedBinding.runtimePayload),
                  activeTurnId: null,
                },
              }),
            );
            lease.commit();
            return yield* startAndPersistReplacement;
          }),
        );
      });

    const sendTurn: ProviderServiceShape["sendTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.sendTurn",
          schema: ProviderSendTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: carryProviderAttachmentPaths(rawInput, parsed.attachments ?? []),
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "Either input text or at least one attachment is required",
          );
        }
        return yield* runTurnDispatch(input.threadId, (generation) =>
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.sendTurn",
              allowRecovery: true,
            });
            const turn = yield* routed.adapter.sendTurn(input);
            const persistenceInput: StartedTurnPersistenceInput = {
              threadId: input.threadId,
              provider: routed.adapter.provider,
              turnId: String(turn.turnId),
              generation,
              ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
              ...(input.modelSelection !== undefined
                ? { modelSelection: input.modelSelection }
                : {}),
              lastRuntimeEvent: "provider.sendTurn",
            };
            rememberSuccessfulTurnDispatch(persistenceInput);
            // A turn can settle before this write lands (e.g. a pre-start
            // cancellation completes inside the adapter fork); re-marking the
            // thread as running then would strand it with a stale active turn.
            // Durable metadata (model selection, resume cursor) is still
            // persisted — status stays untouched (upsert keeps the existing
            // value when omitted) and runtimePayload merges per key. The
            // binding-write lock makes the check and the write atomic with the
            // runtime-event handler, so a terminal event cannot slip between
            // them and then be overwritten.
            yield* persistStartedTurn(persistenceInput);
            yield* analytics.record("provider.turn.sent", {
              provider: routed.adapter.provider,
              model: input.modelSelection?.model,
              attachmentCount: input.attachments.length,
              hasInput: typeof input.input === "string" && input.input.trim().length > 0,
            });
            return turn;
          }),
        );
      });

    const steerTurn: ProviderServiceShape["steerTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.steerTurn",
          schema: ProviderSteerTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: carryProviderAttachmentPaths(rawInput, parsed.attachments ?? []),
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.steerTurn",
            "Either input text or at least one attachment is required",
          );
        }
        return yield* runTurnDispatch(input.threadId, (generation) =>
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.steerTurn",
              allowRecovery: true,
            });
            if (
              !routed.adapter.steerTurn ||
              routed.adapter.capabilities.supportsTurnSteering !== true
            ) {
              return yield* toValidationError(
                "ProviderService.steerTurn",
                `Provider '${routed.adapter.provider}' does not support steering an active turn.`,
              );
            }
            const turn = yield* routed.adapter.steerTurn(input);
            const persistenceInput: StartedTurnPersistenceInput = {
              threadId: input.threadId,
              provider: routed.adapter.provider,
              turnId: String(turn.turnId),
              generation,
              ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
              ...(input.modelSelection !== undefined
                ? { modelSelection: input.modelSelection }
                : {}),
              lastRuntimeEvent: "provider.steerTurn",
            };
            rememberSuccessfulTurnDispatch(persistenceInput);
            yield* persistStartedTurn(persistenceInput);
            yield* analytics.record("provider.turn.steered", {
              provider: routed.adapter.provider,
              model: input.modelSelection?.model,
              attachmentCount: input.attachments.length,
              hasInput: typeof input.input === "string" && input.input.trim().length > 0,
            });
            return turn;
          }),
        );
      });

    const startReview: ProviderServiceShape["startReview"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.startReview",
          schema: ProviderStartReviewInput,
          payload: rawInput,
        });

        return yield* runTurnDispatch(input.threadId, (generation) =>
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.startReview",
              allowRecovery: true,
            });
            if (!routed.adapter.startReview) {
              return yield* toValidationError(
                "ProviderService.startReview",
                `Provider '${routed.adapter.provider}' does not support native review.`,
              );
            }

            const turn = yield* routed.adapter.startReview(input);
            const persistenceInput: StartedTurnPersistenceInput = {
              threadId: input.threadId,
              provider: routed.adapter.provider,
              turnId: String(turn.turnId),
              generation,
              ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
              lastRuntimeEvent: "provider.startReview",
            };
            rememberSuccessfulTurnDispatch(persistenceInput);
            yield* persistStartedTurn(persistenceInput);
            yield* analytics.record("provider.review.started", {
              provider: routed.adapter.provider,
              target: input.target.type,
            });
            return turn;
          }),
        );
      });

    const interruptTurn: ProviderServiceShape["interruptTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.interruptTurn",
          schema: ProviderInterruptTurnInput,
          payload: rawInput,
        });
        // Urgent: an interrupt is the user's only escape hatch from a wedged
        // turn, so it must not queue behind a lifecycle mutation that hangs.
        return yield* lifecycle.interrupt(input.threadId, (currentGeneration) =>
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.interruptTurn",
              allowRecovery: false,
            });
            if (!routed.isActive) {
              return yield* toValidationError(
                "ProviderService.interruptTurn",
                `Cannot interrupt thread '${input.threadId}' because its provider runtime is not active.`,
              );
            }

            const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
            if (!binding) {
              return yield* toValidationError(
                "ProviderService.interruptTurn",
                `Cannot interrupt thread '${input.threadId}' without a persisted provider binding.`,
              );
            }
            const bindingGeneration = binding.lifecycleGeneration ?? currentGeneration;
            if (
              currentGeneration !== undefined &&
              bindingGeneration !== undefined &&
              bindingGeneration !== currentGeneration
            ) {
              return yield* toValidationError(
                "ProviderService.interruptTurn",
                `Cannot interrupt stale provider generation '${bindingGeneration}' for thread '${input.threadId}'.`,
              );
            }

            const providerTurnId = runtimeActiveTurnId(binding.runtimePayload);
            if (providerTurnId === undefined) {
              return yield* toValidationError(
                "ProviderService.interruptTurn",
                `Cannot interrupt thread '${input.threadId}' because no exact active provider turn is bound.`,
              );
            }
            if (input.turnId !== undefined && input.turnId !== providerTurnId) {
              yield* Effect.logWarning(
                "provider interrupt received stale projection turn; using authoritative active turn",
                {
                  threadId: input.threadId,
                  requestedTurnId: input.turnId,
                  activeTurnId: providerTurnId,
                  provider: routed.adapter.provider,
                },
              );
            }

            yield* routed.adapter.interruptTurn(input.threadId, TurnId.make(providerTurnId));
            yield* analytics.record("provider.turn.interrupted", {
              provider: routed.adapter.provider,
            });
          }),
        );
      });

    const stopTask: ProviderServiceShape["stopTask"] = (rawInput) =>
      decodeInputOrValidationError({
        operation: "ProviderService.stopTask",
        schema: ProviderStopTaskInput,
        payload: rawInput,
      }).pipe(
        Effect.flatMap((input) =>
          lifecycle.withCurrent(input.threadId, () =>
            Effect.gen(function* () {
              const routed = yield* resolveRoutableSession({
                threadId: input.threadId,
                operation: "ProviderService.stopTask",
                allowRecovery: false,
              });
              if (!routed.isActive) {
                return yield* toValidationError(
                  "ProviderService.stopTask",
                  `Cannot stop provider task '${input.taskId}' because the provider runtime is not active.`,
                );
              }
              if (!routed.adapter.stopTask) {
                return yield* toValidationError(
                  "ProviderService.stopTask",
                  `Provider '${routed.adapter.provider}' does not support stopping a provider task.`,
                );
              }
              yield* routed.adapter.stopTask(input.threadId, input.taskId);
              yield* analytics.record("provider.task.stopped", {
                provider: routed.adapter.provider,
              });
            }),
          ),
        ),
      );

    const backgroundTask: ProviderServiceShape["backgroundTask"] = (rawInput) =>
      decodeInputOrValidationError({
        operation: "ProviderService.backgroundTask",
        schema: ProviderBackgroundTaskInput,
        payload: rawInput,
      }).pipe(
        Effect.flatMap((input) =>
          lifecycle.withCurrent(input.threadId, () =>
            Effect.gen(function* () {
              const routed = yield* resolveRoutableSession({
                threadId: input.threadId,
                operation: "ProviderService.backgroundTask",
                allowRecovery: false,
              });
              if (!routed.isActive) {
                return yield* toValidationError(
                  "ProviderService.backgroundTask",
                  `Cannot background provider task '${input.toolUseId}' because the provider runtime is not active.`,
                );
              }
              if (!routed.adapter.backgroundTask) {
                return yield* toValidationError(
                  "ProviderService.backgroundTask",
                  `Provider '${routed.adapter.provider}' does not support backgrounding a provider task.`,
                );
              }
              yield* routed.adapter.backgroundTask(input.threadId, input.toolUseId);
              yield* analytics.record("provider.task.backgrounded", {
                provider: routed.adapter.provider,
              });
            }),
          ),
        ),
      );

    const respondToUserInput: ProviderServiceShape["respondToUserInput"] = (rawInput) => {
      const operation = "ProviderService.respondToUserInput";
      return decodeInputOrValidationError({
        operation,
        schema: ProviderRespondToUserInputInput,
        payload: rawInput,
      }).pipe(
        Effect.flatMap((input) =>
          lifecycle.withCurrent(input.threadId, (currentGeneration) =>
            Effect.gen(function* () {
              const routed = yield* resolveRoutableSession({
                threadId: input.threadId,
                operation,
                allowRecovery: false,
                missingBindingFailureCode: PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE,
              });
              if (!routed.isActive) {
                return yield* toValidationError(
                  operation,
                  `Cannot respond to request '${input.requestId}' because the provider runtime is not active.`,
                  undefined,
                  PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE,
                );
              }
              const routedGeneration = routed.lifecycleGeneration ?? currentGeneration;
              if (
                routedGeneration !== undefined &&
                routedGeneration !== "legacy" &&
                input.lifecycleGeneration === undefined
              ) {
                return yield* toValidationError(
                  operation,
                  `Cannot respond to request '${input.requestId}' without its provider lifecycle generation.`,
                );
              }
              if (
                input.lifecycleGeneration !== undefined &&
                input.lifecycleGeneration !== routedGeneration
              ) {
                return yield* toValidationError(
                  operation,
                  `Cannot respond to stale request '${input.requestId}' from provider generation '${input.lifecycleGeneration}'.`,
                  undefined,
                  PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE,
                );
              }
              yield* routed.adapter.respondToUserInput(
                input.threadId,
                input.requestId,
                input.answers,
              );
            }),
          ),
        ),
      );
    };

    const stop: ProviderServiceShape["stop"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stop",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        yield* waitForRuntimeIdleStop(input.threadId);
        clearRuntimeIdleTimer(input.threadId);
        return yield* lifecycle.stop(input.threadId, rawInput.reason, (lease) =>
          Effect.gen(function* () {
            const binding = yield* directory.getBinding(input.threadId);
            const adapter = Option.isSome(binding)
              ? yield* registry.getByProvider(binding.value.provider)
              : yield* findLiveSessionAdapter(input.threadId);
            if (adapter === null) {
              liveRuntimeTaskIds.delete(input.threadId);
              lease.retire();
              return;
            }
            // Adapter stop is an idempotent cleanup barrier. Even when the
            // routable session is inactive, the adapter may retain ownership
            // from a teardown whose exit proof previously failed.
            yield* lifecycle.dispose(adapter, input.threadId, rawInput.reason);
            liveRuntimeTaskIds.delete(input.threadId);
            yield* waitForRuntimeIdleStop(input.threadId);
            yield* withBindingWriteLock(
              input.threadId,
              removeBinding(input.threadId, "stop", rawInput.reason),
            );
            lease.retire();
            yield* analytics.record("provider.session.stopped", {
              provider: adapter.provider,
            });
          }),
        );
      });

    const stopConnection: ProviderServiceShape["stopConnection"] = (connectionId, provider) =>
      Effect.gen(function* () {
        const threadIds = lifecycle.threadsForConnection(connectionId);
        const exits = yield* Effect.forEach(
          threadIds,
          (threadId) =>
            Effect.exit(
              lifecycle
                .cancelStart(threadId, "connection-removed")
                .pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      lifecycle.ownsConnection(threadId, connectionId)
                        ? stop({ threadId, reason: "connection-removed" })
                        : Effect.void,
                    ),
                  ),
                ),
            ),
          { concurrency: "unbounded" },
        );
        const adapter = yield* registry.getByProvider(provider);
        const process = yield* Effect.exit(lifecycle.closeAccount(adapter, connectionId));
        let failure: Cause.Cause<ProviderServiceError> | undefined;
        for (const exit of [...exits, process])
          if (Exit.isFailure(exit))
            failure = failure === undefined ? exit.cause : Cause.combine(failure, exit.cause);
        if (failure !== undefined) return yield* Effect.failCause(failure);
      });

    const stopRuntimeSessionInternal = (
      rawInput: StopRuntimeSessionInput,
      reason: "user-stop" | "idle" = "user-stop",
    ): StopRuntimeSessionEffect =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopRuntimeSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        if (reason !== "idle") {
          clearRuntimeIdleTimer(input.threadId);
          yield* waitForRuntimeIdleStop(input.threadId);
        } else if (lifecycle.state(input.threadId) !== "ready") return;
        const expectedGeneration = lifecycle.currentGeneration(input.threadId);
        return yield* lifecycle.stop(input.threadId, reason, (lease) =>
          Effect.gen(function* () {
            if (
              reason === "idle" &&
              lifecycle.currentGeneration(input.threadId) !== expectedGeneration
            )
              return;
            const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
            if (!binding) return;
            const adapter = yield* registry.getByProvider(binding.provider);
            const hasActiveSession = yield* adapter.hasSession(input.threadId);
            if (reason === "idle") {
              const session = (yield* adapter.listSessions()).find(
                (entry) => entry.threadId === input.threadId,
              );
              const payload = runtimePayloadRecord(binding.runtimePayload);
              if (
                !session ||
                session.activeTurnId !== undefined ||
                payload.activeTurnId != null ||
                (liveRuntimeTaskIds.get(input.threadId)?.size ?? 0) > 0 ||
                (!hasResumeCursor(session.resumeCursor) && !hasResumeCursor(binding.resumeCursor))
              )
                return;
              if (
                options?.canIdleStop &&
                !(yield* options.canIdleStop(input.threadId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderValidationError({
                        operation: "ThreadRuntime.idle",
                        issue: "Could not establish canonical idle eligibility.",
                        cause,
                      }),
                  ),
                ))
              )
                return;
            }
            if (hasActiveSession) yield* lifecycle.dispose(adapter, input.threadId, reason);
            liveRuntimeTaskIds.delete(input.threadId);
            yield* withBindingWriteLock(
              input.threadId,
              directory.upsert({
                threadId: input.threadId,
                provider: binding.provider,
                ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
                ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
                status: "stopped",
                lifecycleGeneration: lease.generation,
                resumeCursor: binding.resumeCursor,
                runtimePayload: {
                  ...runtimePayloadRecord(binding.runtimePayload),
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.stopRuntimeSession",
                  lastRuntimeEventAt: new Date().toISOString(),
                  lifecycleGeneration: lease.generation,
                },
              }),
            );
            lease.commit();
            yield* analytics.record("provider.session.runtime_stopped", {
              provider: binding.provider,
            });
          }),
        );
      });

    const stopRuntimeSession: StopRuntimeSession = (rawInput) =>
      stopRuntimeSessionInternal(rawInput);
    const hasLiveRuntimeTasks: NonNullable<ProviderServiceShape["hasLiveRuntimeTasks"]> = (input) =>
      Effect.sync(() => (liveRuntimeTaskIds.get(input.threadId)?.size ?? 0) > 0);
    const stopIdleRuntimeSession = (threadId: ThreadId): Effect.Effect<void> =>
      stopRuntimeSessionInternal({ threadId }, "idle").pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.idle_stop_failed", { threadId, cause }),
        ),
      );

    const clearSessionResumeCursor: NonNullable<
      ProviderServiceShape["clearSessionResumeCursor"]
    > = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.clearSessionResumeCursor",
          schema: ClearSessionResumeCursorInput,
          payload: rawInput,
        });
        yield* waitForRuntimeIdleStop(input.threadId);
        clearRuntimeIdleTimer(input.threadId);
        // Share the runtime-event binding lock so a delayed session.exited
        // update cannot restore the stale cursor after this explicit clear.
        const clearedProvider = yield* lifecycle.stop(input.threadId, "user-stop", (lease) =>
          Effect.gen(function* () {
            const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
            if (!binding) {
              return undefined;
            }
            const adapter = yield* registry.getByProvider(binding.provider);
            const hasActiveSession = yield* adapter.hasSession(input.threadId);
            const preserveActive = hasActiveSession && input.preserveActiveRuntime === true;
            if (hasActiveSession && !preserveActive) {
              yield* lifecycle.dispose(adapter, input.threadId, "user-stop");
            }
            return yield* withNativeCommitLock(
              input.threadId,
              withBindingWriteLock(
                input.threadId,
                Effect.gen(function* () {
                  if (!preserveActive) {
                    liveRuntimeTaskIds.delete(input.threadId);
                  }
                  // A preserved runtime keeps stamping its events with the
                  // generation it was started under, so clearing the cursor must
                  // not re-label the thread with a generation that runtime will
                  // never emit.
                  const effectiveGeneration = preserveActive
                    ? (binding.lifecycleGeneration ?? lease.generation)
                    : lease.generation;
                  yield* directory.upsert({
                    threadId: input.threadId,
                    provider: binding.provider,
                    ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
                    ...(binding.runtimeMode !== undefined
                      ? { runtimeMode: binding.runtimeMode }
                      : {}),
                    status: preserveActive ? (binding.status ?? "running") : "stopped",
                    lifecycleGeneration: effectiveGeneration,
                    resumeCursor: null,
                    runtimePayload: {
                      ...runtimePayloadRecord(binding.runtimePayload),
                      ...(preserveActive ? {} : { activeTurnId: null }),
                      lifecycleGeneration: effectiveGeneration,
                    },
                  });
                  lease.adopt(effectiveGeneration);
                  return binding.provider;
                }),
              ),
            );
          }),
        );
        yield* waitForRuntimeIdleStop(input.threadId);
        if (clearedProvider !== undefined) {
          yield* analytics.record("provider.session.resume_cursor_cleared", {
            provider: clearedProvider,
          });
        }
      });

    const listSessions: ProviderServiceShape["listSessions"] = () =>
      Effect.gen(function* () {
        const activeSessions = (yield* Effect.forEach(adapters, (adapter) =>
          adapter.listSessions(),
        )).flatMap((sessions) => sessions);
        const persistedBindings = yield* directory.listThreadIds().pipe(
          Effect.flatMap((threadIds) =>
            Effect.forEach(
              threadIds,
              (threadId) =>
                directory
                  .getBinding(threadId)
                  .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
        );
        const bindingsByThreadId = new Map(
          EffectArray.getSomes(persistedBindings).map(
            (binding) => [binding.threadId, binding] as const,
          ),
        );

        return activeSessions.map((session) => {
          const binding = bindingsByThreadId.get(session.threadId);
          if (!binding) {
            return session;
          }

          const overrides: {
            resumeCursor?: ProviderSession["resumeCursor"];
            runtimeMode?: ProviderSession["runtimeMode"];
          } = {};
          if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
            overrides.resumeCursor = binding.resumeCursor;
          }
          if (binding.runtimeMode !== undefined) {
            overrides.runtimeMode = binding.runtimeMode;
          }
          return Object.assign({}, session, overrides);
        });
      });

    const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
      registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

    const rollbackConversation: ProviderServiceShape["rollbackConversation"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.rollbackConversation",
          schema: ProviderRollbackConversationInput,
          payload: rawInput,
        });
        if (input.numTurns === 0) {
          return;
        }
        yield* runIdleSensitiveProviderWork(
          input.threadId,
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.rollbackConversation",
              // Restart-based rollback only needs the persisted binding and must
              // not replay the stale native cursor merely to close it again.
              allowRecovery: false,
            });
            if (routed.adapter.capabilities.conversationRollback === "unsupported") {
              return yield* toValidationError(
                "ProviderService.rollbackConversation",
                `Provider '${routed.adapter.provider}' cannot rewind exact native session state.`,
              );
            }
            const active = routed.isActive
              ? routed
              : yield* resolveRoutableSession({
                  threadId: input.threadId,
                  operation: "ProviderService.rollbackConversation",
                  allowRecovery: true,
                });
            yield* active.adapter.rollbackThread(
              input.threadId,
              input.numTurns,
              input.beforeTurnId,
            );
            yield* analytics.record("provider.conversation.rolled_back", {
              provider: routed.adapter.provider,
              turns: input.numTurns,
            });
          }),
          { scheduleIdleStopOnSuccess: true },
        );
      });

    const compactThread: ProviderServiceShape["compactThread"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.compactThread",
          schema: ProviderCompactThreadInput,
          payload: rawInput,
        });
        yield* runIdleSensitiveProviderWork(
          input.threadId,
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.compactThread",
              allowRecovery: true,
            });
            if (!routed.adapter.compactThread) {
              return yield* toValidationError(
                "ProviderService.compactThread",
                `Context compaction is unavailable for provider '${routed.adapter.provider}'.`,
              );
            }
            yield* routed.adapter.compactThread(input.threadId);
            const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
            if (binding) {
              yield* directory.upsert({
                threadId: input.threadId,
                provider: binding.provider,
                ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
                ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
                status: "stopped",
                resumeCursor: binding.resumeCursor,
                runtimePayload: {
                  ...runtimePayloadRecord(binding.runtimePayload),
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.compactThread",
                  lastRuntimeEventAt: new Date().toISOString(),
                },
              });
            }
            yield* analytics.record("provider.thread.compacted", {
              provider: routed.adapter.provider,
            });
          }),
          { scheduleIdleStopOnSuccess: true },
        );
      });

    const runStopAll = () =>
      Effect.gen(function* () {
        const ownedThreadIds = yield* lifecycle.beginShutdown;
        const stoppedAt = new Date().toISOString();
        const bindings = new Map(
          (yield* directory.listBindings()).map((binding) => [binding.threadId, binding]),
        );
        const activeSessionByThreadId = new Map(
          (yield* Effect.forEach(adapters, (adapter) => adapter.listSessions()))
            .flatMap((sessions) => sessions)
            .map((session) => [session.threadId, session] as const),
        );
        const threadIds = new Set([
          ...[...bindings.values()]
            .filter((binding) => binding.status !== "stopped")
            .map((binding) => binding.threadId),
          ...activeSessionByThreadId.keys(),
          ...ownedThreadIds,
        ]);
        const exits = yield* Effect.forEach(
          threadIds,
          (threadId) =>
            Effect.exit(
              lifecycle.stop(threadId, "app-quit", (lease) =>
                Effect.gen(function* () {
                  const binding = bindings.get(threadId);
                  const session = activeSessionByThreadId.get(threadId);
                  const provider =
                    session?.provider ?? binding?.provider ?? lifecycle.providerFor(threadId);
                  if (
                    provider !== undefined &&
                    (binding || session || lifecycle.state(threadId) !== "none")
                  ) {
                    const adapter = yield* registry.getByProvider(provider);
                    yield* lifecycle.dispose(adapter, threadId, "app-quit");
                  }
                  if (binding || session) {
                    yield* markThreadStopped(threadId, stoppedAt, lease.generation, session);
                    lease.commit();
                  } else lease.retire();
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );
        // A bad thread must not prevent the other Connections' processes from
        // closing. Attempt all owners, then all process owners, before reporting.
        const processes = yield* Effect.exit(lifecycle.closeProcesses(adapters));
        yield* Effect.forEach(adapters, (adapter) => adapter.drainRuntimeEvents);
        yield* analytics.record("provider.sessions.stopped_all", {
          sessionCount: activeSessionByThreadId.size,
        });
        yield* analytics.flush;
        let failure: Cause.Cause<ProviderServiceError> | undefined;
        for (const exit of [...exits, processes])
          if (Exit.isFailure(exit))
            failure = failure === undefined ? exit.cause : Cause.combine(failure, exit.cause);
        if (failure !== undefined) return yield* Effect.failCause(failure);
      });

    const awaitRuntimeEventFanoutDrained: Effect.Effect<void> = Effect.suspend(() =>
      PubSub.isEmpty(runtimeEventPubSub).pipe(
        Effect.flatMap((empty) =>
          empty
            ? Effect.void
            : Effect.yieldNow.pipe(Effect.andThen(awaitRuntimeEventFanoutDrained)),
        ),
      ),
    );

    const closeRuntimeEvents = yield* Effect.cached(
      Effect.uninterruptible(
        Effect.logInfo("provider runtime shutdown stage started", {
          stage: "runtime-state.quiesce",
        }).pipe(
          Effect.andThen(
            lifecycle.quiesceIdle.pipe(
              Effect.tap(() => Effect.sync(() => liveRuntimeTaskIds.clear())),
            ),
          ),
          Effect.andThen(
            Effect.logInfo("provider runtime shutdown stage completed", {
              stage: "runtime-state.quiesce",
            }),
          ),
          Effect.andThen(
            Effect.logInfo("provider runtime shutdown stage started", {
              stage: "adapters.stop-all",
            }),
          ),
          Effect.andThen(
            runStopAll().pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to stop provider sessions", {
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          ),
          Effect.andThen(
            Effect.logInfo("provider runtime shutdown stage completed", {
              stage: "adapters.stop-all",
            }),
          ),
          // Keep subscriptions alive until adapters have emitted terminal
          // events. Closing waits for an in-flight canonical event because its
          // persistence and publication section is uninterruptible.
          Effect.andThen(
            Effect.logInfo("provider runtime shutdown stage started", {
              stage: "event-producers.close",
            }),
          ),
          Effect.andThen(Scope.close(runtimeEventProducerScope, Exit.void)),
          Effect.andThen(
            Effect.logInfo("provider runtime shutdown stage completed", {
              stage: "event-producers.close",
            }),
          ),
          // Downstream subscribers transfer every published event into their
          // own drainable workers before the publication owner is shut down.
          Effect.andThen(
            Effect.logInfo("provider runtime shutdown stage started", {
              stage: "event-fanout.drain",
            }),
          ),
          Effect.andThen(awaitRuntimeEventFanoutDrained),
          Effect.andThen(
            Effect.logInfo("provider runtime shutdown stage completed", {
              stage: "event-fanout.drain",
            }),
          ),
          Effect.andThen(PubSub.shutdown(runtimeEventPubSub)),
        ),
      ),
    );

    yield* Effect.addFinalizer(() => closeRuntimeEvents);

    return {
      getRuntimeState: lifecycle.state,
      isRoutable,
      withIdleStopHeld: runIdleSensitiveProviderWork,
      stopConnection,
      ensure,
      sendTurn,
      steerTurn,
      startReview,
      interruptTurn,
      stopTask,
      backgroundTask,
      respondToUserInput,
      stop,
      stopRuntimeSession,
      hasLiveRuntimeTasks,
      clearSessionResumeCursor,
      listSessions,
      getCapabilities,
      rollbackConversation,
      compactThread,
      closeRuntimeEvents,
      // Each access creates a fresh PubSub subscription so that multiple
      // observers each
      // independently receive all runtime events.
      get streamEvents(): ProviderServiceShape["streamEvents"] {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    } satisfies ProviderServiceShape;
  });

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}

/** Managed runtime: event ingestion and canonical provider-native resume identity. */
export function makeManagedProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(
    ProviderService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = yield* ThreadPublisher;
      const rateLimits = yield* ConnectionRateLimits;
      const circuits = yield* ProviderAuthCircuits;
      const launchResolver = yield* ProviderLaunchResolver;
      return yield* makeProviderService({
        ...options,
        canIdleStop: (threadId) =>
          sql`
          SELECT id FROM threads WHERE id=${threadId} AND deleted_at IS NULL
          AND state NOT IN ('starting', 'running') AND active_turn_id IS NULL
          AND json_array_length(queue)=0
          AND NOT EXISTS (SELECT 1 FROM thread_items q WHERE q.thread_id=threads.id AND q.kind='question' AND q.status='open')
        `.pipe(Effect.map((rows) => rows.length === 1)),
        consumeRuntimeEvent: (event) => {
          return consumeProviderRuntimeEvent(publisher, event).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ConnectionRateLimits, rateLimits),
            Effect.provideService(ProviderAuthCircuits, circuits),
            Effect.as(event),
          );
        },
        consumeRuntimeDeltaRun: (events) => {
          return applyProviderDeltaRun(publisher, events).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
        },
        persistNativeResumeCursor: ({ threadId, provider, resumeCursor }) =>
          Effect.gen(function* () {
            const state = yield* readThreadNativeState(threadId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            if (Option.isNone(state)) return;
            if (state.value.provider !== provider)
              return yield* Effect.fail(new Error("Provider-native cursor provider mismatch."));
            const providerSessionId = providerNativeResumeIdentity(provider, resumeCursor);
            if (resumeCursor !== null && providerSessionId === null)
              return yield* Effect.fail(new Error("Provider-native cursor has no exact identity."));
            const changed =
              yield* sql`UPDATE threads SET provider_session_id=${providerSessionId}, updated_at=${new Date().toISOString()}
              WHERE id=${threadId} AND provider=${provider} AND provider_session_id IS NOT ${providerSessionId} AND deleted_at IS NULL RETURNING id`;
            if (changed.length !== 0) publisher.publish({ threadId });
          }),
        resolveManagedLaunch: ({ threadId, provider }) =>
          Effect.gen(function* () {
            const state = yield* readThreadNativeState(threadId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            if (Option.isNone(state))
              return yield* Effect.fail(new Error("The thread does not exist."));
            if (state.value.provider !== provider)
              return yield* Effect.fail(
                new Error("The requested provider does not match the thread."),
              );
            const internalProvider =
              provider === "opencode" ? parseOpenCodeModelSlug(state.value.model) : null;
            if (provider === "opencode" && internalProvider === null)
              return yield* Effect.fail(new Error("The OpenCode model has no provider prefix."));
            const launch = yield* launchResolver.resolve({
              threadId,
              connectionId: state.value.connectionId,
              internalProviderId: internalProvider === null ? null : internalProvider.providerID,
            });
            return {
              binaryPath: launch.binaryPath,
              assertCurrentCredentials: launch.assertCurrentCredentials,
              connectionId: launch.connectionId,
              isolationKey: launch.isolationKey,
              profileRoot: launch.profileRoot,
              nativeStateRoot: launch.nativeStateRoot,
              childEnvironment: (baseEnv: NodeJS.ProcessEnv) => launch.childEnvironment(baseEnv),
            } satisfies ProviderManagedLaunchContext;
          }),
      });
    }),
  );
}
