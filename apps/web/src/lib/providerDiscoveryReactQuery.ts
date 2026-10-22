import type {
  ProviderComposerCapabilities,
  ProviderKind,
  ProviderSkillsCatalogResult,
} from "@penkra/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const providerDiscoveryQueryKeys = {
  all: ["provider-discovery"] as const,
  composerCapabilities: (provider: ProviderKind) =>
    ["provider-discovery", "composer-capabilities", provider] as const,
  skillsCatalog: (cwd: string | null) => ["provider-discovery", "skills-catalog", cwd] as const,
};

export function providerComposerCapabilitiesQueryOptions(provider: ProviderKind) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.composerCapabilities(provider),
    queryFn: () => ensureNativeApi().provider.getComposerCapabilities({ provider }),
    staleTime: Infinity,
  });
}

// Settings browses the unfiltered portable inventory, not a Connection's composer catalog.
export function skillsCatalogQueryOptions(input?: { cwd?: string | null; enabled?: boolean }) {
  const cwd = input?.cwd ?? null;
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.skillsCatalog(cwd),
    queryFn: (): Promise<ProviderSkillsCatalogResult> =>
      ensureNativeApi().provider.listSkillsCatalog(cwd ? { cwd } : {}),
    enabled: input?.enabled ?? true,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function isInitialModelDiscoveryPending(query: {
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isPlaceholderData: boolean;
}): boolean {
  return query.isLoading || (query.isFetching && query.isPlaceholderData);
}

export function supportsThreadCompaction(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsThreadCompaction === true;
}

export function supportsThreadImport(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsThreadImport === true;
}
