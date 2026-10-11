// FILE: ProviderNativeStateDeletionCoordinator.ts
// Purpose: Idempotent filesystem-first cleanup followed by transactional metadata removal.

import { Effect, Layer } from "effect";

import { ProviderNativeStateDeletionRepository } from "../../persistence/Services/ProviderNativeStateDeletions.ts";
import {
  ProviderNativeStateDeletionCoordinator,
  type ProviderNativeStateDeletionCoordinatorShape,
} from "../Services/ProviderNativeStateDeletionCoordinator.ts";
import { ProviderNativeStateMaterializer } from "../Services/ProviderNativeStateMaterializer.ts";

const failureReason = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Provider native-state deletion failed.";

export const makeProviderNativeStateDeletionCoordinator = Effect.gen(function* () {
  const deletions = yield* ProviderNativeStateDeletionRepository;
  const materializer = yield* ProviderNativeStateMaterializer;

  const recover: ProviderNativeStateDeletionCoordinatorShape["recover"] = Effect.gen(function* () {
    const pending = yield* deletions.listPending;
    for (const record of pending) {
      const operation = deletions.markDeleting(record.nativeStateGenerationId).pipe(
        Effect.andThen(materializer.discard(record.nativeStateGenerationId)),
        Effect.andThen(
          deletions.finalize({
            generationId: record.nativeStateGenerationId,
            ownerThreadId: record.ownerThreadId,
          }),
        ),
      );
      yield* operation.pipe(
        Effect.catch((cause) =>
          deletions
            .resetPending({
              generationId: record.nativeStateGenerationId,
              failureReason: failureReason(cause),
            })
            .pipe(
              Effect.andThen(
                Effect.logWarning("provider native-state deletion remains pending", {
                  threadId: record.ownerThreadId,
                  generationId: record.nativeStateGenerationId,
                  cause: failureReason(cause),
                }),
              ),
              Effect.ignore,
            ),
        ),
      );
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("provider native-state deletion recovery could not read its journal", {
        cause: failureReason(cause),
      }),
    ),
  );

  return { recover } satisfies ProviderNativeStateDeletionCoordinatorShape;
});

export const ProviderNativeStateDeletionCoordinatorLive = Layer.effect(
  ProviderNativeStateDeletionCoordinator,
  makeProviderNativeStateDeletionCoordinator,
);
