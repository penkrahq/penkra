import { expect, it, vi } from "vitest";
import { FolderId } from "@penkra/contracts";
import { readDesktopFolderAppTabs, updateDesktopFolderAppTabs } from "./desktopFolderAppTabsClient";

const folderId = FolderId.makeUnsafe("folder");
const row = {
  folderId,
  folderTitle: "Work",
  updatedAt: "2026-10-11T00:00:00.000Z",
  tabs: { open: false, panes: [], activePaneId: null },
};
it("reads a single folder with backend authentication and no shell or timer", async () => {
  const fetcher = vi.fn(async () => ({
    json: async () => ({ ok: true, result: row }),
  })) as unknown as typeof fetch;
  await expect(
    readDesktopFolderAppTabs({ url: "http://127.0.0.1:1234", token: "private", fetcher }, folderId),
  ).resolves.toEqual(row);
  expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:1234/api/desktop/folder-app-tabs", {
    method: "POST",
    headers: { Authorization: "Bearer private", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "get", folderId }),
  });
});
it("writes the shared panel without consulting a window", async () => {
  const fetcher = vi.fn(async () => ({
    json: async () => ({ ok: true, result: row }),
  })) as unknown as typeof fetch;
  const input = {
    folderId,
    updatedAt: row.updatedAt,
    update: { action: "show" as const, open: false },
  };
  await expect(
    updateDesktopFolderAppTabs({ url: "http://127.0.0.1:1234", token: "private", fetcher }, input),
  ).resolves.toEqual(row);
  expect(JSON.parse((vi.mocked(fetcher).mock.calls[0]?.[1] as RequestInit).body as string)).toEqual(
    { action: "update", ...input },
  );
});
it("preserves backend write failures", async () => {
  const fetcher = vi.fn(async () => ({
    json: async () => ({ ok: false, message: "Folder is deleted" }),
  })) as unknown as typeof fetch;
  await expect(
    readDesktopFolderAppTabs({ url: "http://127.0.0.1:1234", token: "private", fetcher }, folderId),
  ).rejects.toThrow("Folder is deleted");
});
