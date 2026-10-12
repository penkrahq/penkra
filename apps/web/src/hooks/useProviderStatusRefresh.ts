// FILE: useProviderStatusRefresh.ts
// Purpose: Shared provider-status refresh hooks — focus version checks plus an
//          imperative refresh callback for UI affordances (voice auth retry, banners).
// Layer: Web hooks
// Exports: useProviderStatusRefresh, useRefreshProviderStatusesNow

import { useEffect } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { ServerProviderStatus } from "@penkra/contracts";
import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";
import { reconcileServerProviderStatuses } from "../lib/serverReactQuery";

export type RefreshProviderStatusesOptions = {
  readonly silent?: boolean;
};

export type RefreshProviderStatusesNow = (
  options?: RefreshProviderStatusesOptions,
) => Promise<readonly ServerProviderStatus[] | null>;

function writeProviderStatusesToConfigCache(
  queryClient: QueryClient,
  providers: readonly ServerProviderStatus[],
) {
  return reconcileServerProviderStatuses(queryClient, providers);
}

/**
 * Imperative one-shot provider-status refresh: re-checks providers on the server
 * and folds the result into the cached server config. Surfaces failures as a toast.
 */
export function useRefreshProviderStatusesNow(): RefreshProviderStatusesNow {
  const queryClient = useQueryClient();
  return async (options?: RefreshProviderStatusesOptions) => {
    const api = readNativeApi();
    if (!api) return null;
    try {
      const result = await api.server.refreshProviders();
      await writeProviderStatusesToConfigCache(queryClient, result.providers);
      return result.providers;
    } catch (error) {
      if (!options?.silent) {
        toastManager.add({
          type: "error",
          title: "Unable to refresh provider status",
          description:
            error instanceof Error ? error.message : "Unknown error refreshing provider status.",
        });
      }
      return null;
    }
  };
}

type ProviderStatusRefreshOptions = {
  readonly enabled?: boolean;
  readonly refreshOnFocus?: boolean;
};

export function useProviderStatusRefresh(options: ProviderStatusRefreshOptions): void {
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const refreshOnFocus = options.refreshOnFocus ?? false;

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    let disposed = false;
    let refreshInFlight = false;
    const refreshProviderStatuses = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      if (refreshInFlight) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }
      refreshInFlight = true;
      void api.server
        .refreshProviders()
        .then((result) => {
          if (disposed) {
            return;
          }
          return writeProviderStatusesToConfigCache(queryClient, result.providers);
        })
        .catch(() => undefined)
        .finally(() => {
          refreshInFlight = false;
        });
    };

    if (refreshOnFocus) {
      window.addEventListener("focus", refreshProviderStatuses);
      document.addEventListener("visibilitychange", refreshProviderStatuses);
    }

    return () => {
      disposed = true;
      if (refreshOnFocus) {
        window.removeEventListener("focus", refreshProviderStatuses);
        document.removeEventListener("visibilitychange", refreshProviderStatuses);
      }
    };
  }, [enabled, queryClient, refreshOnFocus]);
}
