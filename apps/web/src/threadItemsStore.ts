// FILE: threadItemsStore.ts
// Purpose: Pure state for the clean-core transcript (0.14.4 design 2.1): load a
// page by seq, prepend older pages, and merge pushes by seq/source id. Not
// wired into the UI yet.
// Layer: Web state (pure)
// Exports: ThreadItemsState, EMPTY_THREAD_ITEMS_STATE, loadFirstPage,
//   prependOlderPage, mergeItems

import type { CleanCoreThreadItem } from "@penkra/contracts";

export interface ThreadItemsPage {
  /** Newest first, as the server returns it. */
  readonly items: ReadonlyArray<CleanCoreThreadItem>;
  readonly nextCursor: number | null;
}

export interface ThreadItemsState {
  /** Oldest first, so the transcript renders in order. */
  readonly items: ReadonlyArray<CleanCoreThreadItem>;
  /** Cursor for the next older page, or null when exhausted. */
  readonly nextCursor: number | null;
  /** False until the first page is loaded. */
  readonly loaded: boolean;
}

export const EMPTY_THREAD_ITEMS_STATE: ThreadItemsState = {
  items: [],
  nextCursor: null,
  loaded: false,
};

const ascending = (items: Iterable<CleanCoreThreadItem>): CleanCoreThreadItem[] =>
  [...items].toSorted((left, right) => left.seq - right.seq);

/** First (newest) page: replace state with it, oldest-first. */
export const loadFirstPage = (page: ThreadItemsPage): ThreadItemsState => ({
  items: ascending(page.items),
  nextCursor: page.nextCursor,
  loaded: true,
});

/**
 * Older page: merge it in and advance the cursor. Items already present are
 * replaced by seq; the sort keeps the transcript in order.
 */
export const prependOlderPage = (
  state: ThreadItemsState,
  page: ThreadItemsPage,
): ThreadItemsState => ({
  items: mergeBySeq(state.items, page.items),
  nextCursor: page.nextCursor,
  loaded: true,
});

/**
 * A push (or a refreshed newest page): upsert by seq and, within a seq, by
 * source id, so an updated item replaces its prior copy and a new one is added.
 */
export const mergeItems = (
  state: ThreadItemsState,
  incoming: ReadonlyArray<CleanCoreThreadItem>,
): ThreadItemsState => ({
  ...state,
  items: mergeBySeq(state.items, incoming),
  loaded: true,
});

function mergeBySeq(
  existing: ReadonlyArray<CleanCoreThreadItem>,
  incoming: ReadonlyArray<CleanCoreThreadItem>,
): CleanCoreThreadItem[] {
  const bySeq = new Map<number, CleanCoreThreadItem>();
  for (const item of existing) bySeq.set(item.seq, item);
  for (const item of incoming) bySeq.set(item.seq, item);
  return ascending(bySeq.values());
}
