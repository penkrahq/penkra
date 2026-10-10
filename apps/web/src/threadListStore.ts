// FILE: threadListStore.ts
// Purpose: The single clean-core thread-list store (0.14.4 step 4). The sidebar,
// the deck and ChatView read thread summary fields (runtime mode, working
// directory, deck, pin, sort, rollups) from here instead of the orchestration
// projection snapshot.
// Layer: Web state
// Exports: refreshThreadList, subscribeThreadList, getThreadList,
//          useThreadList, useThreadSummary

import type { CleanCoreThreadSummary } from "@penkra/contracts";
import { useSyncExternalStore } from "react";

import { readNativeApi } from "./nativeApi";

let threads: readonly CleanCoreThreadSummary[] = [];
let byId = new Map<string, CleanCoreThreadSummary>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeThreadList(listener: () => void): () => void {
  listeners.add(listener);
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

/** Reads every thread row from the clean core and replaces the store. */
export async function refreshThreadList(): Promise<void> {
  const api = readNativeApi();
  if (!api?.cleanCore?.listThreads) return;
  const result = await api.cleanCore.listThreads();
  threads = result.threads;
  byId = new Map(result.threads.map((thread) => [thread.id, thread]));
  emit();
}

export function useThreadList(): readonly CleanCoreThreadSummary[] {
  return useSyncExternalStore(subscribeThreadList, getThreadList, getThreadList);
}

export function useThreadSummary(threadId: string | null): CleanCoreThreadSummary | null {
  const list = useThreadList();
  if (threadId === null) return null;
  return list.find((thread) => thread.id === threadId) ?? null;
}
