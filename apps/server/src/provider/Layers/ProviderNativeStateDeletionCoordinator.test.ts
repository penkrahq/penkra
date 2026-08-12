import { ProviderNativeStateGenerationId, ThreadId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProviderNativeStateDeletionRepository } from "../../persistence/Services/ProviderNativeStateDeletions.ts";
import { ProviderNativeStateDeletionCoordinator } from "../Services/ProviderNativeStateDeletionCoordinator.ts";
import { ProviderNativeStateMaterializer } from "../Services/ProviderNativeStateMaterializer.ts";
import { makeProviderNativeStateDeletionCoordinator } from "./ProviderNativeStateDeletionCoordinator.ts";

it.effect("removes filesystem state before finalizing durable deletion work", () => {
  const generationId = ProviderNativeStateGenerationId.makeUnsafe("cleanup-generation");
  const ownerThreadId = ThreadId.makeUnsafe("cleanup-thread");
  const order: string[] = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(ProviderNativeStateDeletionRepository, {
      listPending: Effect.succeed([
        {
          nativeStateGenerationId: generationId,
          ownerThreadId,
          state: "pending" as const,
          failureReason: null,
        },
      ]),
      markDeleting: () => Effect.sync(() => order.push("claim")),
      resetPending: () => Effect.die("must not reset"),
      finalize: () => Effect.sync(() => order.push("finalize")),
    }),
    Layer.succeed(ProviderNativeStateMaterializer, {
      clone: () => Effect.die("not used"),
      discard: () => Effect.sync(() => order.push("discard")),
      finalize: () => Effect.die("not used"),
    }),
  );
  const coordinatorLayer = Layer.effect(
    ProviderNativeStateDeletionCoordinator,
    makeProviderNativeStateDeletionCoordinator,
  ).pipe(Layer.provide(dependencies));
  return Effect.gen(function* () {
    const coordinator = yield* ProviderNativeStateDeletionCoordinator;
    yield* coordinator.recover;
    assert.deepStrictEqual(order, ["claim", "discard", "finalize"]);
  }).pipe(Effect.provide(Layer.mergeAll(dependencies, coordinatorLayer)));
});
