// FILE: composerDraftActions.ts
// Purpose: Constructs the ComposerDraftStoreState actions while preserving granular thread identity.
// Exports: Zustand state creator consumed by the public facade.

import { type ModelSelection, type ProviderKind, ThreadId } from "@penkra/contracts";
import { getDefaultModel, normalizeModelSlug } from "@penkra/shared/model";
import * as Equal from "effect/Equal";
import type { StateCreator } from "zustand";

import {
  DRAFT_ATTACHMENT_SLOT,
  PROMPT_HISTORY_ATTACHMENT_SLOT,
  composerFileDedupKey,
  deleteDraftComposerImageBlobs,
  deletePersistedComposerImageBlobs,
  mergeComposerImages,
  revokeDraftComposerImagePreviewUrls,
  revokeDraftPreviewUrls,
  revokeObjectPreviewUrl,
  revokePromptHistorySavedDraftPreviewUrls,
  revokeQueuedTurnPreviewUrls,
  syncPersistedAttachmentsForSlot,
} from "./composerDraftAttachments";
import { deleteComposerAsset } from "./lib/composerAssetStore";
import {
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  type ComposerThreadDraftState,
  type DraftThreadState,
  assistantSelectionDedupKey,
  buildDraftThreadState,
  buildTransferredComposerDraft,
  createEmptyThreadDraft,
  draftThreadStatesEqual,
  fileCommentDedupKey,
  normalizeAssistantSelection,
  normalizeAssistantSelections,
  normalizeDraftThreadEntryPoint,
  normalizeFileComment,
  normalizeFileComments,
  normalizePastedTexts,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  projectDraftThreadMappingKey,
  projectIdFromDraftThreadMappingKey,
  removeProjectDraftMappingsForThread,
  shouldRemoveDraft,
  terminalContextDedupKey,
} from "./composerDraftDomain";

import {
  COMPOSER_PROVIDER_KINDS,
  makeModelSelection,
  normalizeModelSelection,
  normalizeProviderKind,
  normalizeProviderModelOptions,
  reconcileProviderScopedModelSelection,
  stripNonStickyModelOptions,
} from "./composerDraftModels";
import { ensureInlineTerminalContextPlaceholders } from "./lib/terminalContext";
import { buildModelSelection } from "./providerModelOptions";
import { DEFAULT_RUNTIME_MODE } from "./types";

function draftReferencesComposerAsset(draft: ComposerThreadDraftState, assetKey: string): boolean {
  if (draft.files.some((file) => file.assetKey === assetKey)) return true;
  if (draft.promptHistorySavedDraft?.files.some((file) => file.assetKey === assetKey)) return true;
  return draft.queuedTurns.some(
    (turn) => turn.kind === "chat" && turn.files.some((file) => file.assetKey === assetKey),
  );
}

function deleteUnreferencedComposerFileAssets(
  assetKeys: ReadonlyArray<string>,
  getDrafts: () => ComposerDraftStoreState["draftsByThreadId"],
): void {
  if (assetKeys.length === 0) return;
  Promise.resolve().then(() => {
    const drafts = Object.values(getDrafts());
    for (const assetKey of new Set(assetKeys)) {
      if (drafts.some((draft) => draftReferencesComposerAsset(draft, assetKey))) continue;
      void deleteComposerAsset(assetKey).catch((error: unknown) => {
        console.warn("[composer-files] Could not delete persisted attachment.", error);
      });
    }
  });
}

function composerFileAssetKeys(draft: ComposerThreadDraftState | undefined): string[] {
  if (!draft) return [];
  return [
    ...draft.files,
    ...(draft.promptHistorySavedDraft?.files ?? []),
    ...draft.queuedTurns.flatMap((turn) => (turn.kind === "chat" ? turn.files : [])),
  ].flatMap((file) => (file.assetKey ? [file.assetKey] : []));
}

function removeDraftThreadIfUnmapped(input: {
  threadId: ThreadId | undefined;
  projectDraftThreadIdByProjectId: Record<string, ThreadId>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  getDraftsByThreadId: () => Record<ThreadId, ComposerThreadDraftState>;
}): {
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
} {
  if (
    !input.threadId ||
    Object.values(input.projectDraftThreadIdByProjectId).includes(input.threadId)
  ) {
    return {
      draftThreadsByThreadId: input.draftThreadsByThreadId,
      draftsByThreadId: input.draftsByThreadId,
    };
  }

  const nextDraftThreadsByThreadId = { ...input.draftThreadsByThreadId };
  delete nextDraftThreadsByThreadId[input.threadId];
  const removedDraft = input.draftsByThreadId[input.threadId];
  if (!removedDraft) {
    return {
      draftThreadsByThreadId: nextDraftThreadsByThreadId,
      draftsByThreadId: input.draftsByThreadId,
    };
  }

  revokeDraftPreviewUrls(removedDraft);
  deleteDraftComposerImageBlobs(removedDraft, input.getDraftsByThreadId);
  deleteUnreferencedComposerFileAssets(
    composerFileAssetKeys(removedDraft),
    input.getDraftsByThreadId,
  );
  const nextDraftsByThreadId = { ...input.draftsByThreadId };
  delete nextDraftsByThreadId[input.threadId];
  return {
    draftThreadsByThreadId: nextDraftThreadsByThreadId,
    draftsByThreadId: nextDraftsByThreadId,
  };
}

export const createComposerDraftStoreState =
  (flushPersistStorage: () => void): StateCreator<ComposerDraftStoreState> =>
  (set, get) => ({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyConnectionByProvider: {},
    stickyActiveProvider: null,
    getDraftThreadByProjectId: (projectId, entryPoint = "chat") => {
      if (projectId.length === 0) {
        return null;
      }
      const threadId =
        get().projectDraftThreadIdByProjectId[projectDraftThreadMappingKey(projectId, entryPoint)];
      if (!threadId) {
        return null;
      }
      const draftThread = get().draftThreadsByThreadId[threadId];
      if (
        !draftThread ||
        draftThread.projectId !== projectId ||
        normalizeDraftThreadEntryPoint(draftThread.entryPoint) !== entryPoint ||
        draftThread.promotedTo !== undefined
      ) {
        return null;
      }
      return {
        threadId,
        ...draftThread,
      };
    },
    getDraftThread: (threadId) => {
      if (threadId.length === 0) {
        return null;
      }
      return get().draftThreadsByThreadId[threadId] ?? null;
    },
    setProjectDraftThreadId: (projectId, threadId, options) => {
      if (projectId.length === 0 || threadId.length === 0) {
        return;
      }
      set((state) => {
        const existingThread = state.draftThreadsByThreadId[threadId];
        const nextDraftThread = buildDraftThreadState({
          projectId,
          existingThread,
          options,
          createdAtMode: "accept-empty",
        });
        const mappingKey = projectDraftThreadMappingKey(projectId, nextDraftThread.entryPoint);
        const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[mappingKey];
        const hasSameProjectMapping = previousThreadIdForProject === threadId;
        if (hasSameProjectMapping && draftThreadStatesEqual(existingThread, nextDraftThread)) {
          return state;
        }
        const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
          ...state.projectDraftThreadIdByProjectId,
          [mappingKey]: threadId,
        };
        const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
          ...state.draftThreadsByThreadId,
          [threadId]: nextDraftThread,
        };
        const cleanedDrafts =
          previousThreadIdForProject === threadId
            ? {
                draftThreadsByThreadId: nextDraftThreadsByThreadId,
                draftsByThreadId: state.draftsByThreadId,
              }
            : removeDraftThreadIfUnmapped({
                threadId: previousThreadIdForProject,
                projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
                draftThreadsByThreadId: nextDraftThreadsByThreadId,
                draftsByThreadId: state.draftsByThreadId,
                getDraftsByThreadId: () => get().draftsByThreadId,
              });
        return {
          draftsByThreadId: cleanedDrafts.draftsByThreadId,
          draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    registerDraftThread: (threadId, options) => {
      if (threadId.length === 0 || options.projectId.length === 0) {
        return;
      }
      set((state) => {
        if (state.draftThreadsByThreadId[threadId]) {
          return state;
        }
        const nextDraftThread: DraftThreadState = {
          projectId: options.projectId,
          spaceId: options.spaceId ?? null,
          createdAt: options.createdAt ?? new Date().toISOString(),
          runtimeMode: options.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          entryPoint: options.entryPoint ?? "chat",
          workingDirectory: options.workingDirectory ?? null,
        };
        return {
          draftThreadsByThreadId: {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          },
        };
      });
    },
    setDraftThreadContext: (threadId, options) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadId[threadId];
        if (!existing) {
          return state;
        }
        const nextProjectId = options.projectId ?? existing.projectId;
        if (nextProjectId.length === 0) {
          return state;
        }
        const nextDraftThread = buildDraftThreadState({
          projectId: nextProjectId,
          existingThread: existing,
          options,
          createdAtMode: "preserve-existing-on-empty",
        });
        if (draftThreadStatesEqual(existing, nextDraftThread)) {
          return state;
        }
        const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
          ...removeProjectDraftMappingsForThread(state.projectDraftThreadIdByProjectId, threadId),
          [projectDraftThreadMappingKey(nextProjectId, nextDraftThread.entryPoint)]: threadId,
        };
        return {
          draftThreadsByThreadId: {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          },
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    moveDraftThreadToProject: (threadId, projectId, options) => {
      if (threadId.length === 0 || projectId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadId[threadId];
        if (!existing) {
          return state;
        }
        const nextDraftThread = buildDraftThreadState({
          projectId,
          existingThread: existing,
          options,
          createdAtMode: "preserve-existing-on-empty",
        });
        const targetMappingKey = projectDraftThreadMappingKey(
          projectId,
          nextDraftThread.entryPoint,
        );
        const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[targetMappingKey];
        const hasOnlyTargetMapping = Object.entries(state.projectDraftThreadIdByProjectId).every(
          ([mappingKey, mappedThreadId]) =>
            mappedThreadId !== threadId || mappingKey === targetMappingKey,
        );
        if (
          previousThreadIdForProject === threadId &&
          hasOnlyTargetMapping &&
          draftThreadStatesEqual(existing, nextDraftThread)
        ) {
          return state;
        }

        const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
          ...removeProjectDraftMappingsForThread(state.projectDraftThreadIdByProjectId, threadId),
          [targetMappingKey]: threadId,
        };

        const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
          ...state.draftThreadsByThreadId,
          [threadId]: nextDraftThread,
        };
        const cleanedDrafts =
          previousThreadIdForProject === threadId
            ? {
                draftThreadsByThreadId: nextDraftThreadsByThreadId,
                draftsByThreadId: state.draftsByThreadId,
              }
            : removeDraftThreadIfUnmapped({
                threadId: previousThreadIdForProject,
                projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
                draftThreadsByThreadId: nextDraftThreadsByThreadId,
                draftsByThreadId: state.draftsByThreadId,
                getDraftsByThreadId: () => get().draftsByThreadId,
              });

        return {
          draftsByThreadId: cleanedDrafts.draftsByThreadId,
          draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    clearProjectDraftThreadId: (projectId, entryPoint = "chat") => {
      if (projectId.length === 0) {
        return;
      }
      set((state) => {
        const mappingKey = projectDraftThreadMappingKey(projectId, entryPoint);
        const threadId = state.projectDraftThreadIdByProjectId[mappingKey];
        if (threadId === undefined) {
          return state;
        }
        const { [mappingKey]: _removed, ...restProjectMappingsRaw } =
          state.projectDraftThreadIdByProjectId;
        const restProjectMappings = restProjectMappingsRaw as Record<string, ThreadId>;
        const cleanedDrafts = removeDraftThreadIfUnmapped({
          threadId,
          projectDraftThreadIdByProjectId: restProjectMappings,
          draftThreadsByThreadId: state.draftThreadsByThreadId,
          draftsByThreadId: state.draftsByThreadId,
          getDraftsByThreadId: () => get().draftsByThreadId,
        });
        return {
          draftsByThreadId: cleanedDrafts.draftsByThreadId,
          draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: restProjectMappings,
        };
      });
    },
    clearProjectDraftThreads: (projectId) => {
      if (projectId.length === 0) {
        return;
      }
      set((state) => {
        const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {};
        const removedThreadIds = new Set<ThreadId>();
        for (const [mappingKey, threadId] of Object.entries(
          state.projectDraftThreadIdByProjectId,
        )) {
          if (projectIdFromDraftThreadMappingKey(mappingKey) === projectId) {
            removedThreadIds.add(threadId);
            continue;
          }
          nextProjectDraftThreadIdByProjectId[mappingKey] = threadId;
        }
        if (removedThreadIds.size === 0) {
          return state;
        }
        let cleanedDrafts = {
          draftThreadsByThreadId: state.draftThreadsByThreadId,
          draftsByThreadId: state.draftsByThreadId,
        };
        for (const threadId of removedThreadIds) {
          cleanedDrafts = removeDraftThreadIfUnmapped({
            threadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
            draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
            draftsByThreadId: cleanedDrafts.draftsByThreadId,
            getDraftsByThreadId: () => get().draftsByThreadId,
          });
        }
        return {
          draftsByThreadId: cleanedDrafts.draftsByThreadId,
          draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    clearProjectDraftThreadById: (projectId, threadId) => {
      if (projectId.length === 0 || threadId.length === 0) {
        return;
      }
      set((state) => {
        const matchingMappingKey = Object.entries(state.projectDraftThreadIdByProjectId).find(
          ([mappingKey, mappedThreadId]) =>
            projectIdFromDraftThreadMappingKey(mappingKey) === projectId &&
            mappedThreadId === threadId,
        )?.[0];
        if (!matchingMappingKey) {
          return state;
        }
        const { [matchingMappingKey]: _removed, ...restProjectMappingsRaw } =
          state.projectDraftThreadIdByProjectId;
        const restProjectMappings = restProjectMappingsRaw as Record<string, ThreadId>;
        const cleanedDrafts = removeDraftThreadIfUnmapped({
          threadId,
          projectDraftThreadIdByProjectId: restProjectMappings,
          draftThreadsByThreadId: state.draftThreadsByThreadId,
          draftsByThreadId: state.draftsByThreadId,
          getDraftsByThreadId: () => get().draftsByThreadId,
        });
        return {
          draftsByThreadId: cleanedDrafts.draftsByThreadId,
          draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: restProjectMappings,
        };
      });
    },
    markDraftThreadPromoting: (threadId, promotedTo) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadId[threadId];
        if (!existing) {
          return state;
        }
        const nextPromotedTo = promotedTo ?? threadId;
        if (existing.promotedTo === nextPromotedTo) {
          return state;
        }
        return {
          draftThreadsByThreadId: {
            ...state.draftThreadsByThreadId,
            [threadId]: {
              ...existing,
              promotedTo: nextPromotedTo,
            },
          },
        };
      });
    },
    finalizePromotedDraftThread: (threadId) => {
      const draftThread = get().draftThreadsByThreadId[threadId];
      if (!draftThread?.promotedTo) {
        return;
      }
      get().clearDraftThread(threadId);
    },
    clearDraftThread: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      const removedDraft = get().draftsByThreadId[threadId];
      revokeDraftPreviewUrls(removedDraft);
      deleteDraftComposerImageBlobs(removedDraft, () => get().draftsByThreadId);
      deleteUnreferencedComposerFileAssets(
        composerFileAssetKeys(removedDraft),
        () => get().draftsByThreadId,
      );
      set((state) => {
        const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
        const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
          threadId,
        );
        const hasComposerDraft = state.draftsByThreadId[threadId] !== undefined;
        if (!hasDraftThread && !hasProjectMapping && !hasComposerDraft) {
          return state;
        }
        const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
          Object.entries(state.projectDraftThreadIdByProjectId).filter(
            ([, draftThreadId]) => draftThreadId !== threadId,
          ),
        ) as Record<string, ThreadId>;
        const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
          state.draftThreadsByThreadId;
        const { [threadId]: _removedComposerDraft, ...restDraftsByThreadId } =
          state.draftsByThreadId;
        return {
          draftsByThreadId: restDraftsByThreadId,
          draftThreadsByThreadId: restDraftThreadsByThreadId,
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    setStickyModelSelection: (modelSelection) => {
      const rawNormalized = normalizeModelSelection(modelSelection);
      const normalized = rawNormalized ? stripNonStickyModelOptions(rawNormalized) : null;
      set((state) => {
        if (!normalized) {
          return state;
        }
        const nextMap: Partial<Record<ProviderKind, ModelSelection>> = {
          ...state.stickyModelSelectionByProvider,
          [normalized.provider]: normalized,
        };
        if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
          return state.stickyActiveProvider === normalized.provider
            ? state
            : { stickyActiveProvider: normalized.provider };
        }
        return {
          stickyModelSelectionByProvider: nextMap,
          stickyActiveProvider: normalized.provider,
        };
      });
    },
    applyStickyState: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const stickyMap = state.stickyModelSelectionByProvider;
        const stickyActiveProvider = state.stickyActiveProvider;
        if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null) {
          return state;
        }
        const existing = state.draftsByThreadId[threadId];
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        for (const [provider, selection] of Object.entries(stickyMap)) {
          if (selection) {
            const current = nextMap[provider as ProviderKind];
            nextMap[provider as ProviderKind] =
              current && current.model !== selection.model ? current : selection;
          }
        }
        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          base.activeProvider === stickyActiveProvider
        ) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
          activeProvider: stickyActiveProvider,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setPrompt: (threadId, prompt) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const storedDraft = state.draftsByThreadId[threadId];
        if ((!storedDraft && prompt.length === 0) || storedDraft?.prompt === prompt) {
          return state;
        }
        const existing = storedDraft ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    applyVoiceTranscript: (threadId, jobId, transcript) => {
      if (threadId.length === 0 || jobId.length === 0) return null;
      const normalizedTranscript = transcript.trim();
      if (normalizedTranscript.length === 0) return null;
      let appliedPrompt: string | null = null;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        if (existing.appliedVoiceJobIds?.includes(jobId)) {
          appliedPrompt = existing.prompt;
          return state;
        }
        const currentPrompt = existing.prompt.trimEnd();
        appliedPrompt =
          currentPrompt.length > 0
            ? `${currentPrompt}\n\n${normalizedTranscript}`
            : normalizedTranscript;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              prompt: appliedPrompt,
              appliedVoiceJobIds: [...(existing.appliedVoiceJobIds ?? []), jobId],
            },
          },
        };
      });
      return appliedPrompt;
    },
    setPromptHistorySavedDraft: (threadId, savedDraft) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if ((existing?.promptHistorySavedDraft ?? null) === savedDraft) {
          return state;
        }
        if (existing?.promptHistorySavedDraft) {
          revokePromptHistorySavedDraftPreviewUrls(existing?.promptHistorySavedDraft);
          if (savedDraft === null) {
            deletePersistedComposerImageBlobs(
              existing.promptHistorySavedDraft.persistedAttachments,
              () => get().draftsByThreadId,
            );
          }
        }
        const nextDraft: ComposerThreadDraftState = {
          ...(existing ?? createEmptyThreadDraft()),
          promptHistorySavedDraft: savedDraft,
          ...(savedDraft !== null
            ? {
                images: [],
                files: [],
                nonPersistedImageIds: [],
                persistedAttachments: [],
                assistantSelections: [],
                terminalContexts: [],
                fileComments: [],
                pastedTexts: [],
                skills: [],
                mentions: [],
              }
            : {}),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    restorePromptHistorySavedDraft: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        const savedDraft = current?.promptHistorySavedDraft ?? null;
        if (!current || !savedDraft) {
          return state;
        }
        const restoredImageIds = new Set(savedDraft.images.map((image) => image.id));
        for (const image of current.images) {
          if (!restoredImageIds.has(image.id)) {
            revokeObjectPreviewUrl(image.previewUrl);
          }
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: savedDraft.prompt,
          promptHistorySavedDraft: null,
          images: savedDraft.images,
          files: [...savedDraft.files],
          nonPersistedImageIds: [...savedDraft.nonPersistedImageIds],
          persistedAttachments: [...savedDraft.persistedAttachments],
          assistantSelections: normalizeAssistantSelections(savedDraft.assistantSelections),
          terminalContexts: normalizeTerminalContextsForThread(
            threadId,
            savedDraft.terminalContexts,
          ),
          fileComments: normalizeFileComments(savedDraft.fileComments),
          pastedTexts: normalizePastedTexts(savedDraft.pastedTexts),
          skills: [...savedDraft.skills],
          mentions: [...savedDraft.mentions],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addPromptHistorySavedDraftImage: (threadId, image) => {
      if (threadId.length === 0) return;
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        const savedDraft = current?.promptHistorySavedDraft ?? null;
        if (!current || !savedDraft) {
          revokeObjectPreviewUrl(image.previewUrl);
          return state;
        }
        const images = mergeComposerImages(savedDraft.images, [image]);
        if (!images) return state;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...current,
              promptHistorySavedDraft: {
                ...savedDraft,
                images,
              },
            },
          },
        };
      });
    },
    syncPromptHistorySavedDraftPersistedAttachments: (threadId, attachments) =>
      syncPersistedAttachmentsForSlot(
        threadId,
        attachments,
        get,
        set,
        PROMPT_HISTORY_ATTACHMENT_SLOT,
        flushPersistStorage,
      ),
    setTerminalContexts: (threadId, contexts) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt: ensureInlineTerminalContextPlaceholders(
            existing.prompt,
            normalizedContexts.length,
          ),
          terminalContexts: normalizedContexts,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setSkills: (threadId, skills) => {
      if (threadId.length === 0) {
        return;
      }
      const nextSkills = [...skills];
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        if (Equal.equals(existing.skills, nextSkills)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          skills: nextSkills,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setMentions: (threadId, mentions) => {
      if (threadId.length === 0) {
        return;
      }
      const nextMentions = [...mentions];
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        if (Equal.equals(existing.mentions, nextMentions)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          mentions: nextMentions,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setModelSelection: (threadId, modelSelection) => {
      if (threadId.length === 0) {
        return;
      }
      const normalized = normalizeModelSelection(modelSelection);
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && normalized === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        if (normalized) {
          const current = nextMap[normalized.provider];
          nextMap[normalized.provider] = reconcileProviderScopedModelSelection(normalized, current);
        }
        const nextActiveProvider = normalized?.provider ?? base.activeProvider;
        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          base.activeProvider === nextActiveProvider
        ) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
          activeProvider: nextActiveProvider,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setModelSelectionAndSticky: (threadId, modelSelection) => {
      get().setModelSelection(threadId, modelSelection);
      const correctedSelection =
        get().draftsByThreadId[threadId]?.modelSelectionByProvider[modelSelection.provider];
      get().setStickyModelSelection(correctedSelection ?? modelSelection);
    },
    setModelOptions: (threadId, modelOptions) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedOpts = normalizeProviderModelOptions(modelOptions);
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && normalizedOpts === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        for (const provider of COMPOSER_PROVIDER_KINDS) {
          // Only touch providers explicitly present in the input
          if (!normalizedOpts || !(provider in normalizedOpts)) continue;
          const opts = normalizedOpts[provider];
          const current = nextMap[provider];
          if (opts) {
            const model = current?.model ?? getDefaultModel(provider);
            if (!model) continue;
            nextMap[provider] = makeModelSelection(provider, model, opts);
          } else if (current?.options) {
            // Remove options but keep the selection
            nextMap[provider] = buildModelSelection(provider, current.model);
          }
        }
        if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setProviderModelOptions: (threadId, provider, nextProviderOptions, options) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedProvider = normalizeProviderKind(provider);
      if (normalizedProvider === null) {
        return;
      }
      // Normalize just this provider's options
      const normalizedOpts = normalizeProviderModelOptions(
        { [normalizedProvider]: nextProviderOptions },
        normalizedProvider,
      );
      const providerOpts = normalizedOpts?.[normalizedProvider];
      const fallbackModel =
        normalizeModelSlug(options?.model, normalizedProvider) ??
        getDefaultModel(normalizedProvider);

      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        const base = existing ?? createEmptyThreadDraft();

        // Update the map entry for this provider
        const nextMap = { ...base.modelSelectionByProvider };
        const currentForProvider = nextMap[normalizedProvider];
        if (providerOpts) {
          const nextModel = currentForProvider?.model ?? fallbackModel;
          if (!nextModel) {
            return state;
          }
          nextMap[normalizedProvider] = makeModelSelection(
            normalizedProvider,
            nextModel,
            providerOpts,
          );
        } else if (currentForProvider?.options) {
          nextMap[normalizedProvider] = buildModelSelection(
            normalizedProvider,
            currentForProvider.model,
          );
        }

        // Handle sticky persistence
        let nextStickyMap = state.stickyModelSelectionByProvider;
        let nextStickyActiveProvider = state.stickyActiveProvider;
        if (options?.persistSticky === true) {
          nextStickyMap = { ...state.stickyModelSelectionByProvider };
          const stickyBase =
            nextStickyMap[normalizedProvider] ??
            base.modelSelectionByProvider[normalizedProvider] ??
            (fallbackModel ? makeModelSelection(normalizedProvider, fallbackModel) : null);
          if (!stickyBase) {
            return state;
          }
          if (providerOpts) {
            nextStickyMap[normalizedProvider] = stripNonStickyModelOptions(
              makeModelSelection(normalizedProvider, stickyBase.model, providerOpts),
            );
          } else if (stickyBase.options) {
            nextStickyMap[normalizedProvider] = buildModelSelection(
              normalizedProvider,
              stickyBase.model,
            );
          }
          nextStickyActiveProvider = base.activeProvider ?? normalizedProvider;
        }

        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
          state.stickyActiveProvider === nextStickyActiveProvider
        ) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }

        return {
          draftsByThreadId: nextDraftsByThreadId,
          ...(options?.persistSticky === true
            ? {
                stickyModelSelectionByProvider: nextStickyMap,
                stickyActiveProvider: nextStickyActiveProvider,
              }
            : {}),
        };
      });
    },
    setRuntimeMode: (threadId, runtimeMode) => {
      if (threadId.length === 0) {
        return;
      }
      const nextRuntimeMode =
        runtimeMode === "approval-required" || runtimeMode === "full-access" ? runtimeMode : null;
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && nextRuntimeMode === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        if (base.runtimeMode === nextRuntimeMode) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          runtimeMode: nextRuntimeMode,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    // Keep queued follow-ups with the thread draft so route changes do not hide them.
    enqueueQueuedTurn: (threadId, queuedTurn) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              queuedTurns: [...existing.queuedTurns, queuedTurn],
            },
          },
        };
      });
    },
    insertQueuedTurn: (threadId, queuedTurn, index) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const boundedIndex = Math.max(0, Math.min(existing.queuedTurns.length, index));
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              queuedTurns: [
                ...existing.queuedTurns.slice(0, boundedIndex),
                queuedTurn,
                ...existing.queuedTurns.slice(boundedIndex),
              ],
            },
          },
        };
      });
    },
    markQueuedTurnServerAccepted: (threadId, queuedTurnId, acceptedAt) => {
      if (threadId.length === 0 || queuedTurnId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        const queuedTurnIndex = current?.queuedTurns.findIndex(
          (entry) => entry.id === queuedTurnId,
        );
        if (!current || queuedTurnIndex === undefined || queuedTurnIndex < 0) {
          return state;
        }
        const queuedTurn = current.queuedTurns[queuedTurnIndex]!;
        if (queuedTurn.serverAcceptedAt === acceptedAt) {
          return state;
        }
        const queuedTurns = [...current.queuedTurns];
        queuedTurns[queuedTurnIndex] = { ...queuedTurn, serverAcceptedAt: acceptedAt };
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: { ...current, queuedTurns },
          },
        };
      });
    },
    setQueuedTurnDispatchAdmission: (threadId, queuedTurnId, attempt, bindingRevision) => {
      if (
        threadId.length === 0 ||
        queuedTurnId.length === 0 ||
        !Number.isSafeInteger(attempt) ||
        attempt < 0 ||
        !Number.isSafeInteger(bindingRevision) ||
        bindingRevision < 0
      ) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        const queuedTurnIndex = current?.queuedTurns.findIndex(
          (entry) => entry.id === queuedTurnId,
        );
        if (!current || queuedTurnIndex === undefined || queuedTurnIndex < 0) {
          return state;
        }
        const queuedTurn = current.queuedTurns[queuedTurnIndex]!;
        if (
          queuedTurn.kind !== "chat" ||
          (queuedTurn.dispatchAttempt === attempt &&
            queuedTurn.dispatchBindingRevision === bindingRevision)
        ) {
          return state;
        }
        const queuedTurns = [...current.queuedTurns];
        queuedTurns[queuedTurnIndex] = {
          ...queuedTurn,
          dispatchAttempt: attempt,
          dispatchBindingRevision: bindingRevision,
        };
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: { ...current, queuedTurns },
          },
        };
      });
    },
    advanceQueuedTurnDispatchAttempt: (threadId, queuedTurnId) => {
      if (threadId.length === 0 || queuedTurnId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        const queuedTurnIndex = current?.queuedTurns.findIndex(
          (entry) => entry.id === queuedTurnId,
        );
        if (!current || queuedTurnIndex === undefined || queuedTurnIndex < 0) {
          return state;
        }
        const queuedTurn = current.queuedTurns[queuedTurnIndex]!;
        if (queuedTurn.kind !== "chat") {
          return state;
        }
        const queuedTurns = [...current.queuedTurns];
        const { dispatchBindingRevision: _discardedRevision, ...retained } = queuedTurn;
        queuedTurns[queuedTurnIndex] = {
          ...retained,
          dispatchAttempt: (queuedTurn.dispatchAttempt ?? 0) + 1,
        };
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: { ...current, queuedTurns },
          },
        };
      });
    },
    removeQueuedTurn: (threadId, queuedTurnId) => {
      if (threadId.length === 0 || queuedTurnId.length === 0) {
        return;
      }
      const removedQueuedTurn = get().draftsByThreadId[threadId]?.queuedTurns.find(
        (entry) => entry.id === queuedTurnId,
      );
      if (removedQueuedTurn) {
        revokeQueuedTurnPreviewUrls(removedQueuedTurn);
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.queuedTurns.every((entry) => entry.id !== queuedTurnId)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          queuedTurns: current.queuedTurns.filter((entry) => entry.id !== queuedTurnId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setQueuePaused: (threadId, paused) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        if (current.queuePaused === paused) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = { ...current, queuePaused: paused };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addImage: (threadId, image) => {
      if (threadId.length === 0) {
        return;
      }
      get().addImages(threadId, [image]);
    },
    addImages: (threadId, images) => {
      if (threadId.length === 0 || images.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const mergedImages = mergeComposerImages(existing.images, images);
        if (!mergedImages) return state;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              images: mergedImages,
            },
          },
        };
      });
    },
    removeImage: (threadId, imageId) => {
      if (threadId.length === 0) {
        return;
      }
      const existing = get().draftsByThreadId[threadId];
      if (!existing) {
        return;
      }
      const removedImage = existing.images.find((image) => image.id === imageId);
      const removedPersistedAttachment = existing.persistedAttachments.find(
        (attachment) => attachment.id === imageId,
      );
      if (removedImage) {
        revokeObjectPreviewUrl(removedImage.previewUrl);
      }
      if (removedPersistedAttachment) {
        deletePersistedComposerImageBlobs(
          [removedPersistedAttachment],
          () => get().draftsByThreadId,
        );
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          images: current.images.filter((image) => image.id !== imageId),
          nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
          persistedAttachments: current.persistedAttachments.filter(
            (attachment) => attachment.id !== imageId,
          ),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addFiles: (threadId, files) => {
      if (threadId.length === 0 || files.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const existingIds = new Set(existing.files.map((file) => file.id));
        const existingDedupKeys = new Set(existing.files.map((file) => composerFileDedupKey(file)));
        const dedupedIncoming: ComposerFileAttachment[] = [];
        for (const file of files) {
          const dedupKey = composerFileDedupKey(file);
          if (existingIds.has(file.id) || existingDedupKeys.has(dedupKey)) {
            continue;
          }
          dedupedIncoming.push(file);
          existingIds.add(file.id);
          existingDedupKeys.add(dedupKey);
        }
        if (dedupedIncoming.length === 0) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              files: [...existing.files, ...dedupedIncoming],
            },
          },
        };
      });
    },
    removeFile: (threadId, fileId) => {
      if (threadId.length === 0) {
        return;
      }
      const removedFile = get().draftsByThreadId[threadId]?.files.find(
        (file) => file.id === fileId,
      );
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          files: current.files.filter((file) => file.id !== fileId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
      if (removedFile?.assetKey) {
        deleteUnreferencedComposerFileAssets([removedFile.assetKey], () => get().draftsByThreadId);
      }
    },
    addAssistantSelection: (threadId, selection) => {
      if (threadId.length === 0) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const normalizedSelection = normalizeAssistantSelection(selection);
        if (!normalizedSelection) {
          return state;
        }
        const dedupKey = assistantSelectionDedupKey(normalizedSelection);
        if (
          existing.assistantSelections.some((entry) => entry.id === normalizedSelection.id) ||
          existing.assistantSelections.some(
            (entry) => assistantSelectionDedupKey(entry) === dedupKey,
          )
        ) {
          return state;
        }
        inserted = true;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              assistantSelections: [...existing.assistantSelections, normalizedSelection],
            },
          },
        };
      });
      return inserted;
    },
    removeAssistantSelection: (threadId, selectionId) => {
      if (threadId.length === 0 || selectionId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          assistantSelections: current.assistantSelections.filter(
            (selection) => selection.id !== selectionId,
          ),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearAssistantSelections: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.assistantSelections.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          assistantSelections: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addFileComment: (threadId, comment) => {
      if (threadId.length === 0) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const normalizedComment = normalizeFileComment(comment);
        if (!normalizedComment) {
          return state;
        }
        const dedupKey = fileCommentDedupKey(normalizedComment);
        if (
          existing.fileComments.some((entry) => entry.id === normalizedComment.id) ||
          existing.fileComments.some((entry) => fileCommentDedupKey(entry) === dedupKey)
        ) {
          return state;
        }
        inserted = true;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              fileComments: [...existing.fileComments, normalizedComment],
            },
          },
        };
      });
      return inserted;
    },
    removeFileComment: (threadId, commentId) => {
      if (threadId.length === 0 || commentId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          fileComments: current.fileComments.filter((comment) => comment.id !== commentId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearFileComments: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.fileComments.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          fileComments: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addPastedTexts: (threadId, pastedTexts) => {
      if (threadId.length === 0 || pastedTexts.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const acceptedPastedTexts = normalizePastedTexts([
          ...existing.pastedTexts,
          ...pastedTexts,
        ]).slice(existing.pastedTexts.length);
        if (acceptedPastedTexts.length === 0) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              pastedTexts: [...existing.pastedTexts, ...acceptedPastedTexts],
            },
          },
        };
      });
    },
    removePastedText: (threadId, pastedTextId) => {
      if (threadId.length === 0 || pastedTextId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          pastedTexts: current.pastedTexts.filter((pasted) => pasted.id !== pastedTextId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearPastedTexts: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.pastedTexts.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          pastedTexts: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    insertTerminalContext: (threadId, prompt, context, index) => {
      if (threadId.length === 0) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const normalizedContext = normalizeTerminalContextForThread(threadId, context);
        if (!normalizedContext) {
          return state;
        }
        const dedupKey = terminalContextDedupKey(normalizedContext);
        if (
          existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
          existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
        ) {
          return state;
        }
        inserted = true;
        const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
          terminalContexts: [
            ...existing.terminalContexts.slice(0, boundedIndex),
            normalizedContext,
            ...existing.terminalContexts.slice(boundedIndex),
          ],
        };
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: nextDraft,
          },
        };
      });
      return inserted;
    },
    addTerminalContext: (threadId, context) => {
      if (threadId.length === 0) {
        return;
      }
      get().addTerminalContexts(threadId, [context]);
    },
    addTerminalContexts: (threadId, contexts) => {
      if (threadId.length === 0 || contexts.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
          ...existing.terminalContexts,
          ...contexts,
        ]).slice(existing.terminalContexts.length);
        if (acceptedContexts.length === 0) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              prompt: ensureInlineTerminalContextPlaceholders(
                existing.prompt,
                existing.terminalContexts.length + acceptedContexts.length,
              ),
              terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
            },
          },
        };
      });
    },
    removeTerminalContext: (threadId, contextId) => {
      if (threadId.length === 0 || contextId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: current.terminalContexts.filter((context) => context.id !== contextId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearTerminalContexts: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.terminalContexts.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearPersistedAttachments: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      const existing = get().draftsByThreadId[threadId];
      if (existing) {
        deletePersistedComposerImageBlobs(
          existing.persistedAttachments,
          () => get().draftsByThreadId,
        );
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          persistedAttachments: [],
          nonPersistedImageIds: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    syncPersistedAttachments: (threadId, attachments) =>
      syncPersistedAttachmentsForSlot(
        threadId,
        attachments,
        get,
        set,
        DRAFT_ATTACHMENT_SLOT,
        flushPersistStorage,
      ),
    copyTransferableComposerState: (sourceThreadId, targetThreadId) => {
      if (sourceThreadId.length === 0 || targetThreadId.length === 0) {
        return;
      }
      set((state) => {
        const sourceDraft = state.draftsByThreadId[sourceThreadId];
        if (!sourceDraft) {
          return state;
        }
        const nextDraft = buildTransferredComposerDraft({
          sourceDraft,
          targetDraft: state.draftsByThreadId[targetThreadId],
          targetThreadId,
        });
        const currentTargetDraft = state.draftsByThreadId[targetThreadId];
        if (Equal.equals(currentTargetDraft, nextDraft)) {
          return state;
        }
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[targetThreadId];
        } else {
          nextDraftsByThreadId[targetThreadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearComposerContent: (threadId, options) => {
      if (threadId.length === 0) {
        return;
      }
      const clearedDraft = get().draftsByThreadId[threadId];
      deleteDraftComposerImageBlobs(clearedDraft, () => get().draftsByThreadId);
      deleteUnreferencedComposerFileAssets(
        composerFileAssetKeys(clearedDraft),
        () => get().draftsByThreadId,
      );
      if (options?.preservePreviewUrls !== true) {
        revokeDraftComposerImagePreviewUrls(clearedDraft);
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: "",
          appliedVoiceJobIds: [],
          promptHistorySavedDraft: null,
          images: [],
          files: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
          assistantSelections: [],
          terminalContexts: [],
          fileComments: [],
          pastedTexts: [],
          skills: [],
          mentions: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
  });
