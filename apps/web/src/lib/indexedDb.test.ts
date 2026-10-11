import { afterEach, expect, it, vi } from "vitest";
import { openIndexedDbDatabase } from "./indexedDb";

afterEach(() => vi.unstubAllGlobals());
it("rejects when browser storage is unavailable", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await expect(
    openIndexedDbDatabase({
      name: "private-store-name",
      version: 1,
      storeName: "private-store",
      keyPath: "id",
      label: "private-label",
    }),
  ).rejects.toThrow("IndexedDB is unavailable");
});
