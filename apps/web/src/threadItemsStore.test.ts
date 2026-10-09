import type { CleanCoreThreadItem } from "@penkra/contracts";
import { expect, it } from "vitest";

import {
  EMPTY_THREAD_ITEMS_STATE,
  loadFirstPage,
  mergeItems,
  prependOlderPage,
} from "./threadItemsStore";

const item = (seq: number, overrides: Partial<CleanCoreThreadItem> = {}): CleanCoreThreadItem => ({
  threadId: "thread-1" as CleanCoreThreadItem["threadId"],
  seq,
  sourceId: `s-${seq}`,
  turnId: null,
  kind: "text",
  status: "done",
  text: `item ${seq}`,
  data: null,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
  ...overrides,
});

it("loads the first page oldest-first and records the cursor", () => {
  const state = loadFirstPage({ items: [item(60), item(59), item(58)], nextCursor: 58 });
  expect(state.items.map((entry) => entry.seq)).toEqual([58, 59, 60]);
  expect(state.nextCursor).toBe(58);
  expect(state.loaded).toBe(true);
});

it("prepends an older page in seq order", () => {
  const first = loadFirstPage({ items: [item(3), item(2)], nextCursor: 2 });
  const older = prependOlderPage(first, { items: [item(1), item(2)], nextCursor: null });
  expect(older.items.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  expect(older.nextCursor).toBeNull();
});

it("merges a push by seq, replacing the prior copy and adding new items", () => {
  const first = loadFirstPage({
    items: [item(1), item(2, { status: "streaming" })],
    nextCursor: 1,
  });
  const merged = mergeItems(first, [
    item(2, { status: "done", text: "item 2 done" }),
    item(3, { kind: "tool" }),
  ]);
  expect(merged.items.map((entry) => [entry.seq, entry.status, entry.text])).toEqual([
    [1, "done", "item 1"],
    [2, "done", "item 2 done"],
    [3, "done", "item 3"],
  ]);
});

it("empty state is not loaded", () => {
  expect(EMPTY_THREAD_ITEMS_STATE.loaded).toBe(false);
  expect(EMPTY_THREAD_ITEMS_STATE.items).toEqual([]);
});
