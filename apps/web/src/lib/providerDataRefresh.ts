import type { QueryClient } from "@tanstack/react-query";
import { openUsageQueryKeys } from "./openUsageReactQuery";
import { providerConnectionQueryKeys } from "./providerConnectionsReactQuery";
import { providerDiscoveryQueryKeys } from "./providerDiscoveryReactQuery";

/** Refresh live usage when its surface opens or its account/provider data changes. */
export function invalidateProviderUsage(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["server", "providerUsage"] }),
    queryClient.invalidateQueries({ queryKey: ["server", "allProviderUsage"] }),
    queryClient.invalidateQueries({ queryKey: openUsageQueryKeys.all }),
  ]).then(() => undefined);
}

/** Account picks/removal, Settings opening and provider updates invalidate these reads. */
export function invalidateProviderData(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: providerConnectionQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all }),
    invalidateProviderUsage(queryClient),
  ]).then(() => undefined);
}
