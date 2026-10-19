import type { QueryClient } from "@tanstack/react-query";
import { providerConnectionQueryKeys } from "./providerConnectionsReactQuery";
import { providerDiscoveryQueryKeys } from "./providerDiscoveryReactQuery";

/** Usage is server-pushed; these mutations invalidate only account and catalog reads. */
export function invalidateProviderData(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: providerConnectionQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all }),
  ]).then(() => undefined);
}
