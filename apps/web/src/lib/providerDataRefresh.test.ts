import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "./appQueryClient";
import { invalidateProviderData, invalidateProviderUsage } from "./providerDataRefresh";
import { providerModelsQueryOptions } from "./providerDiscoveryReactQuery";
import { serverProviderUsageSnapshotQueryOptions } from "./serverReactQuery";
import { openUsageProviderSnapshotQueryOptions } from "./openUsageReactQuery";

function usage(usedPercent: number) {
  return {
    provider: "codex" as const,
    updatedAt: "2026-10-11T00:00:00.000Z",
    limits: [{ window: "Session", usedPercent }],
    usageLines: [],
    source: "test",
  };
}

describe("provider data change refresh", () => {
  it("refreshes cached active usage on the popup-open invalidation event", async () => {
    const client = createAppQueryClient();
    const queryFn = vi.fn().mockResolvedValue(usage(20));
    const options = { ...serverProviderUsageSnapshotQueryOptions({ provider: "codex" }), queryFn };
    const unsubscribe = new QueryObserver(client, options).subscribe(() => {});
    try {
      await client.fetchQuery(options);
      expect(queryFn).toHaveBeenCalledTimes(1);
      await invalidateProviderUsage(client);
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(client.getQueryData(options.queryKey)).toEqual(usage(20));
      expect(options.staleTime).toBe(Infinity);
      expect(options).not.toHaveProperty("refetchInterval");
      expect(openUsageProviderSnapshotQueryOptions("codex")).not.toHaveProperty("refetchInterval");
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("uses popup invalidation when a cached disabled query is enabled again", async () => {
    const client = createAppQueryClient();
    const queryFn = vi.fn().mockResolvedValue(usage(10));
    const options = { ...serverProviderUsageSnapshotQueryOptions({ provider: "codex" }), queryFn };
    client.setQueryData(options.queryKey, usage(20));
    const observer = new QueryObserver(client, { ...options, enabled: false });
    const unsubscribe = observer.subscribe(() => {});
    try {
      observer.setOptions({ ...options, enabled: true });
      await client.fetchQuery(options);
      expect(queryFn).not.toHaveBeenCalled();
      await invalidateProviderUsage(client);
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(client.getQueryData(options.queryKey)).toEqual(usage(10));
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("invalidates catalogs and usage on account, Settings, and provider-change events", async () => {
    const client = createAppQueryClient();
    const catalog = providerModelsQueryOptions({ provider: "codex" });
    const usage = serverProviderUsageSnapshotQueryOptions({ provider: "codex" });
    const filesystem = ["folders", "read-file", "/repo", "README.md"];
    client.setQueryData(catalog.queryKey, { models: [] });
    client.setQueryData(usage.queryKey, {
      provider: "codex",
      updatedAt: "2026-10-11T00:00:00.000Z",
      limits: [],
      usageLines: [],
      source: "test",
    });
    client.setQueryData(filesystem, "unchanged");
    try {
      await invalidateProviderData(client);
      expect(client.getQueryState(catalog.queryKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(usage.queryKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(filesystem)?.isInvalidated).toBe(false);
    } finally {
      client.clear();
    }
  });
});
