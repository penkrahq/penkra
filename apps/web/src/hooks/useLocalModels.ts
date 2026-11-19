// FILE: useLocalModels.ts
// Purpose: On-device model list for the Local provider, polled while a download runs.

import type { LocalModelListing } from "@penkra/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { readNativeApi } from "~/nativeApi";

const LOCAL_MODELS_QUERY_KEY = ["localModels", "list"] as const;

export function useLocalModels(enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: LOCAL_MODELS_QUERY_KEY,
    enabled,
    queryFn: async () => (await readNativeApi()?.localModels.list()) ?? [],
    refetchInterval: (q) =>
      (q.state.data as ReadonlyArray<LocalModelListing> | undefined)?.some(
        (m) => m.download.kind === "downloading",
      )
        ? 500
        : false,
  });
  const bySlug = useMemo(
    () => new Map((query.data ?? []).map((model) => [model.slug, model])),
    [query.data],
  );
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: LOCAL_MODELS_QUERY_KEY });
    // The picker's model catalog carries `downloaded`; keep it in step.
    await queryClient.invalidateQueries({ queryKey: ["provider-catalog"] });
  }, [queryClient]);
  const download = useCallback(
    async (slug: string) => {
      await readNativeApi()?.localModels.download({ slug });
      await refresh();
    },
    [refresh],
  );
  const cancelDownload = useCallback(
    async (slug: string) => {
      await readNativeApi()?.localModels.cancelDownload({ slug });
      await refresh();
    },
    [refresh],
  );
  const warm = useCallback(async (slug: string) => {
    await readNativeApi()?.localModels.warm({ slug });
  }, []);
  return { models: query.data ?? [], bySlug, download, cancelDownload, warm, refresh };
}

export function formatLocalModelSize(gb: number): string {
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1).replace(/\.0$/, "")} GB`;
}
