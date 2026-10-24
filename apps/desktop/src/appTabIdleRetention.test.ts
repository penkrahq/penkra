import { expect, it, vi } from "vitest";
import { FolderId } from "@penkra/contracts";
import { runAppTabIdleSweep } from "./appTabIdleRetention";

const now = "2026-10-20T12:00:00.000Z";
const pane = {
  id: "old",
  kind: "app" as const,
  appId: "app",
  appSpaceId: "space",
  appSlug: "app",
  appName: "App",
  appRoute: "/",
  lastVisibleAt: "2026-10-18T12:00:00.000Z",
};
const folder = (panes: Array<typeof pane | Omit<typeof pane, "lastVisibleAt">>) => ({
  folderId: FolderId.make("folder"),
  updatedAt: now,
  tabs: { panes },
});

it("stamps selected and previously unstamped tabs, and closes only expired tabs", async () => {
  const stamp = vi.fn(async () => {});
  const close = vi.fn(async () => true);
  const { lastVisibleAt: _old, ...unstamped } = pane;
  const readPage = vi.fn(async () => ({
    folders: [
      folder([
        pane,
        { ...pane, id: "selected" },
        { ...unstamped, id: "new" },
        { ...pane, id: "recent", lastVisibleAt: now },
      ]),
    ],
    nextCursor: null,
  }));
  expect(
    await runAppTabIdleSweep(now, { readPage, isVisible: (id) => id === "selected", stamp, close }),
  ).toEqual({ stamped: 2, closed: 1, at: now });
  expect(stamp).toHaveBeenCalledExactlyOnceWith("folder", ["selected", "new"], now);
  expect(close).toHaveBeenCalledExactlyOnceWith("folder", "old", "2026-10-19T12:00:00.000Z");
});

it("rechecks visibility before closing and respects a close rejected by the shared writer", async () => {
  const isVisible = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  const stamp = vi.fn(async () => {});
  const close = vi.fn(async () => false);
  const readPage = async () => ({ folders: [folder([pane])], nextCursor: null });
  expect(await runAppTabIdleSweep(now, { readPage, isVisible, stamp, close })).toMatchObject({
    stamped: 1,
    closed: 0,
  });
  expect(close).not.toHaveBeenCalled();
  expect(
    await runAppTabIdleSweep(now, { readPage, isVisible: () => false, stamp, close }),
  ).toMatchObject({ closed: 0 });
});

it("pages folders and yields after the approved batch of closes", async () => {
  const readPage = vi
    .fn()
    .mockResolvedValueOnce({
      folders: [folder(Array.from({ length: 26 }, (_, index) => ({ ...pane, id: String(index) })))],
      nextCursor: "folder",
    })
    .mockResolvedValueOnce({ folders: [], nextCursor: null });
  const yieldBatch = vi.fn(async () => {});
  const result = await runAppTabIdleSweep(now, {
    readPage,
    isVisible: () => false,
    stamp: async () => {},
    close: async () => true,
    yieldBatch,
  });
  expect(result.closed).toBe(26);
  expect(readPage).toHaveBeenNthCalledWith(2, "folder");
  expect(yieldBatch).toHaveBeenCalledOnce();
});
