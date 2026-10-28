// FILE: composerDraftStore.ts
// Purpose: Public Zustand facade for composer drafts, model choices, attachments, and persistence.
// Exports: Stable composer draft API, hooks, and promotion helpers.

import { type ModelSelection, type ProviderKind, type ThreadId } from "@penkra/contracts";
import { create } from "zustand";

import { createComposerDraftStoreState } from "./composerDraftActions";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  selectComposerThreadDraft,
  type ComposerDraftStoreState,
  type ComposerThreadDraftState,
} from "./composerDraftDomain";
import {
  deriveEffectiveComposerModelState,
  type EffectiveComposerModelState,
} from "./composerDraftModels";

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
  ComposerSubmission,
} from "./composerDraftDomain";
export {
  deriveEffectiveComposerModelState,
  resolvePreferredComposerModelSelection,
} from "./composerDraftModels";
export type { EffectiveComposerModelState } from "./composerDraftModels";

// The composer draft is owned by the clean core (`threads.draft`, TODO 2.6):
// there is no per-window localStorage persistence. `composerDraftSync` loads and
// saves the serialized draft; this store only holds it in memory for the window.
export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  createComposerDraftStoreState(() => undefined),
);

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

/** End local draft identities once server creation is confirmed. */
export function confirmServerThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  markPromotedDraftThreads(serverThreadIds);
  finalizePromotedDraftThreads(serverThreadIds);
}
