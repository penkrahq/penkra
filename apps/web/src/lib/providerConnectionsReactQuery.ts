import type { ThreadId } from "@penkra/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const providerConnectionQueryKeys = {
  all: ["provider-connections"] as const,
  snapshot: ["provider-connections", "snapshot"] as const,
  thread: (threadId: ThreadId | null) => ["provider-connections", "thread", threadId] as const,
};

export function providerConnectionsQueryOptions() {
  return queryOptions({
    queryKey: providerConnectionQueryKeys.snapshot,
    queryFn: () => ensureNativeApi().provider.getConnections(),
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
