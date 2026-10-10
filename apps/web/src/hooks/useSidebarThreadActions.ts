// FILE: useSidebarThreadActions.ts
// Purpose: Owns Sidebar thread pinning, archive/undo, deletion, and project-batch actions.
// Layer: Web Sidebar controller hook
// Exports: useSidebarThreadActions

import type { SidebarThreadRow } from "../sidebarThreadRows";
import { type FolderId, ThreadId } from "@penkra/contracts";
import { pluralize } from "@penkra/shared/text";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { AppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { showConfirmDialogFallback } from "../confirmDialogFallback";
import { getFallbackThreadIdAfterDelete, sortThreadsForSidebar } from "../components/Sidebar.logic";
import { toastManager } from "../components/ui/toast";
import { findNearestVisibleDeckThread } from "../lib/threadDeckNavigation";
import {
  beginLocalThreadArchiveNavigation,
  endLocalThreadArchiveNavigation,
} from "../lib/threadArchiveNavigation";
import { deleteActiveThreadFromClient } from "../lib/activeThreadDelete";
import { reconcileDeletedThreadsFromClient } from "../lib/deletedThreadClientReconciliation";
import { archiveThreadFromClient, unarchiveThreadFromClient } from "../lib/threadArchive";
import { newCommandId, randomUUID } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { useThreadSelectionStore } from "../threadSelectionStore";
import type { Project } from "../types";

const ARCHIVE_UNDO_TOAST_DURATION_MS = 8000;

async function unarchiveThreadIgnoringAlreadyRestored(threadId: ThreadId): Promise<void> {
  const api = readNativeApi();
  if (!api) throw new Error("Unable to connect to the app server.");
  await unarchiveThreadFromClient(api.cleanCore, threadId);
}

interface DeleteProjectThreadsOptions {
  readonly confirmMessage?: string | null;
  readonly showEmptyToast?: boolean;
  readonly showResultToast?: boolean;
}

export function useSidebarThreadActions(input: {
  readonly appSettings: Pick<AppSettings, "confirmThreadDelete" | "sidebarThreadSortOrder">;
  readonly clearTerminalState: (threadId: ThreadId) => void;
  readonly handleNewChat: (options?: { fresh?: boolean }) => Promise<unknown>;
  readonly projectById: ReadonlyMap<FolderId, Project>;
  readonly routeThreadId: ThreadId | null;
  readonly sidebarThreads: readonly SidebarThreadRow[];
  readonly sidebarTreeThreads: readonly SidebarThreadRow[];
  readonly sidebarThreadSummaryById: Readonly<Record<string, SidebarThreadRow>>;
  readonly threadsHydrated: boolean;
}) {
  const {
    appSettings,
    clearTerminalState,
    handleNewChat,
    projectById,
    routeThreadId,
    sidebarThreads,
    sidebarTreeThreads,
    sidebarThreadSummaryById,
  } = input;
  const navigate = useNavigate();
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const removeFromSelection = useThreadSelectionStore((store) => store.removeFromSelection);

  const archivePendingThreadIdsRef = useRef<Set<ThreadId>>(new Set());
  const archiveUndoPendingThreadIdsRef = useRef<Set<ThreadId>>(new Set());
  const sidebarThreadSummaryByIdRef = useRef(sidebarThreadSummaryById);
  useEffect(() => {
    sidebarThreadSummaryByIdRef.current = sidebarThreadSummaryById;
  }, [sidebarThreadSummaryById]);

  const pinnedThreadIds = useMemo(
    () =>
      sortThreadsForSidebar(sidebarTreeThreads, appSettings.sidebarThreadSortOrder)
        .filter((thread) => thread.isPinned)
        .map((thread) => thread.id),
    [sidebarTreeThreads, appSettings.sidebarThreadSortOrder],
  );
  const pinnedThreadIdSet = useMemo(() => new Set(pinnedThreadIds), [pinnedThreadIds]);
  const setThreadPinned = useCallback(async (threadId: ThreadId, isPinned: boolean) => {
    const api = readNativeApi();
    if (!api) throw new Error("Unable to connect to the app server.");
    await api.cleanCore.updateThread({
      update: { action: "pin", threadId, isPinned, updatedAt: new Date().toISOString() },
    });
  }, []);
  const toggleThreadPinned = useCallback(
    (threadId: ThreadId) => {
      const isPinned = pinnedThreadIdSet.has(threadId);
      void setThreadPinned(threadId, !isPinned).catch((error) => {
        console.error("Failed to update pinned thread state", { threadId, error });
        toastManager.add({
          type: "error",
          title: isPinned ? "Unable to unpin thread" : "Unable to pin thread",
        });
      });
    },
    [pinnedThreadIdSet, setThreadPinned],
  );

  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      opts: {
        deletedThreadIds?: ReadonlySet<ThreadId>;
        reconcileDeletedThread?: boolean;
      } = {},
    ): Promise<void> => {
      await deleteActiveThreadFromClient({
        threadId,
        ...(opts.reconcileDeletedThread !== undefined
          ? { reconcileDeletedThread: opts.reconcileDeletedThread }
          : {}),
        prepareForDelete: () => ({
          shouldNavigateToFallback: routeThreadId === threadId,
          fallbackThreadId: getFallbackThreadIdAfterDelete({
            threads: sidebarThreads,
            deletedThreadId: threadId,
            deletedThreadIds: opts.deletedThreadIds ?? new Set<ThreadId>(),
            sortOrder: appSettings.sidebarThreadSortOrder,
          }),
        }),
        onDeleted: ({ thread, prepared }) => {
          clearComposerDraftForThread(threadId);
          clearProjectDraftThreadById(thread.folderId, thread.id);
          clearTerminalState(threadId);

          if (prepared?.shouldNavigateToFallback) {
            if (prepared.fallbackThreadId) {
              void navigate({
                to: "/$threadId",
                params: { threadId: prepared.fallbackThreadId },
                replace: true,
              });
            } else {
              void handleNewChat({ fresh: true });
            }
          }
        },
      });
    },
    [
      appSettings.sidebarThreadSortOrder,
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      handleNewChat,
      navigate,
      routeThreadId,
      sidebarThreads,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (threadId: ThreadId) => {
      const thread = sidebarThreadSummaryById[threadId];
      if (!thread) return;
      if (appSettings.confirmThreadDelete) {
        const api = readNativeApi();
        const confirmationMessage = [
          `Delete thread "${thread.title}"?`,
          "This permanently clears conversation history for this thread.",
        ].join("\n");
        const confirmed = api
          ? await api.dialogs.confirm(confirmationMessage)
          : await showConfirmDialogFallback(confirmationMessage);
        if (!confirmed) return;
      }
      await deleteThread(threadId);
    },
    [deleteThread, appSettings.confirmThreadDelete, sidebarThreadSummaryById],
  );

  const archiveThread = useCallback(
    async (threadId: ThreadId): Promise<boolean> => {
      const api = readNativeApi();
      if (!api) return false;
      const thread = sidebarThreadSummaryByIdRef.current[threadId];
      if (!thread) return false;
      const stateBeforeArchive = useStore.getState();
      const deck = stateBeforeArchive.decks.find((candidate) => candidate.id === thread.deckId);
      const nearestDeckThreadId = deck
        ? findNearestVisibleDeckThread({
            threadIds: deck.threadIds,
            removedThreadId: threadId,
            isVisible: (candidateId) => {
              const candidate = getThreadFromState(stateBeforeArchive, candidateId);
              return candidate != null && candidate.archivedAt == null;
            },
          })
        : null;
      const pendingThreadIds = archivePendingThreadIdsRef.current;
      if (pendingThreadIds.has(threadId)) return false;

      pendingThreadIds.add(threadId);
      beginLocalThreadArchiveNavigation(threadId);
      const runArchive = async (): Promise<boolean> => {
        await archiveThreadFromClient(api.cleanCore, threadId);
        if (routeThreadId === threadId) {
          const fallbackThreadId =
            nearestDeckThreadId ??
            getFallbackThreadIdAfterDelete({
              threads: sidebarThreads,
              deletedThreadId: threadId,
              deletedThreadIds: new Set<ThreadId>(),
              sortOrder: appSettings.sidebarThreadSortOrder,
            });
          if (fallbackThreadId) {
            await navigate({
              to: "/$threadId",
              params: { threadId: fallbackThreadId },
              replace: true,
            });
          } else {
            await handleNewChat({ fresh: true });
          }
        }
        return true;
      };
      return runArchive().finally(() => {
        pendingThreadIds.delete(threadId);
        endLocalThreadArchiveNavigation(threadId);
      });
    },
    [appSettings.sidebarThreadSortOrder, handleNewChat, routeThreadId, sidebarThreads, navigate],
  );

  const restoreArchivedThreadFromToast = useCallback(
    async (restoreInput: {
      threadId: ThreadId;
      returnToThreadOnUndo: boolean;
    }): Promise<boolean> => {
      const pendingThreadIds = archiveUndoPendingThreadIdsRef.current;
      if (pendingThreadIds.has(restoreInput.threadId)) return false;
      pendingThreadIds.add(restoreInput.threadId);
      const runRestore = async (): Promise<boolean> => {
        try {
          const currentThread = getThreadFromState(useStore.getState(), restoreInput.threadId);
          if (!currentThread) {
            toastManager.add({
              type: "error",
              title: "Could not restore thread",
              description: "The thread no longer exists.",
            });
            return false;
          }
          await unarchiveThreadIgnoringAlreadyRestored(restoreInput.threadId);
          if (restoreInput.returnToThreadOnUndo) {
            void navigate({
              to: "/$threadId",
              params: { threadId: restoreInput.threadId },
              replace: true,
            });
          }
          return true;
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Could not restore thread",
            description: error instanceof Error ? error.message : "Unable to restore the thread.",
          });
          return false;
        }
      };
      return runRestore().finally(() => {
        pendingThreadIds.delete(restoreInput.threadId);
      });
    },
    [navigate],
  );

  const showArchiveUndoToast = useCallback(
    (threadId: ThreadId, options?: { returnToThreadOnUndo?: boolean }) => {
      toastManager.add({
        id: `archive-undo:${threadId}:${randomUUID()}`,
        timeout: 0,
        data: {
          allowCrossThreadVisibility: true,
          dismissAfterVisibleMs: ARCHIVE_UNDO_TOAST_DURATION_MS,
          archiveUndo: {
            onUndo: () =>
              restoreArchivedThreadFromToast({
                threadId,
                returnToThreadOnUndo: options?.returnToThreadOnUndo === true,
              }),
            onViewArchived: () => {
              void navigate({ to: "/settings", search: { section: "archived" } });
            },
          },
        },
      });
    },
    [navigate, restoreArchivedThreadFromToast],
  );

  const archiveThreadWithUndo = useCallback(
    async (threadId: ThreadId) => {
      try {
        const returnToThreadOnUndo = routeThreadId === threadId;
        const archived = await archiveThread(threadId);
        if (archived) showArchiveUndoToast(threadId, { returnToThreadOnUndo });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not archive thread",
          description: error instanceof Error ? error.message : "Unable to archive the thread.",
        });
      }
    },
    [archiveThread, routeThreadId, showArchiveUndoToast],
  );

  const confirmAndArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      const thread = sidebarThreadSummaryById[threadId];
      if (!thread) return;
      const api = readNativeApi();
      const confirmationMessage = `Archive thread "${thread.title}"?`;
      const confirmed = api
        ? await api.dialogs.confirm(confirmationMessage)
        : await showConfirmDialogFallback(confirmationMessage);
      if (!confirmed) return;
      await archiveThreadWithUndo(threadId);
    },
    [archiveThreadWithUndo, sidebarThreadSummaryById],
  );

  const archiveAllThreadsInProject = useCallback(
    async (folderId: FolderId): Promise<void> => {
      const api = readNativeApi();
      const project = projectById.get(folderId);
      if (!api || !project) return;
      const projectThreads = sidebarThreads.filter(
        (thread) => thread.folderId === folderId && thread.archivedAt == null,
      );
      if (projectThreads.length === 0) {
        toastManager.add({
          type: "info",
          title: "Nothing to archive",
          description: `"${project.name}" has no threads to archive.`,
        });
        return;
      }
      const confirmationMessage = `Archive ${projectThreads.length} ${pluralize(projectThreads.length, "thread")} in "${project.name}"?`;
      const confirmed = api
        ? await api.dialogs.confirm(confirmationMessage)
        : await showConfirmDialogFallback(confirmationMessage);
      if (!confirmed) return;

      let archivedCount = 0;
      let failureCount = 0;
      for (const thread of projectThreads) {
        try {
          if (await archiveThread(thread.id)) archivedCount += 1;
          else failureCount += 1;
        } catch (error) {
          failureCount += 1;
          console.error("Failed to archive thread during bulk archive", {
            threadId: thread.id,
            folderId,
            error,
          });
        }
      }
      removeFromSelection(projectThreads.map((thread) => thread.id));
      if (archivedCount > 0) {
        toastManager.add({
          type: failureCount > 0 ? "warning" : "success",
          title: archivedCount === 1 ? "Thread archived" : `Archived ${archivedCount} threads`,
          description:
            failureCount > 0
              ? `Failed to archive ${failureCount} ${pluralize(failureCount, "thread")}.`
              : `"${project.name}" cleared.`,
        });
      } else if (failureCount > 0) {
        toastManager.add({
          type: "error",
          title: "Failed to archive threads",
          description: `Could not archive ${failureCount} ${pluralize(failureCount, "thread")} in "${project.name}".`,
        });
      }
    },
    [archiveThread, projectById, sidebarThreads, removeFromSelection],
  );

  const deleteProjectThreads = useCallback(
    async (folderId: FolderId, options?: DeleteProjectThreadsOptions) => {
      const api = readNativeApi();
      const project = projectById.get(folderId);
      if (!api || !project) return null;
      const projectThreads = sidebarThreads.filter((thread) => thread.folderId === folderId);
      if (projectThreads.length === 0) {
        if (options?.showEmptyToast ?? true) {
          toastManager.add({
            type: "info",
            title: "Nothing to delete",
            description: `"${project.name}" has no threads to delete.`,
          });
        }
        return {
          deletedCount: 0,
          failureCount: 0,
          totalCount: 0,
          projectName: project.name,
        };
      }
      const confirmationMessage =
        options?.confirmMessage === undefined
          ? [
              `Delete ${projectThreads.length} ${pluralize(projectThreads.length, "thread")} in "${project.name}"?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n")
          : options.confirmMessage;
      if (confirmationMessage !== null) {
        const confirmed = await api.dialogs.confirm(confirmationMessage);
        if (!confirmed) return null;
      }

      const deletedIds = new Set<ThreadId>(projectThreads.map((thread) => thread.id));
      const successfullyDeletedIds: ThreadId[] = [];
      let deletedCount = 0;
      let failureCount = 0;
      for (const thread of projectThreads) {
        try {
          await deleteThread(thread.id, {
            deletedThreadIds: deletedIds,
            reconcileDeletedThread: false,
          });
          successfullyDeletedIds.push(thread.id);
          deletedCount += 1;
        } catch (error) {
          failureCount += 1;
          console.error("Failed to delete thread during bulk delete", {
            threadId: thread.id,
            folderId,
            error,
          });
        }
      }
      void reconcileDeletedThreadsFromClient({
        threadIds: successfullyDeletedIds,
        removeDeletedThreadFromClientState: useStore.getState().removeDeletedThreadFromClientState,
      });
      removeFromSelection([...deletedIds]);
      if (options?.showResultToast ?? true) {
        if (deletedCount > 0) {
          toastManager.add({
            type: failureCount > 0 ? "warning" : "success",
            title: deletedCount === 1 ? "Thread deleted" : `Deleted ${deletedCount} threads`,
            description:
              failureCount > 0
                ? `Failed to delete ${failureCount} ${pluralize(failureCount, "thread")}.`
                : `"${project.name}" cleared.`,
          });
        } else if (failureCount > 0) {
          toastManager.add({
            type: "error",
            title: "Failed to delete threads",
            description: `Could not delete ${failureCount} ${pluralize(failureCount, "thread")} in "${project.name}".`,
          });
        }
      }
      return {
        deletedCount,
        failureCount,
        totalCount: projectThreads.length,
        projectName: project.name,
      };
    },
    [deleteThread, projectById, sidebarThreads, removeFromSelection],
  );

  return {
    pinnedThreadIds,
    pinnedThreadIdSet,
    toggleThreadPinned,
    deleteThread,
    confirmAndDeleteThread,
    archiveThread,
    archiveThreadWithUndo,
    confirmAndArchiveThread,
    archiveAllThreadsInProject,
    deleteProjectThreads,
  } as const;
}
