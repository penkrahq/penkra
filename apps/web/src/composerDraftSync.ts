// FILE: composerDraftSync.ts
// Purpose: Sync one thread's composer prompt draft with the clean core
// (0.14.4 design 2.6): load threads.draft, save local edits debounced (300 ms)
// with last-write-wins by draft_updated_at, and apply another window's push.
// Layer: Web composer state
// Exports: shouldApplyRemoteDraft, createComposerDraftSync, useComposerDraftSync

import type { ThreadId } from "@penkra/contracts";
import { useEffect, useRef } from "react";

import { readNativeApi } from "./nativeApi";

export interface ComposerDraftSyncApi {
  getThreadDraft(input: {
    readonly threadId: ThreadId;
  }): Promise<{ readonly draft: string | null; readonly draftUpdatedAt: string | null }>;
  setThreadDraft(input: {
    readonly threadId: ThreadId;
    readonly draft: string | null;
    readonly updatedAt: string;
  }): Promise<{ readonly draft: string | null; readonly draftUpdatedAt: string | null }>;
  onThreadChange(callback: (change: { readonly threadId: ThreadId }) => void): () => void;
}

export const COMPOSER_DRAFT_SYNC_DEBOUNCE_MS = 300;

/** Last write wins by `draft_updated_at`; an absent remote never overwrites. */
export function shouldApplyRemoteDraft(
  remoteUpdatedAt: string | null,
  appliedUpdatedAt: string | null,
): boolean {
  if (remoteUpdatedAt === null) return false;
  if (appliedUpdatedAt === null) return true;
  return remoteUpdatedAt > appliedUpdatedAt;
}

export interface ComposerDraftSync {
  /** Load the server draft and subscribe to pushes. */
  start(): Promise<void>;
  /** Apply the current local prompt to the sync (debounced save). */
  setLocalPrompt(prompt: string): void;
  /** Save any pending prompt immediately. */
  flush(): Promise<void>;
  stop(): void;
}

export function createComposerDraftSync(input: {
  readonly api: ComposerDraftSyncApi;
  readonly threadId: ThreadId;
  readonly applyRemotePrompt: (prompt: string) => void;
  readonly debounceMs?: number;
  readonly now?: () => string;
  readonly setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}): ComposerDraftSync {
  const debounceMs = input.debounceMs ?? COMPOSER_DRAFT_SYNC_DEBOUNCE_MS;
  const now = input.now ?? (() => new Date().toISOString());
  const setTimer = input.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = input.clearTimer ?? ((handle) => clearTimeout(handle));

  let disposed = false;
  let appliedUpdatedAt: string | null = null;
  // The prompt this window last applied or saved; an identical value is skipped
  // so an applied remote draft does not immediately echo back as a local edit.
  let knownPrompt: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const applyRemote = (draft: string | null, updatedAt: string | null) => {
    appliedUpdatedAt = updatedAt;
    knownPrompt = draft ?? "";
    input.applyRemotePrompt(draft ?? "");
  };

  const flush = async (): Promise<void> => {
    if (pendingTimer !== null) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    if (disposed) return;
    const prompt = knownPrompt;
    if (prompt === null) return;
    const updatedAt = now();
    try {
      const saved = await input.api.setThreadDraft({
        threadId: input.threadId,
        draft: prompt.length > 0 ? prompt : null,
        updatedAt,
      });
      if (!disposed) appliedUpdatedAt = saved.draftUpdatedAt ?? updatedAt;
    } catch {
      // A failed save keeps the prompt local; the next edit retries.
    }
  };

  const load = async () => {
    const remote = await input.api.getThreadDraft({ threadId: input.threadId });
    if (disposed) return;
    if (shouldApplyRemoteDraft(remote.draftUpdatedAt, appliedUpdatedAt)) {
      applyRemote(remote.draft, remote.draftUpdatedAt);
    } else if (knownPrompt === null) {
      knownPrompt = remote.draft ?? "";
    }
  };

  const unsubscribe = input.api.onThreadChange((change) => {
    if (disposed || change.threadId !== input.threadId) return;
    void load();
  });

  return {
    start: load,
    setLocalPrompt: (prompt) => {
      if (disposed || prompt === knownPrompt) return;
      knownPrompt = prompt;
      if (pendingTimer !== null) clearTimer(pendingTimer);
      pendingTimer = setTimer(() => {
        pendingTimer = null;
        void flush();
      }, debounceMs);
    },
    flush,
    stop: () => {
      disposed = true;
      if (pendingTimer !== null) {
        clearTimer(pendingTimer);
        pendingTimer = null;
      }
      unsubscribe();
    },
  };
}

/**
 * Syncs one thread's composer prompt with the clean core. `prompt` is the live
 * store value and `setPrompt` writes an applied remote draft back into the store.
 */
export function useComposerDraftSync(input: {
  readonly threadId: ThreadId | null;
  readonly prompt: string;
  readonly setPrompt: (threadId: ThreadId, prompt: string) => void;
}): void {
  const controllerRef = useRef<ComposerDraftSync | null>(null);
  const setPromptRef = useRef(input.setPrompt);
  setPromptRef.current = input.setPrompt;
  const threadId = input.threadId;

  useEffect(() => {
    controllerRef.current = null;
    if (threadId === null) return;
    const api = readNativeApi();
    const cleanCore = api?.cleanCore;
    if (!cleanCore) return;
    const controller = createComposerDraftSync({
      api: cleanCore,
      threadId,
      applyRemotePrompt: (prompt) => setPromptRef.current(threadId, prompt),
    });
    controllerRef.current = controller;
    void controller.start();
    return () => controller.stop();
  }, [threadId]);

  useEffect(() => {
    controllerRef.current?.setLocalPrompt(input.prompt);
  }, [input.prompt]);
}
