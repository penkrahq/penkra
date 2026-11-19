import type { ProviderKind } from "@penkra/contracts";

/** Local runs on the managed OpenCode installation; other harnesses own theirs. */
export function installationHarnessFor(provider: ProviderKind): ProviderKind {
  return provider === "local" ? "opencode" : provider;
}
