// @vitest-environment happy-dom
import { FolderId, type NativeApi } from "@penkra/contracts";
import { QueryObserver, focusManager } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../src/lib/appQueryClient";
import {
  invalidateProviderCatalog,
  providerCatalogQueryOptions,
} from "../src/hooks/useProviderCatalog";
import * as nativeApi from "../src/nativeApi";

afterEach(() => {
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
});

it("keeps a loaded catalog on focus and refreshes it only on its scoped change event", async () => {
  const scope = {
    provider: "codex" as const,
    connectionId: null,
    folderId: FolderId.makeUnsafe("folder"),
  };
  let name = "first";
  const getCatalog = vi.fn(async () => ({
    version: 1,
    error: null,
    skills: [{ name, path: "/skill/SKILL.md", enabled: true }],
  }));
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    provider: { getCatalog },
  } as unknown as NativeApi);
  const client = createAppQueryClient();
  client.mount();
  const options = providerCatalogQueryOptions(scope, ["skills"]);
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await client.fetchQuery(options);
    name = "second";
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    window.dispatchEvent(new Event("focus"));
    await client.fetchQuery(options);
    expect(getCatalog).toHaveBeenCalledTimes(1);
    await invalidateProviderCatalog(client, { _tag: "catalog.changed", scope, version: 2 });
    expect(getCatalog).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(options.queryKey)?.skills?.[0]?.name).toBe("second");
  } finally {
    unsubscribe();
    client.unmount();
    client.clear();
  }
});

it("removes the window focus and document visibility listeners when the client unmounts", () => {
  const removeWindow = vi.spyOn(window, "removeEventListener");
  const removeDocument = vi.spyOn(document, "removeEventListener");
  const client = createAppQueryClient();
  client.mount();
  client.unmount();
  expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
  expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  client.clear();
});
