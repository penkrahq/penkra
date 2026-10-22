import { describe, expect, it } from "vitest";
import { ProviderConnectionId } from "@penkra/contracts";
import { createAppQueryClient } from "./appQueryClient";
import { invalidateProviderData } from "./providerDataRefresh";
import { providerCatalogQueryOptions } from "../hooks/useProviderCatalog";
it("invalidates catalogs without invalidating unrelated reads", async () => {
  const client = createAppQueryClient();
  const catalog = providerCatalogQueryOptions(
    { provider: "codex", connectionId: ProviderConnectionId.makeUnsafe("selected") },
    ["models"],
  );
  const filesystem = ["folders", "read-file", "/repo", "README.md"];
  client.setQueryData(catalog.queryKey, { models: [], version: 1, error: null });
  client.setQueryData(filesystem, "unchanged");
  try {
    await invalidateProviderData(client);
    expect(client.getQueryState(catalog.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(filesystem)?.isInvalidated).toBe(false);
  } finally {
    client.clear();
  }
});
