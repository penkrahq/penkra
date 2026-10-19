import type { CleanCoreThreadItem } from "@penkra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { readNativeApi } from "./nativeApi";
import {
  EMPTY_THREAD_ITEMS_STATE,
  loadFirstPage,
  mergeItems,
  mergeBySeq,
  prependOlderPage,
  type ThreadItemsPage,
  type ThreadItemsState,
  type ItemSequence,
  turnSegmentKey,
} from "./threadItemsStore";

type RecordsPage = Pick<ItemSequence, "items" | "nextCursor">;
export interface TurnItemsRange {
  readonly turnId: string;
  readonly fromSeq: number;
  readonly toSeq: number | null;
}
export interface ThreadItemsApi {
  listThreadItemsPage(input: {
    readonly threadId: string;
    readonly beforeSeq?: number;
  }): Promise<ThreadItemsPage>;
  listTurnItems(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly fromSeq: number;
    readonly toSeq: number | null;
    readonly beforeSeq?: number;
  }): Promise<RecordsPage>;
  subscribeThread(input: { readonly threadId: string }): Promise<void>;
  unsubscribeThread(input: { readonly threadId: string }): Promise<void>;
  onThreadChange(callback: (change: { readonly threadId: string }) => void): () => void;
}
export interface ThreadItemsController {
  readonly reload: () => Promise<void>;
  readonly loadOlder: () => Promise<void>;
  readonly setExpandedTurns: (ranges: ReadonlyArray<TurnItemsRange>) => void;
  readonly loadOlderTurn: (turnId: string) => Promise<void>;
  readonly dispose: () => void;
  readonly getState: () => ThreadItemsState;
}

/** Each sequence owns one latest-wins newest read and one older-page read. */
function createPageReader<P extends RecordsPage>(input: {
  read: (before?: number) => Promise<P>;
  apply: (page: P, older: boolean) => void;
  cursor: () => number | null;
  disposed: () => boolean;
}) {
  let newest: Promise<void> | null = null;
  let older: Promise<void> | null = null;
  let dirty = false;
  const reload = (): Promise<void> => {
    if (input.disposed()) return Promise.resolve();
    dirty = true;
    if (newest) return newest;
    newest = (async () => {
      while (dirty && !input.disposed()) {
        dirty = false;
        const page = await input.read();
        if (!input.disposed()) input.apply(page, false);
      }
    })().then(
      () => {
        newest = null;
        if (dirty && !input.disposed()) return reload();
      },
      (error) => {
        newest = null;
        throw error;
      },
    );
    return newest;
  };
  const loadOlder = (): Promise<void> => {
    if (older) return older;
    const cursor = input.cursor();
    if (input.disposed() || cursor === null) return Promise.resolve();
    older = input
      .read(cursor)
      .then((page) => {
        if (!input.disposed()) input.apply(page, true);
      })
      .finally(() => {
        older = null;
      });
    return older;
  };
  return { reload, loadOlder };
}

export function createThreadItemsController(
  api: ThreadItemsApi,
  threadId: string,
  onChange: (state: ThreadItemsState) => void,
  onError: (error: unknown) => void,
  onBeforePrepend?: (turnId: string | null) => void,
): ThreadItemsController {
  let state = EMPTY_THREAD_ITEMS_STATE;
  let disposed = false;
  let expanded = new Map<string, TurnItemsRange>();
  const readers = new Map<string, ReturnType<typeof createPageReader<RecordsPage>>>();
  const update = (next: ThreadItemsState) => {
    state = next;
    onChange(next);
  };
  const report = (error: unknown) => {
    if (!disposed) {
      console.error(
        `Thread transcript read failed thread=${threadId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      onError(error);
    }
  };
  const outline = createPageReader({
    read: (beforeSeq?: number) =>
      api.listThreadItemsPage({ threadId, ...(beforeSeq === undefined ? {} : { beforeSeq }) }),
    cursor: () => state.nextCursor,
    disposed: () => disposed,
    apply: (page, older) => {
      if (older && page.items.some((item) => item.seq < (state.items[0]?.seq ?? -Infinity)))
        onBeforePrepend?.(null);
      update(
        older
          ? prependOlderPage(state, page)
          : state.loaded
            ? mergeItems(state, page.items, page.turns, page.finals, page.segments)
            : { ...loadFirstPage(page), details: state.details },
      );
    },
  });
  const reader = (range: TurnItemsRange) => {
    const key = turnSegmentKey(range.turnId, range.fromSeq, range.toSeq);
    let existing = readers.get(key);
    if (existing) return existing;
    existing = createPageReader({
      read: (beforeSeq?: number) =>
        api.listTurnItems({
          threadId,
          ...range,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        }),
      cursor: () => state.details[key]?.nextCursor ?? null,
      disposed: () => disposed,
      apply: (page, older) => {
        const previous = state.details[key];
        const first = previous?.items[0]?.seq ?? Infinity;
        if (older && page.items.some((item) => item.seq < first)) onBeforePrepend?.(key);
        const min = page.items.length === 0 ? 0 : Math.min(...page.items.map((item) => item.seq));
        const items = older
          ? mergeBySeq(
              previous?.items ?? [],
              page.items.filter((item) => item.seq < first),
            )
          : mergeBySeq(previous?.items.filter((item) => item.seq < min) ?? [], page.items);
        const detail: ItemSequence = {
          items,
          nextCursor: older || !previous?.loaded ? page.nextCursor : previous.nextCursor,
          loaded: true,
        };
        update({ ...state, details: { ...state.details, [key]: detail } });
      },
    });
    readers.set(key, existing);
    return existing;
  };
  const reload = async () => {
    await Promise.all([
      outline.reload(),
      ...[...expanded.values()].map((range) => reader(range).reload()),
    ]);
  };
  const unsubscribe = api.onThreadChange((change) => {
    if (change.threadId === threadId) void reload().catch(report);
  });
  void reload().catch(report);
  void api.subscribeThread({ threadId }).catch((error) => {
    if (!disposed)
      console.warn(
        `Thread subscription setup failed thread=${threadId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
  });
  return {
    reload,
    loadOlder: outline.loadOlder,
    setExpandedTurns: (nextRanges) => {
      const previous = expanded;
      expanded = new Map(
        nextRanges.map((range) => [
          turnSegmentKey(range.turnId, range.fromSeq, range.toSeq),
          range,
        ]),
      );
      for (const [key, range] of expanded) {
        const old = previous.get(key);
        if (old === undefined || old.toSeq !== range.toSeq)
          void reader(range).reload().catch(report);
      }
    },
    loadOlderTurn: (id) =>
      expanded.has(id) ? reader(expanded.get(id)!).loadOlder() : Promise.resolve(),
    getState: () => state,
    dispose: () => {
      disposed = true;
      unsubscribe();
      void api.unsubscribeThread({ threadId }).catch((error) => {
        console.warn(
          `Thread subscription cleanup failed thread=${threadId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      });
    },
  };
}

export function useThreadItems(
  threadId: string | null,
  onBeforePrepend?: (turnId: string | null) => void,
) {
  const beforePrependRef = useRef(onBeforePrepend);
  beforePrependRef.current = onBeforePrepend;
  const [error, setError] = useState<unknown>(null);
  const [state, setState] = useState<ThreadItemsState>(EMPTY_THREAD_ITEMS_STATE);
  const ref = useRef<ThreadItemsController | null>(null);
  useEffect(() => {
    ref.current = null;
    setState(EMPTY_THREAD_ITEMS_STATE);
    setError(null);
    if (threadId === null) return;
    const api = readNativeApi();
    if (!api?.cleanCore) return;
    const controller = createThreadItemsController(
      api.cleanCore as unknown as ThreadItemsApi,
      threadId,
      (next) => {
        setError(null);
        setState(next);
      },
      setError,
      (turnId) => beforePrependRef.current?.(turnId),
    );
    ref.current = controller;
    return () => controller.dispose();
  }, [threadId]);
  const loadOlder = useCallback(() => {
    void ref.current?.loadOlder().catch(setError);
  }, []);
  const loadOlderTurn = useCallback((id: string) => {
    void ref.current?.loadOlderTurn(id).catch(setError);
  }, []);
  const setExpandedTurns = useCallback(
    (ranges: ReadonlyArray<TurnItemsRange>) => ref.current?.setExpandedTurns(ranges),
    [],
  );
  const reload = useCallback(() => {
    setError(null);
    void ref.current?.reload().catch(setError);
  }, []);
  return { state, loadOlder, loadOlderTurn, setExpandedTurns, reload, error };
}
export type UseThreadItemsResult = ReturnType<typeof useThreadItems>;
export type { CleanCoreThreadItem };
