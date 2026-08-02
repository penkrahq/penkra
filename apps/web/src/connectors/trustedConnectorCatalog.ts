// FILE: trustedConnectorCatalog.ts
// Purpose: Defines the renderer view of connectors registered by trusted Penkra integration code.
// Layer: Trusted Settings model (connectors are not web Apps)

export type TrustedConnectorAuthentication = "authenticated" | "not-authenticated" | "not-required";
export type TrustedConnectorAvailability = "available" | "unavailable";

export interface TrustedConnectorDescriptor {
  id: string;
  name: string;
  description: string;
  availability: TrustedConnectorAvailability;
  authentication: TrustedConnectorAuthentication;
  enabled: boolean;
  error: string | null;
}

/**
 * No connector runtime is registered in this build. Keeping the authoritative
 * catalog empty prevents Settings from advertising Calendar/Mail/etc. that
 * Penkra cannot actually authenticate or call.
 */
export function listTrustedConnectors(): ReadonlyArray<TrustedConnectorDescriptor> {
  return [];
}
