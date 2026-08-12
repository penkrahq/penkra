// FILE: ProviderNativeStateDeletionCoordinator.ts
// Purpose: Drain durable provider-native generation cleanup work.

import { Effect, ServiceMap } from "effect";

export interface ProviderNativeStateDeletionCoordinatorShape {
  readonly recover: Effect.Effect<void>;
}

export class ProviderNativeStateDeletionCoordinator extends ServiceMap.Service<
  ProviderNativeStateDeletionCoordinator,
  ProviderNativeStateDeletionCoordinatorShape
>()("penkra/provider/Services/ProviderNativeStateDeletionCoordinator") {}
