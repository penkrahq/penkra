// FILE: ProviderNativeContinuationVerifier.ts
// Purpose: Verify exact native continuation under a target Connection generation.

import {
  ProviderNativeStateGenerationId,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@penkra/contracts";
import { Data, Effect, Schema, ServiceMap } from "effect";

import type { ResolvedProviderTurnSelection } from "./ProviderTurnSelectionResolver.ts";

export const VerifiedProviderNativeContinuation = Schema.Struct({
  generationId: ProviderNativeStateGenerationId,
  adapterSchemaVersion: TrimmedNonEmptyString,
  stateManifestJson: Schema.String,
  providerSessionId: TrimmedNonEmptyString,
  nativeStateLocatorJson: Schema.String,
  verifiedAt: Schema.String,
});
export type VerifiedProviderNativeContinuation = typeof VerifiedProviderNativeContinuation.Type;

export class ProviderNativeContinuationVerificationError extends Data.TaggedError(
  "ProviderNativeContinuationVerificationError",
)<{ readonly detail: string; readonly cause?: unknown }> {
  override get message(): string {
    return this.detail;
  }
}

export interface ProviderNativeContinuationVerifierShape {
  readonly verifySwitch: (input: {
    readonly selection: ResolvedProviderTurnSelection;
    readonly sourceStorage: "connection-profile" | "generation";
    readonly targetGenerationId: ProviderNativeStateGenerationId;
    readonly cwd?: string;
    readonly runtimeMode: RuntimeMode;
  }) => Effect.Effect<
    VerifiedProviderNativeContinuation,
    ProviderNativeContinuationVerificationError
  >;
}

export class ProviderNativeContinuationVerifier extends ServiceMap.Service<
  ProviderNativeContinuationVerifier,
  ProviderNativeContinuationVerifierShape
>()("penkra/provider/Services/ProviderNativeContinuationVerifier") {}
