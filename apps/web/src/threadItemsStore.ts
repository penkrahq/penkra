// FILE: threadItemsStore.ts
// Purpose: Pure state for the clean-core transcript (0.14.4 design 2.1): load a
// page by seq, prepend older pages, and authoritatively replace refreshed ranges.
// Layer: Web state (pure)
// Exports: ThreadItemsState, EMPTY_THREAD_ITEMS_STATE, loadFirstPage,
//   prependOlderPage, mergeItems

import type { CleanCoreThreadItem } from "@penkra/contracts";

export interface ItemSequence {
  readonly items: ReadonlyArray<CleanCoreThreadItem>;
  readonly nextCursor: number | null;
  readonly loaded: boolean;
}

export interface ThreadItemsPage {
  readonly finals: Readonly<Record<string, CleanCoreThreadItem>>;
  readonly hasSteps: Readonly<Record<string, boolean>>;
  /** Newest first, as the server returns it. */
  readonly items: ReadonlyArray<CleanCoreThreadItem>;
  readonly nextCursor: number | null;
  readonly turns: Readonly<Record<string, CleanCoreThreadItem>>;
}

export interface ThreadItemsState {
  readonly details: Readonly<Record<string, ItemSequence>>;
  readonly finals: ThreadItemsPage["finals"];
  readonly hasSteps: ThreadItemsPage["hasSteps"];
  /** Oldest first, so the transcript renders in order. */
  readonly items: ReadonlyArray<CleanCoreThreadItem>;
  /** Cursor for the next older page, or null when exhausted. */
  readonly nextCursor: number | null;
  readonly turns: Readonly<Record<string, CleanCoreThreadItem>>;
  /** False until the first page is loaded. */
  readonly loaded: boolean;
}

export const EMPTY_THREAD_ITEMS_STATE: ThreadItemsState = {
  details: {},
  finals: {},
  hasSteps: {},
  items: [],
  turns: {},
  nextCursor: null,
  loaded: false,
};

const ascending = (items: Iterable<CleanCoreThreadItem>): CleanCoreThreadItem[] =>
  [...items].toSorted((left, right) => left.seq - right.seq);

/** First (newest) page: replace state with it, oldest-first. */
export const loadFirstPage = (page: ThreadItemsPage): ThreadItemsState => ({
  details: {},
  items: ascending(page.items),
  turns: page.turns,
  finals: page.finals,
  hasSteps: page.hasSteps,
  nextCursor: page.nextCursor,
  loaded: true,
});

/**
 * Older pages may only add rows below the loaded range. They must not overwrite
 * a newer refresh that completed while the older read was in flight.
 */
export const prependOlderPage = (
  state: ThreadItemsState,
  page: ThreadItemsPage,
): ThreadItemsState => ({
  details: state.details,
  items: mergeBySeq(
    state.items,
    page.items.filter((item) => item.seq < (state.items[0]?.seq ?? Infinity)),
  ),
  turns: { ...page.turns, ...state.turns },
  finals: { ...page.finals, ...state.finals },
  hasSteps: { ...page.hasSteps, ...state.hasSteps },
  nextCursor: page.nextCursor,
  loaded: true,
});

/** The newest page is authoritative from its oldest seq onward. */
export const mergeItems = (
  state: ThreadItemsState,
  incoming: ReadonlyArray<CleanCoreThreadItem>,
  turns: ThreadItemsPage["turns"],
  finals: ThreadItemsPage["finals"],
  hasSteps: ThreadItemsPage["hasSteps"],
): ThreadItemsState => {
  const firstSeq = incoming.length === 0 ? 0 : Math.min(...incoming.map((item) => item.seq));
  const retainedTurns = {
    ...Object.fromEntries(Object.entries(state.turns).filter(([, turn]) => turn.seq < firstSeq)),
    ...turns,
  };
  const keepTurn = ([id]: [string, unknown]) => id in retainedTurns;
  return {
    ...state,
    items: mergeBySeq(
      state.items.filter((item) => item.seq < firstSeq),
      incoming,
    ),
    turns: retainedTurns,
    details: Object.fromEntries(Object.entries(state.details).filter(keepTurn)),
    finals: Object.fromEntries(
      Object.entries({ ...state.finals, ...finals }).filter(
        ([id]) => id in retainedTurns && (!(id in turns) || id in finals),
      ),
    ),
    hasSteps: Object.fromEntries(
      Object.entries({ ...state.hasSteps, ...hasSteps }).filter(keepTurn),
    ),
    loaded: true,
  };
};

export function mergeBySeq(
  existing: ReadonlyArray<CleanCoreThreadItem>,
  incoming: ReadonlyArray<CleanCoreThreadItem>,
): CleanCoreThreadItem[] {
  const bySeq = new Map<number, CleanCoreThreadItem>();
  for (const item of existing) bySeq.set(item.seq, item);
  for (const item of incoming) bySeq.set(item.seq, item);
  return ascending(bySeq.values());
}
