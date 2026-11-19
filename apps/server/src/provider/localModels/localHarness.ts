// FILE: localHarness.ts
// Purpose: The Local provider runs on Penkra's managed OpenCode binary. This maps
// a provider to the harness whose managed installation it launches.

import type { ProviderKind } from "@penkra/contracts";

export function installationHarnessFor(provider: ProviderKind): ProviderKind {
  return provider === "local" ? "opencode" : provider;
}
