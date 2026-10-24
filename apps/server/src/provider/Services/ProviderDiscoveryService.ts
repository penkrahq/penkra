import type {
  ProviderConnectionId,
  ProviderKind,
  ProviderComposerCapabilities,
  ProviderGetCapabilityHealthInput,
  ProviderGetCapabilityHealthResult,
  ProviderGetComposerCapabilitiesInput,
  ProviderListModelsInput,
  ProviderListModelsResult,
} from "@penkra/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type {
  ProviderAdapterError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from "../Errors.ts";

export type ProviderDiscoveryError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderAdapterError;

export interface ProviderDiscoveryServiceShape {
  readonly probeConnection: (input: {
    readonly provider: ProviderKind;
    readonly connectionId: ProviderConnectionId;
  }) => Effect.Effect<boolean, ProviderDiscoveryError>;
  readonly getComposerCapabilities: (
    input: ProviderGetComposerCapabilitiesInput,
  ) => Effect.Effect<ProviderComposerCapabilities, ProviderDiscoveryError>;
  readonly getCapabilityHealth: (
    input: ProviderGetCapabilityHealthInput,
  ) => Effect.Effect<ProviderGetCapabilityHealthResult, ProviderDiscoveryError>;
  readonly listModels: (
    input: ProviderListModelsInput,
  ) => Effect.Effect<ProviderListModelsResult, ProviderDiscoveryError>;
}

export class ProviderDiscoveryService extends Context.Service<
  ProviderDiscoveryService,
  ProviderDiscoveryServiceShape
>()("penkra/provider/Services/ProviderDiscoveryService") {}
