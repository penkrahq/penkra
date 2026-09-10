// FILE: providerDiscoveryStateIdentity.ts
// Purpose: Stable native-state identities for managed provider discovery routes.

import type { ProviderConnectionId, ProviderKind } from "@penkra/contracts";

type ProviderDiscoveryRoute = {
  readonly provider: ProviderKind;
  readonly connectionId: ProviderConnectionId | null;
};

const routeSuffix = (input: ProviderDiscoveryRoute): string =>
  `${input.provider}:${input.connectionId ?? "anonymous"}`;

export const providerModelDiscoveryStateIdentity = (input: ProviderDiscoveryRoute): string =>
  `discovery:${routeSuffix(input)}`;

export const providerAgentDiscoveryStateIdentity = (input: ProviderDiscoveryRoute): string =>
  `agent-discovery:${routeSuffix(input)}`;
