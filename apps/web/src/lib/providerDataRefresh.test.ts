import { describe, expect, it } from "vitest";
import { createAppQueryClient } from "./appQueryClient";
import { invalidateProviderData } from "./providerDataRefresh";
import { providerModelsQueryOptions } from "./providerDiscoveryReactQuery";
it("invalidates catalogs without invalidating unrelated reads", async () => {
  const client = createAppQueryClient();
  const catalog = providerModelsQueryOptions({ provider: "codex" });
  const filesystem = ["folders", "read-file", "/repo", "README.md"];
  client.setQueryData(catalog.queryKey, { models: [] });
  client.setQueryData(filesystem, "unchanged");
  try {
    await invalidateProviderData(client);
    expect(client.getQueryState(catalog.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(filesystem)?.isInvalidated).toBe(false);
  } finally {
    client.clear();
  }
});
