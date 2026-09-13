// FILE: composerDraftStore.ts
// Purpose: Public Zustand facade for composer drafts, model choices, attachments, and persistence.
// Exports: Stable composer draft API, hooks, and promotion helpers.

import { type ModelSelection, type ProviderKind, type ThreadId } from "@penkra/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createComposerDraftStoreState } from "./composerDraftActions";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  selectComposerThreadDraft,
  type ComposerDraftStoreState,
  type ComposerThreadDraftState,
} from "./composerDraftDomain";
import {
  deriveEffectiveComposerModelState,
  type EffectiveComposerModelState,
} from "./composerDraftModels";
import {
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
  partializeComposerDraftStoreState,
  toHydratedThreadDraft,
  type PersistedComposerDraftStoreState,
} from "./composerDraftPersistence";
import {
  createDeferredPersistStorage,
  createMemoryStorage,
  flushStorageBeforePageHide,
  type StateStorage,
} from "./lib/storage";
import {
  awaitDesktopComposerDraftWrites,
  createDesktopComposerDraftStorage,
} from "./lib/desktopComposerDraftStorage";
import { measureChatPerformanceWork } from "./chatPerformanceDiagnostics";
import {
  createComposerEditRecoverySync,
  type ComposerEditRecoveryTransport,
} from "./lib/composerEditRecoverySync";

export {
  findSupersededComposerImageBlobAttachments,
  isComposerImageBlobReferenced,
} from "./composerDraftAttachments";
export {
  captureComposerPromptHistorySavedDraft,
  COMPOSER_DRAFT_STORAGE_KEY,
  PersistedComposerImageAttachment,
} from "./composerDraftDomain";
export type {
  ComposerAssistantSelectionAttachment,
  ComposerAttachmentPersistenceResult,
  ComposerDraftStoreState,
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerPromptHistorySavedDraft,
  ComposerThreadDraftState,
  DraftThreadState,
  PendingStartRecovery,
  PendingMessageEdit,
  PendingStartRecoveryRecord,
  PendingStartRecoverySettlement,
  QueuedComposerChatTurn,
  QueuedComposerTurn,
} from "./composerDraftDomain";
export {
  deriveEffectiveComposerModelState,
  resolvePreferredComposerModelSelection,
} from "./composerDraftModels";
export type { EffectiveComposerModelState } from "./composerDraftModels";
export { partializeComposerDraftStoreState } from "./composerDraftPersistence";

const COMPOSER_PERSIST_DEBOUNCE_MS = 250;
const composerFallbackStorage: StateStorage =
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage();
const composerBaseStorage: StateStorage =
  typeof window !== "undefined"
    ? createDesktopComposerDraftStorage(composerFallbackStorage)
    : composerFallbackStorage;
const composerPersistStorage = createDeferredPersistStorage<
  ComposerDraftStoreState,
  PersistedComposerDraftStoreState
>({
  getStorage: () => composerBaseStorage,
  partialize: (state) =>
    measureChatPerformanceWork("draft-checkpoint", () => partializeComposerDraftStoreState(state)),
  debounceMs: COMPOSER_PERSIST_DEBOUNCE_MS,
});
let suppressComposerPersistence = false;
const composerStorePersistStorage: typeof composerPersistStorage = {
  getItem: (name) => composerPersistStorage.getItem(name),
  setItem: (name, value) => {
    if (suppressComposerPersistence) return;
    return composerPersistStorage.setItem(name, value);
  },
  removeItem: (name) => {
    if (suppressComposerPersistence) return;
    return composerPersistStorage.removeItem(name);
  },
  flush: () => composerPersistStorage.flush(),
  discardPending: () => composerPersistStorage.discardPending(),
};

// Flush pending composer draft writes before the page goes away so at most one
// debounce window of changes can be lost.
flushStorageBeforePageHide(() => composerPersistStorage.flush());

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    createComposerDraftStoreState(() => composerPersistStorage.flush()),
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      // Partialization is owned by deferred storage so serialization does not run
      // on each keystroke and instead happens once per 250ms checkpoint window.
      storage: composerStorePersistStorage,
      migrate: migratePersistedComposerDraftStoreState,
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadId).map(([threadId, draft]) => [
            threadId,
            toHydratedThreadDraft(threadId as ThreadId, draft),
          ]),
        );
        return {
          ...currentState,
          draftsByThreadId,
          draftThreadsByThreadId: normalizedPersisted.draftThreadsByThreadId,
          projectDraftThreadIdByFolderId: normalizedPersisted.projectDraftThreadIdByFolderId,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyConnectionByProvider: normalizedPersisted.stickyConnectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

function createComposerEditRecoveryTransport(): ComposerEditRecoveryTransport | null {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.composerDrafts;
  if (bridge?.publishEditRecovery && bridge.onEditRecovery) {
    return {
      publish: (recovery) => bridge.publishEditRecovery!(recovery),
      subscribe: (listener) => bridge.onEditRecovery!(listener),
    };
  }
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel("penkra:composer-edit-recovery:v1");
  return {
    publish: (recovery) => channel.postMessage(recovery),
    subscribe: (listener) => {
      const onMessage = (event: MessageEvent<unknown>) => listener(event.data as never);
      channel.addEventListener("message", onMessage);
      return () => {
        channel.removeEventListener("message", onMessage);
        channel.close();
      };
    },
  };
}

const composerEditRecoveryTransport = createComposerEditRecoveryTransport();
const composerEditRecoverySync = composerEditRecoveryTransport
  ? createComposerEditRecoverySync({
      transport: composerEditRecoveryTransport,
      recover: (threadId, queuedTurn) => {
        // The origin window owns the durable checkpoint for this shared action.
        // Prevent an older debounced snapshot in this receiver from overwriting it.
        composerPersistStorage.discardPending();
        suppressComposerPersistence = true;
        try {
          return useComposerDraftStore.getState().recoverCancelledQueuedTurn(threadId, queuedTurn);
        } finally {
          suppressComposerPersistence = false;
        }
      },
    })
  : null;

export function publishComposerEditRecovery(
  threadId: ThreadId,
  queuedTurn: import("./composerDraftDomain").QueuedComposerTurn,
): boolean {
  return composerEditRecoverySync?.publish(threadId, queuedTurn) ?? false;
}

export async function flushComposerDraftsDurably(): Promise<void> {
  composerPersistStorage.flush();
  await awaitDesktopComposerDraftWrites();
}

export function useComposerThreadDraft(threadId: ThreadId): ComposerThreadDraftState {
  return useComposerDraftStore((state) => selectComposerThreadDraft(state, threadId));
}

export function useEffectiveComposerModelState(input: {
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  customModelsByProvider: Record<ProviderKind, readonly string[]>;
  availableModelOptionsByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>
  >;
}): EffectiveComposerModelState {
  const draft = useComposerThreadDraft(input.threadId);
  return deriveEffectiveComposerModelState({
    draft,
    selectedProvider: input.selectedProvider,
    threadModelSelection: input.threadModelSelection,
    projectModelSelection: input.projectModelSelection,
    customModelsByProvider: input.customModelsByProvider,
    ...(input.availableModelOptionsByProvider !== undefined
      ? { availableModelOptionsByProvider: input.availableModelOptionsByProvider }
      : {}),
  });
}

// Mark drafts as promoted first; route/composer cleanup happens after the server thread starts.
export function markPromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  const draftThreadIds = Object.keys(store.draftThreadsByThreadId) as ThreadId[];
  for (const draftId of draftThreadIds) {
    if (serverThreadIds.has(draftId)) {
      store.markDraftThreadPromoting(draftId);
    }
  }
}

export function finalizePromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  for (const threadId of serverThreadIds) {
    store.finalizePromotedDraftThread(threadId);
  }
}
