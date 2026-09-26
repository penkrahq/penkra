// FILE: ProviderNativeStateMaterializer.ts
// Purpose: Atomically clone and clean exact native provider state generations.

import {
  type ProviderConnectionId,
  ProviderNativeStateGenerationId,
  type ProviderKind,
} from "@penkra/contracts";
import { Data, Effect, ServiceMap } from "effect";

export class ProviderNativeStateMaterializationError extends Data.TaggedError(
  "ProviderNativeStateMaterializationError",
)<{ readonly detail: string; readonly cause?: unknown }> {
  override get message(): string {
    return this.detail;
  }
}

export interface ProviderNativeStateMaterializerShape {
  readonly clone: (input: {
    readonly harness: ProviderKind;
    readonly providerSessionId: string;
    readonly sourceStorage: "connection-profile" | "generation";
    readonly sourceConnectionId: ProviderConnectionId | null;
    readonly targetConnectionId: ProviderConnectionId | null;
    readonly sourceGenerationId: ProviderNativeStateGenerationId;
    readonly targetGenerationId: ProviderNativeStateGenerationId;
    /** Claude's canonical state follows the Thread, not either Connection profile. */
    readonly sourceThreadId?: string;
    readonly targetThreadId?: string;
  }) => Effect.Effect<string, ProviderNativeStateMaterializationError>;
  readonly discard: (
    generationId: ProviderNativeStateGenerationId,
  ) => Effect.Effect<void, ProviderNativeStateMaterializationError>;
  readonly finalize: (
    generationId: ProviderNativeStateGenerationId,
  ) => Effect.Effect<void, ProviderNativeStateMaterializationError>;
  /**
   * Remove state that is owned by a Thread rather than any provider generation.
   * Called only after the Thread is deleted, so it never touches live state.
   */
  readonly discardThreadState: (
    threadId: string,
  ) => Effect.Effect<void, ProviderNativeStateMaterializationError>;
}

export class ProviderNativeStateMaterializer extends ServiceMap.Service<
  ProviderNativeStateMaterializer,
  ProviderNativeStateMaterializerShape
>()("penkra/provider/Services/ProviderNativeStateMaterializer") {}
