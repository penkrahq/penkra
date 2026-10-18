import { useQueryClient } from "@tanstack/react-query";
import type { ServerConfigUpdatedPayload } from "@penkra/contracts";
import { useEffect } from "react";
import { serverQueryKeys } from "../lib/serverReactQuery";
import { onServerConfigUpdated } from "../wsNativeApi";
export type ServerConfigUpdateSubscription = (
  listener: (payload: ServerConfigUpdatedPayload) => void,
) => () => void;
/** Re-read configuration on a new server snapshot, independently of transcript hydration. */
export function ServerConfigUpdateNotifications({
  onSubscribed,
  subscribe = onServerConfigUpdated,
}: {
  readonly onSubscribed?: (() => void) | undefined;
  readonly subscribe?: ServerConfigUpdateSubscription | undefined;
} = {}) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const unsubscribe = subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    });
    onSubscribed?.();
    return unsubscribe;
  }, [onSubscribed, queryClient, subscribe]);
  return null;
}
