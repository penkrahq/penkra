import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const providerConnectionQueryKeys = {
  all: ["provider-connections"] as const,
  snapshot: ["provider-connections", "snapshot"] as const,
};

export function providerConnectionsQueryOptions() {
  return queryOptions({
    queryKey: providerConnectionQueryKeys.snapshot,
    queryFn: () => ensureNativeApi().provider.getConnections(),
  });
}
