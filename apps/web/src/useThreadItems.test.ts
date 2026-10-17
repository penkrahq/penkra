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
  pages: Record<
    string,
    {
      items: CleanCoreThreadItem[];
      nextCursor: number | null;
      turns: Record<string, CleanCoreThreadItem>;
    }
  >,
) {
  let pushListener: ((change: { threadId: string }) => void) | null = null;
  const unsubscribe = vi.fn();
  const api: ThreadItemsApi = {
    listThreadItemsPage: vi.fn(
      async ({ beforeSeq }) =>
        pages[beforeSeq === undefined ? "first" : String(beforeSeq)] ?? {
          turns: {},
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

it("coalesces changes during the first read and catches up on a reconnect marker", async () => {
  const { api, emitPush } = makeApi({});
  let finishFirst!: (page: { items: CleanCoreThreadItem[]; turns: {}; nextCursor: null }) => void;
  const first = new Promise<{ items: CleanCoreThreadItem[]; turns: {}; nextCursor: null }>(
    (resolve) => {
      finishFirst = resolve;
    },
  );
  let changed!: () => void;
  let updated = new Promise<void>((resolve) => {
    changed = resolve;
  });
  api.listThreadItemsPage = vi
    .fn()
    .mockImplementationOnce(() => first)
    .mockResolvedValue({ items: [item(1, "newest")], turns: {}, nextCursor: null });
  const controller = createThreadItemsController(
    api,
    "thread-1",
    (state) => {
      if (state.items[0]?.text === "newest") changed();
    },
    (error) => {
      throw error;
    },
  );
  try {
    expect(api.listThreadItemsPage).not.toHaveBeenCalled();
    emitPush("thread-1"); // The server's initial marker.
    emitPush("thread-1");
    emitPush("thread-1");
    expect(api.listThreadItemsPage).toHaveBeenCalledTimes(1);
    finishFirst({ items: [item(1, "old")], turns: {}, nextCursor: null });
    await updated;
    expect(api.listThreadItemsPage).toHaveBeenCalledTimes(2);
    updated = new Promise<void>((resolve) => {
      changed = resolve;
    });
    emitPush("thread-1"); // A new stream's marker after reconnect.
    await updated;
    expect(controller.getState().items[0]?.text).toBe("newest");
  } finally {
    controller.dispose();
    finishFirst({ items: [], turns: {}, nextCursor: null });
  }
});

it("loads the first page, loads older on demand, and applies a push", async () => {
  const { api, emitPush, unsubscribe } = makeApi({
    first: { turns: {}, items: [item(3), item(2)], nextCursor: 2 },
    "2": { turns: {}, items: [item(1)], nextCursor: null },
  });
  const states: ThreadItemsState[] = [];
  const controller = createThreadItemsController(
    api,
    "thread-1",
    (s) => states.push(s),
    (error) => {
      throw error;
    },
  );

  emitPush("thread-1");
  await controller.reload();
  expect(controller.getState().items.map((i) => i.seq)).toEqual([2, 3]);
  expect(controller.getState().nextCursor).toBe(2);
  expect(api.subscribeThread).toHaveBeenCalledWith({ threadId: "thread-1" });

  await controller.loadOlder();
  expect(controller.getState().items.map((i) => i.seq)).toEqual([1, 2, 3]);
  expect(controller.getState().nextCursor).toBeNull();

  // A push re-reads the newest page and merges by seq (updated text wins).
  api.listThreadItemsPage = vi.fn(async () => ({
    turns: {},
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
  await Promise.resolve();
  expect(states.length).toBe(countAfterDispose);
});

it("ignores a push for another thread", async () => {
  const { api, emitPush } = makeApi({
    first: { turns: {}, items: [item(1)], nextCursor: null },
  });
  const controller = createThreadItemsController(
    api,
    "thread-1",
    () => undefined,
    (error) => {
      throw error;
    },
  );
  emitPush("thread-1");
  await controller.reload();
  api.listThreadItemsPage = vi.fn(async () => ({ turns: {}, items: [item(2)], nextCursor: null }));
  emitPush("thread-2");
  await Promise.resolve();
  expect(controller.getState().items.map((i) => i.seq)).toEqual([1]);
  controller.dispose();
});

it("a failure push removes the sending item on the authoritative re-read", async () => {
  const sending = { ...item(2, "retry this"), kind: "user", status: "sending" };
  const { api, emitPush } = makeApi({
    first: { turns: {}, items: [sending, item(1)], nextCursor: null },
  });
  const controller = createThreadItemsController(
    api,
    "thread-1",
    () => undefined,
    (error) => {
      throw error;
    },
  );
  emitPush("thread-1");
  await controller.reload();
  expect(controller.getState().items.some((row) => row.status === "sending")).toBe(true);
  let resolveReread!: () => void;
  const reread = new Promise<void>((resolve) => {
    resolveReread = resolve;
  });
  api.listThreadItemsPage = vi.fn(async () => {
    resolveReread();
    return { turns: {}, items: [item(1)], nextCursor: null };
  });
  emitPush("thread-1");
  await reread;
  await vi.waitFor(() => expect(controller.getState().items.map((row) => row.seq)).toEqual([1]));
  controller.dispose();
});
