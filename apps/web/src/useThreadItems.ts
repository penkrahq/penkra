// FILE: useThreadItems.ts
// Purpose: Clean-core transcript state (0.14.4 design 2.1): load the first page,
// load older pages on demand, subscribe to thread pushes and apply them through
// threadItemsStore. The controller is pure/testable; the hook wraps it.
// Layer: Web state
// Exports: ThreadItemsApi, createThreadItemsController, useThreadItems

import type { CleanCoreThreadItem } from "@penkra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { readNativeApi } from "./nativeApi";
import {
  EMPTY_THREAD_ITEMS_STATE,
  loadFirstPage,
  mergeItems,
  prependOlderPage,
  type ThreadItemsPage,
  type ThreadItemsState,
} from "./threadItemsStore";

export interface ThreadItemsApi {
  listThreadItemsPage(input: {
    readonly threadId: string;
    readonly beforeSeq?: number;
  }): Promise<ThreadItemsPage>;
  subscribeThread(input: { readonly threadId: string }): Promise<void>;
  unsubscribeThread(input: { readonly threadId: string }): Promise<void>;
  onThreadChange(callback: (change: { readonly threadId: string }) => void): () => void;
}

export interface ThreadItemsController {
  readonly loadFirst: () => Promise<void>;
  readonly loadOlder: () => Promise<void>;
  readonly dispose: () => void;
  readonly getState: () => ThreadItemsState;
}

/**
 * Owns one thread's transcript state. A push only signals "this thread changed",
 * so it re-reads the newest page and merges by seq/source id.
 */
export function createThreadItemsController(
  api: ThreadItemsApi,
  threadId: string,
  onChange: (state: ThreadItemsState) => void,
  onError: (error: unknown) => void,
): ThreadItemsController {
  let state = EMPTY_THREAD_ITEMS_STATE;
  let disposed = false;
  const update = (next: ThreadItemsState) => {
    state = next;
    onChange(state);
  };
  const loadFirst = async () => {
    const page = await api.listThreadItemsPage({ threadId });
    if (!disposed) update(loadFirstPage(page));
  };
  let olderRead: Promise<void> | null = null;
  const loadOlder = () => {
    if (olderRead !== null) return olderRead;
    if (state.nextCursor === null) return Promise.resolve();
    olderRead = api
      .listThreadItemsPage({ threadId, beforeSeq: state.nextCursor })
      .then((page) => {
        if (!disposed) update(prependOlderPage(state, page));
      })
      .finally(() => {
        olderRead = null;
      });
    return olderRead;
  };
  const unsubscribe = api.onThreadChange((change) => {
    if (change.threadId !== threadId) return;
    void api
      .listThreadItemsPage({ threadId })
      .then((page) => {
        if (!disposed) update(mergeItems(state, page.items, page.turns));
      })
      .catch(onError);
  });
  void api.subscribeThread({ threadId }).catch(() => undefined);
  return {
    loadFirst,
    loadOlder,
    dispose: () => {
      disposed = true;
      unsubscribe();
      void api.unsubscribeThread({ threadId }).catch(() => undefined);
    },
    getState: () => state,
  };
}

export interface UseThreadItemsResult {
  readonly state: ThreadItemsState;
  readonly loadOlder: () => void;
  readonly reload: () => void;
  readonly error: unknown;
}

export function useThreadItems(threadId: string | null): UseThreadItemsResult {
  const [error, setError] = useState<unknown>(null);
  const [state, setState] = useState<ThreadItemsState>(EMPTY_THREAD_ITEMS_STATE);
  const controllerRef = useRef<ThreadItemsController | null>(null);
  useEffect(() => {
    controllerRef.current = null;
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
    );
    controllerRef.current = controller;
    void controller.loadFirst().catch(setError);
    return () => controller.dispose();
  }, [threadId]);
  const loadOlder = useCallback(() => {
    void controllerRef.current?.loadOlder().catch(setError);
  }, []);
  const reload = useCallback(() => {
    setError(null);
    void controllerRef.current?.loadFirst().catch(setError);
  }, []);
  return { state, loadOlder, reload, error };
}

export type { CleanCoreThreadItem };
