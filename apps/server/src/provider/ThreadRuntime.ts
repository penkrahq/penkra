import type {
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ThreadId,
} from "@penkra/contracts";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option } from "effect";

import { ProviderValidationError, type ProviderAdapterError } from "./Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderAdapterSessionStartInput,
} from "./Services/ProviderAdapter.ts";
import {
  makeProviderLifecycleCoordinator,
  type ProviderLifecycleLease,
} from "./providerLifecycleCoordinator.ts";

export type ThreadRuntimeStopReason =
  | "user-stop"
  | "archive"
  | "delete"
  | "selection-change"
  | "runtime-mode-change"
  | "connection-removed"
  | "runtime-update"
  | "idle"
  | "app-quit";

export type ThreadRuntimeState = "none" | "starting" | "ready" | "running" | "stopping";

interface RuntimeOwner {
  provider: ProviderKind;
  state: ThreadRuntimeState;
  start?:
    | { readonly fiber: Fiber.Fiber<unknown, unknown>; readonly settled: Effect.Effect<void> }
    | undefined;
  cancelled: boolean;
  cancelReason?: ThreadRuntimeStopReason | undefined;
  nativeTouched: boolean;
  nativeCleaned: boolean;
  readonly turns: Set<string>;
  activate?: (() => void) | undefined;
  generation?: string | undefined;
  failure?: unknown;
}

// Ready acknowledgement and failed-start teardown are bounded external calls,
// not inactivity guesses. A timeout rejects once and never restarts a provider.
const PROVIDER_START_SESSION_TIMEOUT = Duration.seconds(60);
const PROVIDER_FAILED_START_CLEANUP_TIMEOUT = Duration.seconds(10);

/**
 * Per-thread runtime ownership. Generations fence native events; the semaphore
 * serializes replacement/disposal, never the user's urgent interrupt. Cancelling
 * a start joins its finalizers before this owner can admit another start.
 */
export function makeThreadRuntime() {
  const lifecycle = makeProviderLifecycleCoordinator();
  const owners = new Map<ThreadId, RuntimeOwner>();
  let closing = false;

  const transition = (
    threadId: ThreadId,
    owner: RuntimeOwner,
    to: ThreadRuntimeState,
    reason: ThreadRuntimeStopReason | null = null,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (owner.state === to) return Effect.void;
      const from = owner.state;
      owner.state = to;
      return Effect.logInfo("provider.session.lifecycle", {
        threadId,
        provider: owner.provider,
        generation: lifecycle.currentGeneration(threadId) ?? null,
        from,
        to,
        reason,
      });
    });

  const ensure = <A, E, R>(
    threadId: ThreadId,
    provider: ProviderKind,
    operation: (lease: ProviderLifecycleLease) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderValidationError, R> =>
    lifecycle.run(threadId, (lease) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (closing)
            return yield* new ProviderValidationError({
              operation: "ThreadRuntime.ensure",
              issue: "Provider runtimes are shutting down.",
            });
          const previous = owners.get(threadId);
          if (previous?.state === "stopping") {
            return yield* new ProviderValidationError({
              operation: "ThreadRuntime.ensure",
              issue: "The previous provider runtime has not finished stopping.",
              cause: previous.failure,
            });
          }
          const owner: RuntimeOwner = {
            provider,
            state: previous?.state ?? "none",
            cancelled: false,
            nativeTouched: false,
            nativeCleaned: false,
            turns: new Set(),
            activate: lease.activate,
            generation: lease.generation,
          };
          owners.set(threadId, owner);
          yield* transition(threadId, owner, "starting");
          const settled = yield* Deferred.make<Exit.Exit<A, E>>();
          const starting = yield* Effect.uninterruptibleMask((runInterruptibly) =>
            Effect.gen(function* () {
              const exit = yield* Effect.exit(runInterruptibly(operation(lease)));
              owner.start = undefined;
              if (
                !owner.nativeTouched &&
                previous &&
                previous.state !== "none" &&
                !owner.cancelled
              ) {
                owner.provider = previous.provider;
                yield* transition(threadId, owner, previous.state);
                owners.set(threadId, previous);
                yield* Deferred.succeed(settled, exit);
                return;
              }
              if (Exit.isSuccess(exit)) {
                if (owner.state === "starting") yield* transition(threadId, owner, "ready");
              } else {
                // An interrupted start is not gone until its cleanup actually
                // succeeded. A cleanup defect keeps ownership at stopping.
                const cleanupFailed =
                  (owner.state === "stopping" && owner.failure !== undefined) ||
                  (owner.cancelled && !owner.nativeCleaned && !Cause.hasInterruptsOnly(exit.cause));
                owner.failure = cleanupFailed ? (owner.failure ?? exit.cause) : undefined;
                yield* transition(
                  threadId,
                  owner,
                  cleanupFailed ? "stopping" : "none",
                  owner.cancelReason ?? null,
                );
                if (cleanupFailed && owner.nativeTouched) lease.commit();
                else if (owner.nativeTouched && owner.nativeCleaned) lease.retire();
              }
              yield* Deferred.succeed(settled, exit);
            }),
          ).pipe(Effect.forkChild({ uninterruptible: false }));
          if (starting.pollUnsafe() === undefined)
            owner.start = { fiber: starting, settled: Deferred.await(settled).pipe(Effect.asVoid) };
          const result = yield* restore(Deferred.await(settled)).pipe(
            Effect.ensuring(
              Fiber.interrupt(starting).pipe(Effect.andThen(Deferred.await(settled))),
            ),
          );
          return yield* result;
        }),
      ),
    );

  const stop = <A, E, R>(
    threadId: ThreadId,
    reason: ThreadRuntimeStopReason,
    operation: (lease: ProviderLifecycleLease) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    lifecycle.run(threadId, (lease) =>
      Effect.gen(function* () {
        const owner = owners.get(threadId);
        const previousState = owner?.state ?? "none";
        let retired = false;
        if (owner) owner.nativeTouched = false;
        if (owner) yield* transition(threadId, owner, "stopping", reason);
        return yield* operation({
          ...lease,
          retire: () => {
            retired = true;
            lease.retire();
          },
        }).pipe(
          Effect.onExit((exit) => {
            if (!owner) return Effect.void;
            if (Exit.isFailure(exit)) {
              if (!owner.nativeTouched) return transition(threadId, owner, previousState, reason);
              owner.failure = exit.cause;
              return Effect.void;
            }
            owner.failure = undefined;
            return transition(
              threadId,
              owner,
              owner.nativeTouched || retired ? "none" : previousState,
              reason,
            );
          }),
        );
      }),
    );

  const cancelStart = (
    threadId: ThreadId,
    reason: ThreadRuntimeStopReason,
  ): Effect.Effect<boolean, ProviderValidationError> =>
    Effect.gen(function* () {
      const owner = owners.get(threadId);
      const starting = owner?.start;
      if (owner && starting !== undefined) {
        owner.cancelled = true;
        owner.cancelReason = reason;
        yield* Fiber.interrupt(starting.fiber);
        yield* starting.settled;
        if (owner.state === "stopping") {
          return yield* new ProviderValidationError({
            operation: "ThreadRuntime.interrupt",
            issue: "Provider startup cleanup did not complete.",
            cause: owner.failure,
          });
        }
        return true;
      }
      return false;
    });

  const interrupt = <A, E, R>(
    threadId: ThreadId,
    operation: (generation: string | undefined) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A | undefined, E | ProviderValidationError, R> =>
    Effect.gen(function* () {
      if (yield* cancelStart(threadId, "user-stop")) return;
      const owner = owners.get(threadId);
      // Disposal already owns interruption. Do not wait on it, race its native
      // close, or start another cleanup path from a repeated Stop click.
      if (owner?.state === "stopping") return;
      return yield* operation(lifecycle.currentGeneration(threadId));
    });

  const observe = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.suspend(() => {
      const owner = owners.get(event.threadId);
      if (
        !owner ||
        (event.lifecycleGeneration !== undefined &&
          event.lifecycleGeneration !== lifecycle.currentGeneration(event.threadId))
      )
        return Effect.void;
      if (event.providerRefs?.providerParentThreadId !== undefined) return Effect.void;
      if (event.type === "session.exited") {
        owner.turns.clear();
        owner.nativeCleaned = true;
        return transition(event.threadId, owner, "none");
      }
      if (owner.state === "stopping" || owner.state === "none") return Effect.void;
      if (event.type === "turn.started") {
        if (event.turnId !== undefined) owner.turns.add(String(event.turnId));
        return transition(event.threadId, owner, "running");
      }
      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        if (event.turnId !== undefined) owner.turns.delete(String(event.turnId));
        return owner.turns.size === 0 ? transition(event.threadId, owner, "ready") : Effect.void;
      }
      return Effect.void;
    });

  const dispose = (
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    threadId: ThreadId,
    reason: ThreadRuntimeStopReason | null,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const owner = owners.get(threadId);
      if (owner) {
        owner.provider = adapter.provider;
        owner.nativeTouched = true;
        yield* transition(threadId, owner, "stopping", reason);
      }
      yield* adapter.stopSession(threadId).pipe(
        Effect.onExit((exit) => {
          if (!owner) return Effect.void;
          if (Exit.isFailure(exit)) {
            owner.failure = exit.cause;
            return Effect.void;
          }
          owner.nativeCleaned = true;
          owner.failure = undefined;
          owner.turns.clear();
          return transition(threadId, owner, "none", reason);
        }),
      );
    });

  const startNative = (
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    input: ProviderAdapterSessionStartInput,
  ): Effect.Effect<ProviderSession, ProviderAdapterError | ProviderValidationError> =>
    Effect.gen(function* () {
      const owner = owners.get(input.threadId);
      if (!owner?.activate || owner.generation !== input.lifecycleGeneration)
        return yield* new ProviderValidationError({
          operation: "ThreadRuntime.ensure",
          issue: "Native startup is not bound to its runtime owner.",
        });
      if (yield* adapter.hasSession(input.threadId))
        yield* dispose(adapter, input.threadId, "selection-change");
      owner.activate();
      owner.provider = adapter.provider;
      owner.nativeTouched = true;
      owner.nativeCleaned = false;
      yield* transition(input.threadId, owner, "starting");
      return yield* Effect.gen(function* () {
        const started = yield* adapter
          .startSession(input)
          .pipe(Effect.timeoutOption(PROVIDER_START_SESSION_TIMEOUT));
        if (Option.isNone(started))
          return yield* new ProviderValidationError({
            operation: "ThreadRuntime.ensure",
            issue: `Provider '${adapter.provider}' did not finish starting within ${Duration.toMillis(PROVIDER_START_SESSION_TIMEOUT)}ms for thread '${input.threadId}'.`,
          });
        return started.value;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? dispose(adapter, input.threadId, owner.cancelReason ?? null).pipe(
                Effect.timeoutOption(PROVIDER_FAILED_START_CLEANUP_TIMEOUT),
                Effect.flatMap((result) =>
                  Option.isSome(result)
                    ? Effect.void
                    : Effect.fail(
                        new ProviderValidationError({
                          operation: "ThreadRuntime.ensure",
                          issue:
                            "Provider startup cleanup exceeded its deadline; runtime ownership is retained.",
                        }),
                      ),
                ),
              )
            : Effect.void,
        ),
      );
    });

  return {
    ensure,
    stop,
    interrupt,
    observe,
    startNative,
    dispose,
    beginShutdown: Effect.suspend(() => {
      closing = true;
      const threadIds = [...owners]
        .filter(([, owner]) => owner.state !== "none" || owner.start !== undefined)
        .map(([threadId]) => threadId);
      return Effect.forEach(
        threadIds,
        (threadId) =>
          cancelStart(threadId, "app-quit").pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.shutdown_cancel_failed", {
                threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.as(threadIds));
    }),
    closeProcesses: (adapters: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>) =>
      Effect.gen(function* () {
        if (!closing)
          return yield* new ProviderValidationError({
            operation: "ThreadRuntime.closeProcesses",
            issue: "Application shutdown has not begun.",
          });
        const exits = yield* Effect.forEach(adapters, (adapter) => Effect.exit(adapter.stopAll()), {
          concurrency: "unbounded",
        });
        let failure: Cause.Cause<ProviderAdapterError> | undefined;
        for (const exit of exits)
          if (Exit.isFailure(exit))
            failure = failure === undefined ? exit.cause : Cause.combine(failure, exit.cause);
        if (failure !== undefined) return yield* Effect.failCause(failure);
      }),
    providerFor: (threadId: ThreadId) => owners.get(threadId)?.provider,
    adoptSession: (session: ProviderSession) =>
      Effect.suspend(() => {
        const owner = owners.get(session.threadId);
        if (!owner) return Effect.void;
        if (session.activeTurnId !== undefined) owner.turns.add(String(session.activeTurnId));
        return transition(
          session.threadId,
          owner,
          session.status === "running" ? "running" : "ready",
        );
      }),
    currentGeneration: lifecycle.currentGeneration,
    withCurrent: lifecycle.runCurrent,
    adoptCurrent: (threadId: ThreadId, generation: string, provider: ProviderKind) => {
      lifecycle.adoptCurrent(threadId, generation);
      owners.set(threadId, {
        provider,
        state: "none",
        cancelled: false,
        nativeTouched: false,
        nativeCleaned: true,
        turns: new Set(),
      });
    },
    state: (threadId: ThreadId): ThreadRuntimeState => owners.get(threadId)?.state ?? "none",
  };
}
