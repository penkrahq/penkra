// FILE: managedConnectionProviders.ts
// Purpose: Derive Connection-capable agents from server declarations without provider guessing.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderConnectionsSnapshot,
  type ProviderKind,
} from "@penkra/contracts";

export const INITIAL_CONNECTION_PROVIDER_ORDER: readonly ProviderKind[] = [
  "claudeAgent",
  "codex",
  "opencode",
];

function orderProviders(providers: ReadonlySet<ProviderKind>): ProviderKind[] {
  const ordered = INITIAL_CONNECTION_PROVIDER_ORDER.filter((provider) => providers.has(provider));
  const preferred = new Set(INITIAL_CONNECTION_PROVIDER_ORDER);
  const remaining = [...providers]
    .filter((provider) => !preferred.has(provider))
    .sort((left, right) =>
      PROVIDER_DISPLAY_NAMES[left].localeCompare(PROVIDER_DISPLAY_NAMES[right]),
    );
  return [...ordered, ...remaining];
}

export function declaredConnectionProviders(
  snapshot: ProviderConnectionsSnapshot | undefined,
): ProviderKind[] {
  if (snapshot === undefined) return [...INITIAL_CONNECTION_PROVIDER_ORDER];
  const declared = new Set<ProviderKind>([
    ...snapshot.authenticationMethods.map((method) => method.harness),
    ...snapshot.anonymousRoutes.map((route) => route.harness),
  ]);
  const installed = new Set(
    snapshot.installations
      .map((installation) => installation.harness)
      .filter((provider) => declared.has(provider)),
  );
  return orderProviders(installed);
}

export function activeConnectionProviders(
  snapshot: ProviderConnectionsSnapshot | undefined,
): ProviderKind[] {
  if (snapshot === undefined) return [];
  return orderProviders(
    new Set(
      snapshot.connections
        .filter((connection) => connection.lifecycle === "active")
        .map((connection) => connection.harness),
    ),
  );
}
