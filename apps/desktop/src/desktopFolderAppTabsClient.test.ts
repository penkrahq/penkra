import { expect, it, vi } from "vitest";
import { FolderId } from "@penkra/contracts";
import { AppTabIdleClose } from "./appTabIdleClose";
import {
  readDesktopFolderAppTabs,
  updateDesktopFolderAppTabs,
  listDesktopFolderAppTabs,
} from "./desktopFolderAppTabsClient";

const folderId = FolderId.make("folder");
const row = {
  folderId,
  folderTitle: "Work",
  updatedAt: "2026-10-11T00:00:00.000Z",
  tabs: { panes: [] },
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
it("writes the shared tab list without consulting a window", async () => {
  const fetcher = vi.fn(async () => ({
    json: async () => ({ ok: true, result: row }),
  })) as unknown as typeof fetch;
  const input = {
    folderId,
    updatedAt: row.updatedAt,
    update: { action: "close" as const, paneId: "tab" },
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

it("serializes a folder's visibility stamp before a later idle close", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: unknown[] = [];
  const fetcher = vi.fn(async (_url, request) => {
    writes.push(JSON.parse(request.body));
    if (writes.length === 1) {
      entered();
      await hold;
    }
    return { json: async () => ({ ok: true, result: row }) };
  }) as unknown as typeof fetch;
  const backend = { url: "http://127.0.0.1:2345", token: "private", fetcher };
  const stamp = updateDesktopFolderAppTabs(backend, {
    folderId,
    updatedAt: row.updatedAt,
    update: { action: "stamp", paneIds: ["tab"], at: row.updatedAt },
  });
  const close = updateDesktopFolderAppTabs(backend, {
    folderId,
    updatedAt: row.updatedAt,
    update: { action: "close", paneId: "tab", inactiveBefore: row.updatedAt },
  });
  await started;
  expect(writes).toHaveLength(1);
  release();
  await Promise.all([stamp, close]);
  expect(writes).toMatchObject([{ update: { action: "stamp" } }, { update: { action: "close" } }]);
});

it("reads a bounded folder page without loading any App", async () => {
  const fetcher = vi.fn(async () => ({
    json: async () => ({ ok: true, result: { folders: [row], nextCursor: "folder" } }),
  })) as unknown as typeof fetch;
  const page = await listDesktopFolderAppTabs(
    { url: "http://127.0.0.1:1234", token: "private", fetcher },
    "before",
  );
  expect(page.nextCursor).toBe("folder");
  expect(page.folders[0]?.folderId).toBe(folderId);
  expect(JSON.parse(vi.mocked(fetcher).mock.calls[0]![1]!.body as string)).toEqual({
    action: "list",
    afterFolderId: "before",
  });
});

it("selecting a tab cancels its idle close while another folder write is in flight", async () => {
  const closes = new AppTabIdleClose();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: unknown[] = [];
  const fetcher = vi.fn(async (_url, request) => {
    requests.push(JSON.parse(request.body));
    entered();
    await hold;
    return { json: async () => ({ ok: true, result: row }) };
  }) as unknown as typeof fetch;
  const backend = { url: "http://127.0.0.1:3456", token: "private", fetcher };
  const stamp = updateDesktopFolderAppTabs(backend, {
    folderId,
    updatedAt: row.updatedAt,
    update: { action: "stamp", paneIds: ["other"], at: row.updatedAt },
  });
  await started;
  const close = closes.close("tab", async (authorize) => {
    const result = await updateDesktopFolderAppTabs(
      backend,
      {
        folderId,
        updatedAt: row.updatedAt,
        update: { action: "close", paneId: "tab", inactiveBefore: row.updatedAt },
      },
      authorize,
    );
    return result !== null;
  });
  await closes.select("tab");
  release();
  await stamp;
  expect(await close).toBe(false);
  expect(requests).toHaveLength(1);
});
