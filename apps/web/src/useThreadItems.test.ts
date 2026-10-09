import type { CleanCoreThreadItem } from "@penkra/contracts";
import { expect, it, vi } from "vitest";

import { createThreadItemsController, type ThreadItemsApi } from "./useThreadItems";
import type { ThreadItemsState } from "./threadItemsStore";

const item = (seq: number, text = `item ${seq}`): CleanCoreThreadItem => ({
  threadId: "thread-1" as CleanCoreThreadItem["threadId"],
  seq,
  sourceId: `s-${seq}`,
  turnId: null,
  kind: "text",
  status: "done",
  text,
  data: null,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
});

function makeApi(
  pages: Record<string, { items: CleanCoreThreadItem[]; nextCursor: number | null }>,
) {
  let pushListener: ((change: { threadId: string }) => void) | null = null;
  const unsubscribe = vi.fn();
  const api: ThreadItemsApi = {
    listThreadItemsPage: vi.fn(
      async ({ beforeSeq }) =>
        pages[beforeSeq === undefined ? "first" : String(beforeSeq)] ?? {
          items: [],
          nextCursor: null,
        },
    ),
    subscribeThread: vi.fn(async () => undefined),
    unsubscribeThread: vi.fn(async () => undefined),
    onThreadChange: vi.fn((listener) => {
      pushListener = listener;
      return unsubscribe;
    }),
  };
  return { api, emitPush: (threadId: string) => pushListener?.({ threadId }), unsubscribe };
}

it("loads the first page, loads older on demand, and applies a push", async () => {
  const { api, emitPush, unsubscribe } = makeApi({
    first: { items: [item(3), item(2)], nextCursor: 2 },
    "2": { items: [item(1)], nextCursor: null },
  });
  const states: ThreadItemsState[] = [];
  const controller = createThreadItemsController(api, "thread-1", (s) => states.push(s));

  await controller.loadFirst();
  expect(controller.getState().items.map((i) => i.seq)).toEqual([2, 3]);
  expect(controller.getState().nextCursor).toBe(2);
  expect(api.subscribeThread).toHaveBeenCalledWith({ threadId: "thread-1" });

  await controller.loadOlder();
  expect(controller.getState().items.map((i) => i.seq)).toEqual([1, 2, 3]);
  expect(controller.getState().nextCursor).toBeNull();

  // A push re-reads the newest page and merges by seq (updated text wins).
  api.listThreadItemsPage = vi.fn(async () => ({
    items: [item(3, "item 3 updated")],
    nextCursor: 2,
  }));
  emitPush("thread-1");
  await vi.waitFor(() => {
    expect(controller.getState().items.find((i) => i.seq === 3)?.text).toBe("item 3 updated");
  });
  expect(controller.getState().items.map((i) => i.seq)).toEqual([1, 2, 3]);

  controller.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  const countAfterDispose = states.length;
  emitPush("thread-1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(states.length).toBe(countAfterDispose);
});

it("ignores a push for another thread", async () => {
  const { api, emitPush } = makeApi({
    first: { items: [item(1)], nextCursor: null },
  });
  const controller = createThreadItemsController(api, "thread-1", () => undefined);
  await controller.loadFirst();
  api.listThreadItemsPage = vi.fn(async () => ({ items: [item(2)], nextCursor: null }));
  emitPush("thread-2");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(controller.getState().items.map((i) => i.seq)).toEqual([1]);
  controller.dispose();
});
