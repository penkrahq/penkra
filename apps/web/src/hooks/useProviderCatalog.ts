import type {
  ProviderCatalogChanged,
  ProviderCatalogKind,
  ProviderCatalogScope,
} from "@penkra/contracts";
import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { ensureNativeApi } from "../nativeApi";

export const providerCatalogQueryKeys = {
  all: ["provider-catalog"] as const,
  scope: (scope: ProviderCatalogScope) =>
    ["provider-catalog", scope.provider, scope.connectionId, scope.folderId ?? null] as const,
};

export function providerCatalogQueryOptions(
  scope: ProviderCatalogScope | null,
  kinds: ReadonlyArray<ProviderCatalogKind>,
  enabled = true,
) {
  return queryOptions({
    queryKey: [
      ...(scope ? providerCatalogQueryKeys.scope(scope) : providerCatalogQueryKeys.all),
      [...new Set(kinds)].sort(),
    ],
    queryFn: () => {
      if (!scope) throw new Error("A provider catalog requires a selected scope.");
      return ensureNativeApi().provider.getCatalog({ ...scope, kinds: [...new Set(kinds)].sort() });
    },
    enabled: enabled && scope !== null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function invalidateProviderCatalog(
  queryClient: QueryClient,
  event: ProviderCatalogChanged,
): Promise<void> {
  // The same version can announce an error or recovery: always re-read open scopes.
  return queryClient.invalidateQueries({
    queryKey: providerCatalogQueryKeys.scope(event.scope),
    refetchType: "active",
  });
}

export function useProviderCatalog(
  scope: ProviderCatalogScope | null,
  kinds: ReadonlyArray<ProviderCatalogKind>,
  enabled = true,
) {
  const queryClient = useQueryClient();
  const query = useQuery(providerCatalogQueryOptions(scope, kinds, enabled));
  const provider = scope?.provider;
  const connectionId = scope?.connectionId;
  const folderId = scope?.folderId;
  const reload = useCallback(async () => {
    if (provider === undefined || connectionId === undefined) return;
    const selected = { provider, connectionId, ...(folderId === undefined ? {} : { folderId }) };
    await ensureNativeApi().provider.reloadCatalog(selected);
    await queryClient.invalidateQueries({
      queryKey: providerCatalogQueryKeys.scope(selected),
      refetchType: "active",
    });
  }, [provider, connectionId, folderId, queryClient]);
  return { ...query, loadFailed: query.isError || query.data?.error != null, reload };
}
