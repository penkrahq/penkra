import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Transport state travels as a window event; tests run without a DOM.
  (globalThis as { window?: unknown }).window ??= new EventTarget();
});
const api = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  getThread: vi.fn(),
  listThreads: vi.fn(),
  onSidebarChange: vi.fn(() => () => undefined),
}));
vi.mock("./nativeApi", () => ({
  ensureNativeApi: () => ({
    cleanCore: {
      getThread: api.getThread,
      onSidebarChange: api.onSidebarChange,
      listThreads: api.listThreads,
    },
  }),
}));

import {
  getThreadListById,
  loadThread,
  loadThreadPage,
  resetThreadListForTests,
  subscribeThreadList,
  subscribeThreadRowChanges,
} from "./threadListStore";
import { emitWsTransportState } from "./wsTransportEvents";

const row = (state: string, updatedAt: string) => ({ id: "t1", state, updatedAt }) as never;

afterEach(() => resetThreadListForTests());

describe("thread list after a reconnect", () => {
  it("re-reads a row still marked running, so a turn that ended during the drop stops spinning", async () => {
    emitWsTransportState("open");
    api.getThread.mockResolvedValueOnce(row("running", "2026-11-21T09:11:53.250Z"));
    const stop = subscribeThreadList(() => undefined);
    await loadThread("t1" as never);
    expect(getThreadListById().get("t1")).toMatchObject({ state: "running" });

    // The turn ends on the server while the socket is down; that change is never pushed.
    api.getThread.mockResolvedValue(row("idle", "2026-11-21T09:12:21.304Z"));
    emitWsTransportState("closed");
    expect(api.getThread).toHaveBeenCalledTimes(1);
    emitWsTransportState("open");
    await vi.waitFor(() => expect(getThreadListById().get("t1")).toMatchObject({ state: "idle" }));
    stop();
  });

  it("does nothing on the first open", async () => {
    emitWsTransportState("connecting");
    api.getThread.mockReset();
    subscribeThreadList(() => undefined);
    emitWsTransportState("open");
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getThread).not.toHaveBeenCalled();
  });

  it("a page read that finds a running row now idle tells the row listeners, so the shell follows", async () => {
    api.getThread.mockResolvedValueOnce(row("running", "2026-11-21T09:11:53.250Z"));
    const seen: Array<{ state: unknown }> = [];
    const stop = subscribeThreadRowChanges(
      (_change, r) => seen.push({ state: (r as { state: unknown }).state }),
      () => undefined,
    );
    await loadThread("t1" as never);
    api.listThreads.mockResolvedValueOnce({
      threads: [row("idle", "2026-11-21T09:12:21.304Z")],
      nextCursor: null,
    });
    await loadThreadPage({ spaceId: "s" as never, folderId: null });
    expect(getThreadListById().get("t1")).toMatchObject({ state: "idle" });
    expect(seen).toEqual([{ state: "idle" }]);
    stop();
  });
});
