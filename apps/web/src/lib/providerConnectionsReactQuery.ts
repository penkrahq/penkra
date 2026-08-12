import type { SpaceId, ThreadId } from "@penkra/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const providerConnectionQueryKeys = {
  all: ["provider-connections"] as const,
  snapshot: (spaceId: SpaceId | null) => ["provider-connections", "snapshot", spaceId] as const,
  thread: (threadId: ThreadId | null) => ["provider-connections", "thread", threadId] as const,
};

export function providerConnectionsQueryOptions(spaceId: SpaceId | null) {
  return queryOptions({
    queryKey: providerConnectionQueryKeys.snapshot(spaceId),
    queryFn: () => ensureNativeApi().provider.getConnections(spaceId === null ? {} : { spaceId }),
  });
}

export function threadProviderBindingQueryOptions(threadId: ThreadId | null) {
  return queryOptions({
    queryKey: providerConnectionQueryKeys.thread(threadId),
    queryFn: () => {
      if (threadId === null) throw new Error("A thread is required.");
      return ensureNativeApi().provider.getThreadBinding({ threadId });
    },
    enabled: threadId !== null,
  });
}
