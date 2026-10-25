import { randomUUID } from "node:crypto";

import type { ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import { makeKeyedLock } from "../keyedLock.ts";

export interface ProviderLifecycleLease {
  readonly generation: string;
  readonly isCurrent: () => boolean;
  /** Publish the reserved generation immediately before native startup. */
  readonly activate: () => void;
  /**
   * Takes lasting ownership of {@link ProviderLifecycleLease.generation}.
   *
   * Native startup activates its reserved generation before calling the adapter,
   * not while preparing selection or reading metadata. Activation is provisional:
   * it survives the run only if the run says it took ownership. Call this once
   * the generation is observable outside the coordinator — i.e. a session was
   * started with it or a binding was persisted with it.
   */
  readonly commit: () => void;
  /** Takes lasting ownership of an existing generation instead of this run's. */
  readonly adopt: (generation: string) => void;
  /** Takes lasting ownership of "this thread has no provider generation". */
  readonly retire: () => void;
}

export interface ProviderLifecycleCoordinator {
  readonly run: <A, E, R>(
    threadId: ThreadId,
    operation: (lease: ProviderLifecycleLease) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly runCurrent: <A, E, R>(
    threadId: ThreadId,
    operation: (generation: string | undefined) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly adoptCurrent: (threadId: ThreadId, generation: string) => void;
  readonly currentGeneration: (threadId: ThreadId) => string | undefined;
}

/** Serializes provider lifecycle mutations per thread and gives each mutation a unique epoch. */
export function makeProviderLifecycleCoordinator(): ProviderLifecycleCoordinator {
  const withThreadLock = makeKeyedLock<ThreadId>();
  const currentGenerations = new Map<ThreadId, string>();

  const run: ProviderLifecycleCoordinator["run"] = (threadId, operation) =>
    withThreadLock(
      threadId,
      Effect.suspend(() => {
        const generation = randomUUID();
        const previousGeneration = currentGenerations.get(threadId);
        let ownedGeneration: string = generation;
        // Preparation does not transfer native ownership. Keep accepting events
        // from the live generation until the owner activates a native start.
        let owned = false;
        let activated = false;
        const isCurrent = () =>
          currentGenerations.get(threadId) === (activated ? ownedGeneration : previousGeneration);
        const activate = () => {
          if (!isCurrent()) return;
          currentGenerations.set(threadId, ownedGeneration);
          activated = true;
        };
        return operation({
          generation,
          isCurrent,
          activate,
          commit: () => {
            if (isCurrent()) {
              activate();
              owned = true;
            }
          },
          adopt: (adoptedGeneration) => {
            if (isCurrent()) {
              ownedGeneration = adoptedGeneration;
              currentGenerations.set(threadId, adoptedGeneration);
              activated = true;
              owned = true;
            }
          },
          retire: () => {
            if (isCurrent()) {
              currentGenerations.delete(threadId);
              owned = true;
            }
          },
        }).pipe(
          Effect.onExit(() =>
            // `isCurrent` also guards against clobbering a newer owner: only
            // rewind while this run's generation is still the published one.
            owned || !activated || !isCurrent()
              ? Effect.void
              : Effect.sync(() => {
                  if (previousGeneration === undefined) {
                    currentGenerations.delete(threadId);
                  } else {
                    currentGenerations.set(threadId, previousGeneration);
                  }
                }),
          ),
        );
      }),
    );

  return {
    run,
    runCurrent: (threadId, operation) =>
      withThreadLock(
        threadId,
        Effect.suspend(() => operation(currentGenerations.get(threadId))),
      ),
    adoptCurrent: (threadId, generation) => currentGenerations.set(threadId, generation),
    currentGeneration: (threadId) => currentGenerations.get(threadId),
  };
}
