// FILE: threadListStore.ts
// Purpose: The single clean-core thread-list store (0.14.4 step 4). The sidebar,
// the deck and ChatView read thread summary fields (runtime mode, working
// directory, deck, pin, sort, rollups) from here instead of the orchestration
// projection snapshot. It stays live by applying the publisher's thread changes.
// Layer: Web state
// Exports: loadThreadPage, refreshThreadPage, subscribeThreadList,
//          getThreadList, useThreadList, useThreadSummary

import type {
  CleanCoreThreadSummary,
  CleanCoreThreadListCursor,
  FolderId,
  SpaceId,
  ThreadId,
} from "@penkra/contracts";
import { useSyncExternalStore } from "react";

import { ensureNativeApi } from "./nativeApi";

let threads: readonly CleanCoreThreadSummary[] = [];
let byId = new Map<string, CleanCoreThreadSummary>();
const listeners = new Set<() => void>();
let liveSubscription: (() => void) | null = null;
export interface ThreadListPageState {
  readonly nextCursor: CleanCoreThreadListCursor | null;
  readonly loading: boolean;
}
let pages = new Map<string, ThreadListPageState>();
const pendingPages = new Map<string, Promise<void>>();
export function threadListScopeKey(spaceId: SpaceId, folderId: FolderId | null): string {
  return JSON.stringify([spaceId, folderId]);
}
export function getThreadListPages(): ReadonlyMap<string, ThreadListPageState> {
  return pages;
}
export function useThreadListPages(): ReadonlyMap<string, ThreadListPageState> {
  return useSyncExternalStore(subscribeThreadList, getThreadListPages, getThreadListPages);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function setThreads(next: ReadonlyMap<string, CleanCoreThreadSummary>): void {
  byId = new Map(next);
  threads = [...byId.values()];
  emit();
}

export function subscribeThreadList(listener: () => void): () => void {
  listeners.add(listener);
  startLiveUpdates();
  return () => {
    listeners.delete(listener);
  };
}

export function getThreadList(): readonly CleanCoreThreadSummary[] {
  return threads;
}

export function getThreadListById(): ReadonlyMap<string, CleanCoreThreadSummary> {
  return byId;
}

/** Reads a bounded first page for one sidebar list; stores its keyset cursor. */
export function loadThreadPage(input: {
  readonly spaceId: SpaceId;
  readonly folderId: FolderId | null;
}): Promise<void> {
  const key = threadListScopeKey(input.spaceId, input.folderId);
  const pending = pendingPages.get(key);
  if (pending !== undefined) return pending;
  return readThreadPage(input, null);
}
export function loadNextThreadPage(input: {
  readonly spaceId: SpaceId;
  readonly folderId: FolderId | null;
}): Promise<void> {
  const key = threadListScopeKey(input.spaceId, input.folderId);
  const pending = pendingPages.get(key);
  if (pending !== undefined) return pending;
  const page = pages.get(key);
  if (page === undefined) return loadThreadPage(input);
  if (page.nextCursor === null) return Promise.resolve();
  return readThreadPage(input, page.nextCursor);
}
function readThreadPage(
  input: { readonly spaceId: SpaceId; readonly folderId: FolderId | null },
  after: CleanCoreThreadListCursor | null,
): Promise<void> {
  const key = threadListScopeKey(input.spaceId, input.folderId);
  const before = pages.get(key);
  pages = new Map(pages).set(key, { nextCursor: after, loading: true });
  emit();
  const request = ensureNativeApi()
    .cleanCore.listThreads({ ...input, after })
    .then((page) => {
      const next = new Map(byId);
      for (const thread of page.threads) {
        const stored = next.get(thread.id);
        if (stored === undefined || stored.updatedAt <= thread.updatedAt)
          next.set(thread.id, thread);
      }
      pages = new Map(pages).set(key, { nextCursor: page.nextCursor, loading: false });
      setThreads(next);
    })
    .catch((error) => {
      pages = new Map(pages);
      if (before === undefined) pages.delete(key);
      else pages.set(key, before);
      emit();
      throw error;
    })
    .finally(() => {
      pendingPages.delete(key);
    });
  pendingPages.set(key, request);
  return request;
}

/** Read one indexed row, including its canonical queue. */
export async function loadThread(threadId: ThreadId): Promise<void> {
  const thread = await ensureNativeApi().cleanCore.getThread({ threadId });
  const next = new Map(byId);
  const stored = next.get(threadId);
  if (thread === null) next.delete(threadId);
  else if (stored === undefined || stored.updatedAt <= thread.updatedAt) next.set(threadId, thread);
  setThreads(next);
}

export async function refreshThreadPage(threadId: ThreadId): Promise<void> {
  await loadThread(threadId);
}

/** Applies the publisher's thread change so the store stays live. */
function startLiveUpdates(): void {
  if (liveSubscription !== null) return;
  const api = ensureNativeApi();
  liveSubscription = api.cleanCore.onSidebarChange((change) => {
    if (change.kind === "thread") void loadThread(change.threadId);
  });
}

export function useThreadList(): readonly CleanCoreThreadSummary[] {
  return useSyncExternalStore(subscribeThreadList, getThreadList, getThreadList);
}

export function useThreadSummary(threadId: string | null): CleanCoreThreadSummary | null {
  const map = useSyncExternalStore(subscribeThreadList, getThreadListById, getThreadListById);
  if (threadId === null) return null;
  return map.get(threadId) ?? null;
}

export function resetThreadListForTests(): void {
  liveSubscription?.();
  liveSubscription = null;
  byId = new Map();
  threads = [];
  listeners.clear();
  pages = new Map();
  pendingPages.clear();
}
