import {
  type BeginProviderConnectionLoginInput,
  GetProviderConnectionLoginInput,
  ProviderConnectionLoginSnapshot,
  ProviderConnection,
  ProviderConnectionTerminationReason,
  ProviderConnectionId,
} from "@penkra/contracts";
import { Data, Effect, Context, type Stream } from "effect";

export class ProviderConnectionLoginError extends Data.TaggedError("ProviderConnectionLoginError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface ProviderConnectionLoginCoordinatorShape {
  readonly begin: (
    input: BeginProviderConnectionLoginInput,
  ) => Effect.Effect<ProviderConnectionLoginSnapshot, ProviderConnectionLoginError>;
  readonly get: (
    input: GetProviderConnectionLoginInput,
  ) => Effect.Effect<ProviderConnectionLoginSnapshot, ProviderConnectionLoginError>;
  readonly subscribe: (
    input: GetProviderConnectionLoginInput,
  ) => Stream.Stream<ProviderConnectionLoginSnapshot, ProviderConnectionLoginError>;
  readonly cancel: (
    input: GetProviderConnectionLoginInput,
  ) => Effect.Effect<ProviderConnectionLoginSnapshot, ProviderConnectionLoginError>;
  readonly initialize: Effect.Effect<void, ProviderConnectionLoginError>;
  readonly terminateProfile: (input: {
    readonly connectionId: ProviderConnectionId;
    readonly reason: ProviderConnectionTerminationReason;
  }) => Effect.Effect<ProviderConnection, ProviderConnectionLoginError>;
}

export class ProviderConnectionLoginCoordinator extends Context.Service<
  ProviderConnectionLoginCoordinator,
  ProviderConnectionLoginCoordinatorShape
>()("penkra/provider/Services/ProviderConnectionLoginCoordinator") {}
