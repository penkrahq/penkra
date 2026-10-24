import { FolderId, ProviderConnectionId, type NativeApi } from "@penkra/contracts";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../lib/appQueryClient";
import * as nativeApi from "../nativeApi";
import { invalidateProviderCatalog, providerCatalogQueryOptions } from "./useProviderCatalog";

const scope = {
  provider: "codex" as const,
  connectionId: ProviderConnectionId.make("selected"),
  folderId: FolderId.make("folder"),
};
const kinds = ["commands", "skills", "plugins", "agents"] as const;
afterEach(() => vi.restoreAllMocks());

function mockCatalog() {
  const getCatalog = vi.fn(async () => ({
    version: 1,
    error: null as string | null,
    commands: [{ name: "review" }],
  }));
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    provider: { getCatalog },
  } as unknown as NativeApi);
  return getCatalog;
}

describe("provider catalog reads", () => {
  it("opening five thread composers does not load a folder until its menu opens", async () => {
    const getCatalog = mockCatalog();
    const client = createAppQueryClient();
    const observers = Array.from(
      { length: 5 },
      () => new QueryObserver(client, providerCatalogQueryOptions(scope, kinds, false)),
    );
    const releases = observers.map((observer) => observer.subscribe(() => {}));
    expect(getCatalog).not.toHaveBeenCalled();
    await observers[0]!.refetch();
    expect(getCatalog).toHaveBeenCalledExactlyOnceWith({
      ...scope,
      kinds: ["agents", "commands", "plugins", "skills"],
    });
    await client.fetchQuery(providerCatalogQueryOptions(scope, kinds));
    expect(getCatalog).toHaveBeenCalledTimes(1);
    releases.forEach((release) => release());
    client.clear();
  });

  it("shares a stable scope key regardless of kind ordering, without a thread or cwd", () => {
    const a = providerCatalogQueryOptions(scope, kinds);
    const b = providerCatalogQueryOptions(scope, [...kinds].reverse());
    expect(a.queryKey).toEqual(b.queryKey);
    expect(a.queryKey).toEqual([
      "provider-catalog",
      "codex",
      "selected",
      "folder",
      ["agents", "commands", "plugins", "skills"],
    ]);
    expect(a.staleTime).toBe(Infinity);
    expect(a.refetchOnWindowFocus).toBe(false);
    expect(a.retry).toBe(false);
  });

  it("does not leak another Connection's previous items while the selection changes", async () => {
    mockCatalog();
    const client = createAppQueryClient();
    await client.fetchQuery(providerCatalogQueryOptions(scope, kinds));
    const other = providerCatalogQueryOptions(
      { ...scope, connectionId: ProviderConnectionId.make("other") },
      kinds,
      false,
    );
    const observer = new QueryObserver(client, other);
    expect(observer.getCurrentResult().data).toBeUndefined();
    observer.destroy();
    client.clear();
  });

  it("keeps usable data on transport failure without automatic retries", async () => {
    const getCatalog = mockCatalog();
    const client = createAppQueryClient();
    const options = providerCatalogQueryOptions(scope, kinds);
    const first = await client.fetchQuery(options);
    getCatalog.mockRejectedValue(new Error("offline"));
    await invalidateProviderCatalog(client, { _tag: "catalog.changed", scope, version: 1 });
    await expect(client.fetchQuery(options)).rejects.toThrow("offline");
    expect(getCatalog).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(options.queryKey)).toEqual(first);
    client.clear();
  });

  it("a same-version signal still refreshes error state, without touching another Connection", async () => {
    const getCatalog = mockCatalog();
    const client = createAppQueryClient();
    const options = providerCatalogQueryOptions(scope, kinds);
    const other = providerCatalogQueryOptions(
      { ...scope, connectionId: ProviderConnectionId.make("other") },
      kinds,
    );
    await client.fetchQuery(options);
    await client.fetchQuery(other);
    const observer = new QueryObserver(client, options);
    const release = observer.subscribe(() => {});
    getCatalog.mockResolvedValue({
      version: 1,
      error: "could not refresh",
      commands: [{ name: "review" }],
    });
    await invalidateProviderCatalog(client, { _tag: "catalog.changed", scope, version: 1 });
    expect(client.getQueryData(options.queryKey)).toMatchObject({
      error: "could not refresh",
      version: 1,
    });
    expect(client.getQueryState(other.queryKey)?.isInvalidated).toBe(false);
    expect(getCatalog).toHaveBeenCalledTimes(3);
    release();
    client.clear();
  });
});
