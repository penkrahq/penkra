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
  const state = loadFirstPage({ turns: {}, items: [item(60), item(59), item(58)], nextCursor: 58 });
  expect(state.items.map((entry) => entry.seq)).toEqual([58, 59, 60]);
  expect(state.nextCursor).toBe(58);
  expect(state.loaded).toBe(true);
});

it("prepends an older page in seq order", () => {
  const first = loadFirstPage({ turns: {}, items: [item(3), item(2)], nextCursor: 2 });
  const older = prependOlderPage(first, { turns: {}, items: [item(1), item(2)], nextCursor: null });
  expect(older.items.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  expect(older.nextCursor).toBeNull();
});

it("merges a push by seq, replacing the prior copy and adding new items", () => {
  const first = loadFirstPage({
    turns: {},
    items: [item(1), item(2, { status: "streaming" })],
    nextCursor: 1,
  });
  const merged = mergeItems(
    first,
    [item(2, { status: "done", text: "item 2 done" }), item(3, { kind: "tool" })],
    {},
  );
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

it("removes a failed sending row from the authoritative newest range while retaining older pages", () => {
  const before = loadFirstPage({
    turns: {},
    items: [
      item(4, { kind: "user", status: "sending", text: "retry me" }),
      item(3),
      item(2),
      item(1),
    ],
    nextCursor: null,
  });
  const after = mergeItems(before, [item(3), item(2)], {});
  expect(after.items.map((row) => row.seq)).toEqual([1, 2, 3]);
  expect(after.items.some((row) => row.status === "sending")).toBe(false);
});

it("clears the transcript when the authoritative newest read is empty", () => {
  const before = loadFirstPage({
    turns: {},
    items: [item(1, { kind: "user", status: "sending" })],
    nextCursor: null,
  });
  expect(mergeItems(before, [], {}).items).toEqual([]);
});

it("retains exact companion timing across older pages and refreshes its settlement", () => {
  const turnId = "native" as NonNullable<CleanCoreThreadItem["turnId"]>;
  const marker = item(1, {
    sourceId: "turn:native",
    turnId,
    kind: "turn",
    status: "running",
    data: JSON.stringify({ startedAt: "2026-10-12T00:00:00.000Z", endedAt: null }),
  });
  const first = loadFirstPage({
    items: [item(100, { turnId })],
    turns: { native: marker },
    nextCursor: 100,
  });
  const older = prependOlderPage(first, {
    items: [item(50, { turnId })],
    turns: { native: marker },
    nextCursor: 50,
  });
  const settled = {
    ...marker,
    status: "done",
    data: JSON.stringify({
      startedAt: "2026-10-12T00:00:00.000Z",
      endedAt: "2026-10-12T00:05:00.000Z",
    }),
  };
  const next = mergeItems(older, [item(100, { turnId })], { native: settled });
  expect(next.turns.native).toEqual(settled);
  expect(next.items.map((row) => row.seq)).toEqual([50, 100]);
});

it("an older response cannot overwrite a refreshed row or its turn timing", () => {
  const turnId = "native" as NonNullable<CleanCoreThreadItem["turnId"]>;
  const settled = item(1, { turnId, kind: "turn", status: "done" });
  const state = loadFirstPage({
    items: [item(50, { text: "fresh" })],
    turns: { native: settled },
    nextCursor: 50,
  });
  const after = prependOlderPage(state, {
    items: [item(50, { text: "stale" }), item(25)],
    turns: { native: { ...settled, status: "running" } },
    nextCursor: 25,
  });
  expect(after.items.map((row) => row.seq)).toEqual([25, 50]);
  expect(after.items.at(-1)?.text).toBe("fresh");
  expect(after.turns.native?.status).toBe("done");
});
