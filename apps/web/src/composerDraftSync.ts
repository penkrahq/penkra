// FILE: composerDraftSync.ts
// Purpose: Sync one thread's whole composer draft with the clean core (0.14.4
// design 2.6, operator decision 2026-10-09): load threads.draft, save local
// edits debounced (300 ms) with last-write-wins by draft_updated_at, and apply
// another window's push. The payload is the serialized thread draft, so the
// text and the unsent attachment/file descriptors travel together.
// Layer: Web composer state
// Exports: shouldApplyRemoteDraft, createComposerDraftSync, useComposerDraftSync

import type { ThreadId } from "@penkra/contracts";
import { useEffect, useRef } from "react";

import type { ComposerThreadDraftState } from "./composerDraftDomain";
import {
  hydrateComposerThreadDraftFromServer,
  serializeComposerThreadDraft,
  type ComposerDraftServerAttachment,
  type ComposerDraftServerPayload,
} from "./composerDraftPersistence";
import { readComposerAsset } from "./lib/composerAssetStore";
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

export type SerializeThreadDraft = (
  threadId: ThreadId,
  draft: ComposerThreadDraftState,
) => string | null;

export type DeserializeThreadDraft = (
  threadId: ThreadId,
  payload: string,
) => Promise<ComposerThreadDraftState | null>;

export type ReadComposerDraftAssetSize = (
  attachment: ComposerDraftServerAttachment,
) => Promise<number | null>;

function defaultSerialize(_threadId: ThreadId, draft: ComposerThreadDraftState): string | null {
  const persisted = serializeComposerThreadDraft(draft);
  return persisted === null ? null : JSON.stringify(persisted);
}

async function defaultReadAssetSize(attachment: ComposerDraftServerAttachment): Promise<number | null> {
  const file = await readComposerAsset({
    assetKey: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
  }).catch(() => null);
  return file?.size ?? null;
}

async function defaultDeserialize(
  threadId: ThreadId,
  payload: string,
  readAssetSize: ReadComposerDraftAssetSize,
): Promise<ComposerThreadDraftState | null> {
  try {
    return await hydrateComposerThreadDraftFromServer(
      threadId,
      JSON.parse(payload) as ComposerDraftServerPayload,
      readAssetSize,
    );
  } catch {
    return null;
  }
}

export interface ComposerDraftSync {
  /** Load the server draft and subscribe to pushes. */
  start(): Promise<void>;
  /** Apply the current local draft to the sync (debounced save). */
  setLocalDraft(draft: ComposerThreadDraftState): void;
  /** Save any pending draft immediately. */
  flush(): Promise<void>;
  stop(): void;
}

export function createComposerDraftSync(input: {
  readonly api: ComposerDraftSyncApi;
  readonly threadId: ThreadId;
  readonly applyServerDraft: (draft: ComposerThreadDraftState) => void;
  readonly serialize?: SerializeThreadDraft;
  readonly deserialize?: DeserializeThreadDraft;
  readonly readAssetSize?: ReadComposerDraftAssetSize;
  readonly debounceMs?: number;
  readonly now?: () => string;
  readonly setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}): ComposerDraftSync {
  const debounceMs = input.debounceMs ?? COMPOSER_DRAFT_SYNC_DEBOUNCE_MS;
  const now = input.now ?? (() => new Date().toISOString());
  const setTimer = input.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = input.clearTimer ?? ((handle) => clearTimeout(handle));
  const readAssetSize = input.readAssetSize ?? defaultReadAssetSize;
  const serialize = input.serialize ?? defaultSerialize;
  const deserialize =
    input.deserialize ?? ((threadId, payload) => defaultDeserialize(threadId, payload, readAssetSize));

  let disposed = false;
  let appliedUpdatedAt: string | null = null;
  // The payload this window last applied or saved; an identical value is skipped
  // so an applied remote draft does not immediately echo back as a local edit.
  let knownPayload: string | null = null;
  // The latest local payload awaiting a debounced save (`undefined` = nothing).
  let pendingPayload: string | null | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const applyRemote = async (payload: string | null, updatedAt: string | null) => {
    appliedUpdatedAt = updatedAt;
    knownPayload = payload;
    pendingPayload = undefined;
    if (payload === null) return;
    const draft = await deserialize(input.threadId, payload);
    if (draft !== null && !disposed) input.applyServerDraft(draft);
  };

  const flush = async (): Promise<void> => {
    if (pendingTimer !== null) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    if (disposed || pendingPayload === undefined) return;
    const payload = pendingPayload;
    pendingPayload = undefined;
    knownPayload = payload;
    const updatedAt = now();
    try {
      const saved = await input.api.setThreadDraft({
        threadId: input.threadId,
        draft: payload,
        updatedAt,
      });
      if (!disposed) appliedUpdatedAt = saved.draftUpdatedAt ?? updatedAt;
    } catch {
      // A failed save keeps the draft local; the next edit retries.
    }
  };

  const load = async () => {
    const remote = await input.api.getThreadDraft({ threadId: input.threadId });
    if (disposed) return;
    if (shouldApplyRemoteDraft(remote.draftUpdatedAt, appliedUpdatedAt)) {
      await applyRemote(remote.draft, remote.draftUpdatedAt);
    } else if (knownPayload === null) {
      knownPayload = remote.draft;
    }
  };

  const unsubscribe = input.api.onThreadChange((change) => {
    if (disposed || change.threadId !== input.threadId) return;
    void load();
  });

  return {
    start: load,
    setLocalDraft: (draft) => {
      if (disposed) return;
      const payload = serialize(input.threadId, draft);
      if (payload === knownPayload) return;
      pendingPayload = payload;
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
 * Syncs one thread's whole composer draft with the clean core. `draft` is the
 * live store value and `applyServerDraft` replaces it with an applied remote one.
 */
export function useComposerDraftSync(input: {
  readonly threadId: ThreadId | null;
  readonly draft: ComposerThreadDraftState;
  readonly applyServerDraft: (threadId: ThreadId, draft: ComposerThreadDraftState) => void;
}): void {
  const controllerRef = useRef<ComposerDraftSync | null>(null);
  const applyRef = useRef(input.applyServerDraft);
  applyRef.current = input.applyServerDraft;
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
      applyServerDraft: (draft) => applyRef.current(threadId, draft),
    });
    controllerRef.current = controller;
    void controller.start();
    return () => controller.stop();
  }, [threadId]);

  useEffect(() => {
    controllerRef.current?.setLocalDraft(input.draft);
  }, [input.draft]);
}
