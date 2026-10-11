// FILE: ProviderNativeStateMaterializer.ts
// Purpose: Atomically clone and clean exact native provider state folders.

import { type ProviderKind } from "@penkra/contracts";
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
    readonly providerSessionId: string | null;
    readonly sourceNativeStateId: string | null;
    readonly targetNativeStateId: string;
  }) => Effect.Effect<
    { readonly root: string; readonly providerSessionId: string | null },
    ProviderNativeStateMaterializationError
  >;
  readonly discard: (
    nativeStateId: string,
  ) => Effect.Effect<void, ProviderNativeStateMaterializationError>;
}

export class ProviderNativeStateMaterializer extends ServiceMap.Service<
  ProviderNativeStateMaterializer,
  ProviderNativeStateMaterializerShape
>()("penkra/provider/Services/ProviderNativeStateMaterializer") {}
