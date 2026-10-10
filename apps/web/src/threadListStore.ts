// FILE: threadListStore.ts
// Purpose: The single clean-core thread-list store (0.14.4 step 4). The sidebar,
// the deck and ChatView read thread summary fields (runtime mode, working
// directory, deck, pin, sort, rollups) from here instead of the orchestration
// projection snapshot. It stays live by applying the publisher's thread changes.
// Layer: Web state
// Exports: loadThreadPage, refreshThreadPage, subscribeThreadList,
//          getThreadList, useThreadList, useThreadSummary

import type { CleanCoreThreadSummary, FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { useSyncExternalStore } from "react";

import { ensureNativeApi } from "./nativeApi";

let threads: readonly CleanCoreThreadSummary[] = [];
let byId = new Map<string, CleanCoreThreadSummary>();
const listeners = new Set<() => void>();
let liveSubscription: (() => void) | null = null;

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

/** Reads one (space, folder) page and merges it into the store by id. */
export async function loadThreadPage(input: {
  readonly spaceId: SpaceId;
  readonly folderId: FolderId | null;
}): Promise<void> {
  const api = ensureNativeApi();
  const page = await api.cleanCore.listThreads({
    spaceId: input.spaceId,
    folderId: input.folderId,
  });
  const next = new Map(byId);
  for (const thread of page.threads) next.set(thread.id, thread);
  setThreads(next);
}

/** Reloads a thread's own (space, folder) page; used on a pushed change. */
export async function refreshThreadPage(threadId: ThreadId): Promise<void> {
  const existing = byId.get(threadId);
  if (!existing) return;
  await loadThreadPage({ spaceId: existing.spaceId, folderId: existing.folderId });
}

/** Applies the publisher's thread change so the store stays live. */
function startLiveUpdates(): void {
  if (liveSubscription !== null) return;
  const api = ensureNativeApi();
  liveSubscription = api.cleanCore.onThreadChange((change) => {
    void refreshThreadPage(change.threadId);
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
