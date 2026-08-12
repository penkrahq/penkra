// FILE: ProviderNativeStateDeletions.ts
// Purpose: Durable cleanup queue for Penkra-owned provider-native generations.

import type { ProviderNativeStateGenerationId, ThreadId } from "@penkra/contracts";
import { Data, Effect, ServiceMap } from "effect";

export interface ProviderNativeStateDeletionRecord {
  readonly nativeStateGenerationId: ProviderNativeStateGenerationId;
  readonly ownerThreadId: ThreadId;
  readonly state: "pending" | "deleting";
  readonly failureReason: string | null;
}

export class ProviderNativeStateDeletionPersistenceError extends Data.TaggedError(
  "ProviderNativeStateDeletionPersistenceError",
)<{ readonly operation: string; readonly cause?: unknown }> {
  override get message(): string {
    return `Provider native-state deletion failed during ${this.operation}.`;
  }
}

export interface ProviderNativeStateDeletionRepositoryShape {
  readonly listPending: Effect.Effect<
    readonly ProviderNativeStateDeletionRecord[],
    ProviderNativeStateDeletionPersistenceError
  >;
  readonly markDeleting: (
    generationId: ProviderNativeStateGenerationId,
  ) => Effect.Effect<void, ProviderNativeStateDeletionPersistenceError>;
  readonly resetPending: (input: {
    readonly generationId: ProviderNativeStateGenerationId;
    readonly failureReason: string;
  }) => Effect.Effect<void, ProviderNativeStateDeletionPersistenceError>;
  readonly finalize: (input: {
    readonly generationId: ProviderNativeStateGenerationId;
    readonly ownerThreadId: ThreadId;
  }) => Effect.Effect<void, ProviderNativeStateDeletionPersistenceError>;
}

export class ProviderNativeStateDeletionRepository extends ServiceMap.Service<
  ProviderNativeStateDeletionRepository,
  ProviderNativeStateDeletionRepositoryShape
>()("penkra/persistence/Services/ProviderNativeStateDeletionRepository") {}
