import { ThreadId, type FolderId, type ProviderKind } from "@penkra/contracts";
import { OptimisticSortingPlugin } from "@dnd-kit/dom/sortable";
import { useDragDropMonitor } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  SurfaceTabChip,
  SURFACE_TAB_DIVIDER_CLASS_NAME,
} from "~/components/chat/chatHeaderControls";
import {
  WorkStatusShared,
  type WorkStatus,
} from "~/components/left-rail/work-status-shared/WorkStatusShared";
import { ThreadIdentityShared } from "~/components/middle-panel/thread-identity-shared/ThreadIdentityShared";
import { IconButton } from "~/components/ui/icon-button";
import { toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useComposerSendActivityThreadIds } from "~/composerSendPreflight";
import {
  resolveSidebarThreadSummaryStatus,
  resolveVisibleThreadWorkStatus,
} from "~/components/Sidebar.logic";
import { readSidebarUiState } from "~/components/Sidebar.uiState";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { ArchiveIcon, PlusIcon } from "~/lib/icons";
import { removeFolderThreadPreservingNavigation } from "~/lib/folderTabNavigation";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import {
  loadThread,
  loadThreadPage,
  getThreadListPages,
  threadListScopeKey,
  useThreadSummary,
} from "~/threadListStore";
import {
  selectFolderThreadRows,
  useSidebarThreadRows,
  useSidebarThreadRowsById,
} from "~/sidebarThreadRows";
import type { Thread } from "~/types";
import { useVoiceSessionCoordinatorStore } from "~/voiceSessionCoordinator";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { isPrimaryThreadActivationIntent } from "~/threadActivation.logic";
import {
  FOLDER_THREAD_DRAG_TYPE,
  type FolderThreadDndData,
  readFolderThreadDndData,
} from "./FolderTabsDnd";
import { FolderTabStripViewport } from "./FolderTabStripViewport";

function SortableFolderThread(props: {
  readonly children: ReactNode;
  readonly folderId: string;
  readonly index: number;
  readonly tab: FolderTab;
}) {
  const data: FolderThreadDndData = {
    type: "folder-tabs-tab",
    folderId: props.folderId,
    threadId: props.tab.id,
    preview: {
      title: props.tab.title,
      harness: props.tab.harness,
      workStatus: props.tab.workStatus,
    },
  };
  const sortable = useSortable({
    id: `folder-tabs-tab:${props.folderId}:${props.tab.id}`,
    index: props.index,
    group: `folder-tabs:${props.folderId}`,
    type: FOLDER_THREAD_DRAG_TYPE,
    accept: [FOLDER_THREAD_DRAG_TYPE],
    data,
    // The normalized store owns visible order. Disable dnd-kit's transient DOM
    // transform so committed canonical rows own the visible order.
    plugins: (defaults) => defaults.filter((plugin) => plugin !== OptimisticSortingPlugin),
  });
  const sortableRef = sortable.ref;
  const sortableHandleRef = sortable.handleRef;
  const setNodeRef = useCallback(
    (element: Element | null) => {
      sortableRef(element);
      sortableHandleRef(element?.querySelector("button[aria-pressed]") ?? element);
    },
    [sortableHandleRef, sortableRef],
  );

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "relative transition-[padding] duration-150 [transition-timing-function:ease] motion-reduce:transition-none",
        sortable.isDragging && "z-20 opacity-35",
        sortable.isDropTarget && "z-10",
      )}
      data-folder-tabs-drag-source={sortable.isDragSource ? "true" : undefined}
      data-folder-tabs-drag-target={sortable.isDropTarget ? "true" : undefined}
      data-shell-dnd-activation-target="true"
    >
      {props.children}
    </div>
  );
}

interface FolderTab {
  readonly id: ThreadId;
  readonly title: string;
  readonly harness: ProviderKind;
  readonly workStatus: WorkStatus;
  readonly createdAt: string;
}

interface FolderTabsProps {
  activeThread: Thread;
  activeComposerProvider: ProviderKind;
  defaultComposerProvider: ProviderKind;
  leftRailCollapsed: boolean;
  onRestoreLeftRail: () => void;
  className?: string;
}
export function FolderTabs(props: FolderTabsProps) {
  const row = useThreadSummary(props.activeThread.id);
  const draft = useComposerDraftStore(
    (state) => state.draftThreadsByThreadId[props.activeThread.id],
  );
  useEffect(() => {
    if (row !== null || draft !== undefined) return;
    void loadThread(props.activeThread.id).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not load thread",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  }, [props.activeThread.id, row, draft]);
  const folderId = row !== null ? row.folderId : draft?.folderId;
  if (folderId === null || folderId === undefined) return null;
  return <CanonicalFolderTabs {...props} folderId={folderId} />;
}

function CanonicalFolderTabs(props: FolderTabsProps & { folderId: FolderId }) {
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const folders = useStore((state) => state.folders);
  const rows = useSidebarThreadRows();
  const rowsById = useSidebarThreadRowsById();
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const composerDraftsByThreadId = useComposerDraftStore((state) => state.draftsByThreadId);
  const localSendOwnerThreadIds = useComposerSendActivityThreadIds();
  const recordingThreadId = useVoiceSessionCoordinatorStore(
    (state) => state.capture?.origin.threadId ?? null,
  );
  const folderId = props.folderId;
  const folder = folders.find((value) => value.id === folderId);
  useEffect(() => {
    if (!folder?.spaceId || getThreadListPages().has(threadListScopeKey(folder.spaceId, folderId)))
      return;
    void loadThreadPage({ spaceId: folder.spaceId, folderId: folderId }).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not load threads",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  }, [folderId, folder?.spaceId]);
  const [optimisticActiveThreadId, setOptimisticActiveThreadId] = useState<ThreadId | null>(null);

  const primeThreadActivation = (event: PointerEvent<HTMLButtonElement>, threadId: ThreadId) => {
    if (!isPrimaryThreadActivationIntent(event)) {
      return;
    }
    setOptimisticActiveThreadId(threadId);
  };

  useDragDropMonitor({
    onDragEnd(event) {
      setOptimisticActiveThreadId(null);
      const folderSource = readFolderThreadDndData(event.operation.source?.data);
      const folderTarget = readFolderThreadDndData(event.operation.target?.data);
      if (
        !event.canceled &&
        folderSource?.folderId === folderId &&
        folderTarget?.folderId === folderId &&
        folderSource.threadId !== folderTarget.threadId
      ) {
        const sourceIndex = tabs.findIndex((tab) => tab.id === folderSource.threadId);
        const targetIndex = tabs.findIndex((tab) => tab.id === folderTarget.threadId);
        if (sourceIndex >= 0 && targetIndex >= 0) {
          const api = readNativeApi();
          if (!api || !folder?.spaceId) return;
          void api.cleanCore
            .updateThread({
              update: {
                action: "moveSidebarItem",
                threadId: folderSource.threadId,
                folderId,
                position: {
                  type: sourceIndex < targetIndex ? "after" : "before",
                  itemId: folderTarget.threadId,
                },
                updatedAt: new Date().toISOString(),
              },
            })
            .catch(async (error) => {
              toastManager.add({
                type: "error",
                title: "Unable to confirm thread order",
                description: error instanceof Error ? error.message : "Try again.",
              });
            });
        }
        return;
      }
    },
  });

  const tabs = useMemo(() => {
    const persisted = selectFolderThreadRows(rows, folderId).map((thread): FolderTab => {
      const threadId = thread.id;
      const status = resolveSidebarThreadSummaryStatus({
        thread,
        lastVisitedAt: thread.lastVisitedAt,
        dismissedStatusKey: readSidebarUiState().dismissedThreadStatusKeyByThreadId[threadId],
        isPromotedDraftPending: draftThreadsByThreadId[threadId]?.promotedTo !== undefined,
        hasLocalSendOwner: localSendOwnerThreadIds.has(threadId),
      });
      return {
        id: thread.id,
        title: thread.title,
        harness: thread.modelSelection.provider,
        workStatus: resolveVisibleThreadWorkStatus({
          status,
          isRecording: thread.id === recordingThreadId,
          projectedWorkStatus: thread.workStatus,
        }),
        createdAt: thread.createdAt,
      };
    });
    const persistedIds = new Set(persisted.map((tab) => tab.id));
    const drafts = Object.entries(draftThreadsByThreadId)
      .filter(
        ([threadId, draft]) =>
          draft.folderId === folderId &&
          draft.promotedTo === undefined &&
          !persistedIds.has(ThreadId.makeUnsafe(threadId)),
      )
      .map(
        ([threadId, draft]): FolderTab => ({
          id: ThreadId.makeUnsafe(threadId),
          title: "New thread",
          // An unsent thread has no durable provider identity yet. Its tab
          // follows the provider that its composer will use for the first turn.
          harness:
            composerDraftsByThreadId[ThreadId.makeUnsafe(threadId)]?.activeProvider ??
            (threadId === props.activeThread.id
              ? props.activeComposerProvider
              : props.defaultComposerProvider),
          workStatus: threadId === recordingThreadId ? "recording" : "idle",
          createdAt: draft.createdAt,
        }),
      )
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    return [...persisted, ...drafts];
  }, [
    folderId,
    rows,
    composerDraftsByThreadId,
    draftThreadsByThreadId,
    localSendOwnerThreadIds,
    recordingThreadId,
    props.activeComposerProvider,
    props.activeThread.id,
    props.defaultComposerProvider,
  ]);

  const activate = async (threadId: ThreadId | null): Promise<void> => {
    try {
      if (threadId) {
        await navigate({ to: "/$threadId", params: { threadId } });
        return;
      }
      await navigate({ to: "/" });
    } finally {
      setOptimisticActiveThreadId((current) => (current === threadId ? null : current));
    }
  };

  const archive = async (threadId: ThreadId) => {
    const thread = rowsById.get(threadId);
    if (!thread) return;
    if (tabs.find((tab) => tab.id === threadId)?.workStatus === "running") {
      toastManager.add({
        type: "error",
        title: "Could not archive thread",
        description: "This thread is still running. Stop it before archiving.",
      });
      return;
    }
    const api = readNativeApi();
    if (!api) return;
    const confirmed = await api.dialogs.confirm(`Archive thread "${thread.title}"?`);
    if (!confirmed) return;

    await removeFolderThreadPreservingNavigation({
      threadIds: tabs.map((tab) => tab.id),
      removedThreadId: threadId,
      activeThreadId: props.activeThread.id,
      isVisible: () => true,
      activate,
      remove: async (removedThreadId) => {
        const api = readNativeApi();
        if (!api) return;
        await api.cleanCore.updateThread({
          update: {
            action: "archive",
            threadId: removedThreadId,
            archivedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });
      },
    }).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not archive thread",
        description: error instanceof Error ? error.message : "Unable to archive the thread.",
      });
    });
  };

  return (
    <header
      className={cn(
        "chat-surface-divider drag-region relative flex h-[46px] w-full shrink-0 items-center bg-transparent px-1.5",
        props.className,
      )}
      data-folder-tabs-id={folderId}
      data-shell-dnd-activation-target="true"
    >
      {props.leftRailCollapsed ? (
        <button
          aria-label="Restore left rail"
          className="mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)] [-webkit-app-region:no-drag]"
          onClick={props.onRestoreLeftRail}
          type="button"
        >
          <CentralIcon className="size-4" name="sidebar-simple-left-wide" />
        </button>
      ) : null}
      <FolderTabStripViewport>
        {tabs.map((tab, index) => {
          const visualActiveThreadId = optimisticActiveThreadId ?? props.activeThread.id;
          const active = tab.id === visualActiveThreadId;
          const previousActive = tabs[index - 1]?.id === visualActiveThreadId;
          return (
            <div key={tab.id} className="flex shrink-0 items-center">
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    SURFACE_TAB_DIVIDER_CLASS_NAME,
                    (active || previousActive) && "invisible",
                  )}
                  data-slot="folder-tabs-divider"
                />
              ) : null}
              <SortableFolderThread folderId={folderId} index={index} tab={tab}>
                <SurfaceTabChip
                  active={active}
                  title={tab.title}
                  label={tab.title}
                  labelClassName="max-w-44"
                  icon={
                    tab.workStatus === "idle" ? (
                      <ThreadIdentityShared harness={tab.harness} />
                    ) : (
                      <WorkStatusShared status={tab.workStatus} />
                    )
                  }
                  closeIcon={<ArchiveIcon className="size-3.5" />}
                  closeLabel={`Archive ${tab.title}`}
                  onClose={rowsById.has(tab.id) ? () => void archive(tab.id) : undefined}
                  onSelect={() => activate(tab.id)}
                  onSelectPointerCancel={() => setOptimisticActiveThreadId(null)}
                  onSelectPointerDown={(event) => primeThreadActivation(event, tab.id)}
                />
              </SortableFolderThread>
            </div>
          );
        })}
        {
          <IconButton
            variant="chrome"
            size="icon-xs"
            label="New thread"
            tooltip="New thread"
            tooltipSide="bottom"
            className="ml-1 !size-7 shrink-0 rounded-lg"
            onClick={() => void handleNewThread(folderId, { entryPoint: "chat" })}
          >
            <PlusIcon className="size-3.5" />
          </IconButton>
        }
      </FolderTabStripViewport>
    </header>
  );
}
