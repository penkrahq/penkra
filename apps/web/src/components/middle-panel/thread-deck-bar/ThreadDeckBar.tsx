import { ThreadId, type ProviderKind } from "@penkra/contracts";
import { OptimisticSortingPlugin } from "@dnd-kit/dom/sortable";
import { useDragDropMonitor, useDragOperation, useDroppable } from "@dnd-kit/react";
import type { DragOverEvent } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState, type PointerEvent, type ReactNode } from "react";

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
import {
  canCreateAnotherDeckThread,
  removeDeckThreadPreservingNavigation,
} from "~/lib/threadDeckNavigation";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import type { Thread } from "~/types";
import { useVoiceSessionCoordinatorStore } from "~/voiceSessionCoordinator";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { useThreadDetailPrewarm } from "~/threadDetailPrewarm";
import { isPrimaryThreadActivationIntent } from "~/threadActivation.logic";
import { readSidebarDndData, SIDEBAR_THREAD_DRAG_TYPES } from "~/components/sidebar/SidebarDnd";
import {
  DECK_THREAD_DRAG_TYPE,
  type DeckThreadDndData,
  readDeckThreadDndData,
} from "./ThreadDeckDnd";

type DeckDropPlacement = "before" | "after";

interface DeckDropPreview {
  readonly targetThreadId: ThreadId;
  readonly placement: DeckDropPlacement;
  readonly gapWidth: number;
}

function SortableDeckThread(props: {
  readonly children: ReactNode;
  readonly deckId: string;
  readonly index: number;
  readonly tab: DeckTab;
  readonly dropPreview: DeckDropPreview | null;
}) {
  const data: DeckThreadDndData = {
    type: "thread-deck-tab",
    deckId: props.deckId,
    threadId: props.tab.id,
    preview: {
      title: props.tab.title,
      harness: props.tab.harness,
      pinned: props.tab.pinned,
      workStatus: props.tab.workStatus,
    },
  };
  const sortable = useSortable({
    id: `thread-deck-tab:${props.deckId}:${props.tab.id}`,
    index: props.index,
    group: `thread-deck:${props.deckId}`,
    type: DECK_THREAD_DRAG_TYPE,
    accept: [DECK_THREAD_DRAG_TYPE],
    data,
    // The normalized store owns visible order. Disable dnd-kit's transient DOM
    // transform so drop can move directly from preview to the local projection.
    plugins: (defaults) => defaults.filter((plugin) => plugin !== OptimisticSortingPlugin),
  });
  const dropPlacement =
    props.dropPreview?.targetThreadId === props.tab.id ? props.dropPreview.placement : null;
  const gapWidth = dropPlacement ? (props.dropPreview?.gapWidth ?? 0) : 0;
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
      data-thread-deck-drag-source={sortable.isDragSource ? "true" : undefined}
      data-thread-deck-drag-target={sortable.isDropTarget ? "true" : undefined}
      data-thread-deck-drop-preview={dropPlacement ?? undefined}
      style={
        dropPlacement === "before"
          ? { paddingLeft: gapWidth }
          : dropPlacement === "after"
            ? { paddingRight: gapWidth }
            : undefined
      }
    >
      {dropPlacement ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 z-30 h-6 w-0.5 -translate-y-1/2 rounded-full bg-[var(--color-border-focus)]"
          data-thread-deck-drop-indicator={dropPlacement}
          style={dropPlacement === "before" ? { left: gapWidth / 2 } : { right: gapWidth / 2 }}
        />
      ) : null}
      {props.children}
    </div>
  );
}

interface DeckTab {
  readonly id: ThreadId;
  readonly folderId: Thread["folderId"];
  readonly title: string;
  readonly harness: ProviderKind;
  readonly pinned: boolean;
  readonly workStatus: WorkStatus;
  readonly createdAt: string;
  readonly hasTurn: boolean;
}

export function ThreadDeckBar(props: {
  activeThread: Thread;
  activeComposerProvider: ProviderKind;
  defaultComposerProvider: ProviderKind;
  leftRailCollapsed: boolean;
  onRestoreLeftRail: () => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const decks = useStore((state) => state.decks);
  const folders = useStore((state) => state.folders);
  const threadShellById = useStore((state) => state.threadShellById ?? {});
  const threadTurnStateById = useStore((state) => state.threadTurnStateById ?? {});
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const composerDraftsByThreadId = useComposerDraftStore((state) => state.draftsByThreadId);
  const localSendOwnerThreadIds = useComposerSendActivityThreadIds();
  const clearDraftThread = useComposerDraftStore((state) => state.clearDraftThread);
  const recordingThreadId = useVoiceSessionCoordinatorStore(
    (state) => state.capture?.origin.threadId ?? null,
  );
  const deckId = props.activeThread.deckId;
  const dropTargetId = `thread-deck:${deckId}`;
  const droppable = useDroppable({
    id: dropTargetId,
    type: "penkra/thread-deck",
    accept: SIDEBAR_THREAD_DRAG_TYPES,
    data: { type: "thread-deck", deckId },
  });
  const dragOperation = useDragOperation();
  const draggedSidebarData = readSidebarDndData(dragOperation.source?.data);
  const draggedThread =
    draggedSidebarData?.type === "item" && draggedSidebarData.item.kind === "thread"
      ? threadShellById[draggedSidebarData.item.id]
      : null;
  const activeSpaceId =
    props.activeThread.spaceId ??
    folders.find((folder) => folder.id === props.activeThread.folderId)?.spaceId ??
    null;
  const draggedSpaceId =
    draggedThread?.spaceId ??
    folders.find((folder) => folder.id === draggedThread?.folderId)?.spaceId ??
    null;
  const canAddDraggedThread = Boolean(
    draggedThread &&
    draggedThread.deckId !== deckId &&
    activeSpaceId !== null &&
    activeSpaceId === draggedSpaceId,
  );
  const [deckDropPreview, setDeckDropPreview] = useState<DeckDropPreview | null>(null);
  const [optimisticActiveThreadId, setOptimisticActiveThreadId] = useState<ThreadId | null>(null);
  const { prewarmThreadDetail } = useThreadDetailPrewarm();

  const primeThreadActivation = (event: PointerEvent<HTMLButtonElement>, threadId: ThreadId) => {
    if (!isPrimaryThreadActivationIntent(event)) {
      return;
    }
    prewarmThreadDetail(threadId);
    setOptimisticActiveThreadId(threadId);
  };

  const updateDeckDropPreview = ({ operation }: Pick<DragOverEvent, "operation">) => {
    const source = readDeckThreadDndData(operation.source?.data);
    const target = readDeckThreadDndData(operation.target?.data);
    if (!source || !target || source.deckId !== deckId || target.deckId !== deckId) {
      setDeckDropPreview(null);
      return;
    }
    if (source.threadId === target.threadId) {
      setDeckDropPreview(null);
      return;
    }
    const sourceIndex = tabs.findIndex((tab) => tab.id === source.threadId);
    const targetIndex = tabs.findIndex((tab) => tab.id === target.threadId);
    if (sourceIndex < 0 || targetIndex < 0) {
      setDeckDropPreview(null);
      return;
    }
    const measuredWidth = operation.source?.element?.getBoundingClientRect().width ?? 0;
    const next: DeckDropPreview = {
      targetThreadId: target.threadId,
      placement: sourceIndex < targetIndex ? "after" : "before",
      gapWidth: measuredWidth,
    };
    setDeckDropPreview((current) =>
      current?.targetThreadId === next.targetThreadId &&
      current.placement === next.placement &&
      current.gapWidth === next.gapWidth
        ? current
        : next,
    );
  };

  useDragDropMonitor({
    onDragMove(event) {
      updateDeckDropPreview(event);
    },
    onDragOver(event) {
      updateDeckDropPreview(event);
    },
    onDragEnd(event) {
      setDeckDropPreview(null);
      setOptimisticActiveThreadId(null);
      const deckSource = readDeckThreadDndData(event.operation.source?.data);
      const deckTarget = readDeckThreadDndData(event.operation.target?.data);
      if (
        !event.canceled &&
        deckSource?.deckId === deckId &&
        deckTarget?.deckId === deckId &&
        deckSource.threadId !== deckTarget.threadId
      ) {
        const sourceIndex = tabs.findIndex((tab) => tab.id === deckSource.threadId);
        const targetIndex = tabs.findIndex((tab) => tab.id === deckTarget.threadId);
        if (sourceIndex >= 0 && targetIndex >= 0) {
          const api = readNativeApi();
          if (!api) return;
          const orderedThreadIds = tabs.map((tab) => tab.id);
          const [movedThreadId] = orderedThreadIds.splice(sourceIndex, 1);
          if (!movedThreadId) return;
          orderedThreadIds.splice(targetIndex, 0, movedThreadId);
          useStore.getState().reorderDeckLocally(deckId, orderedThreadIds);
          void api.orchestration
            .dispatchCommand({
              type: "thread.deck.move",
              commandId: newCommandId(),
              threadId: deckSource.threadId,
              deckId,
              position: {
                type: sourceIndex < targetIndex ? "after" : "before",
                threadId: deckTarget.threadId,
              },
            })
            .catch(async (error) => {
              try {
                const snapshot = await api.orchestration.getShellSnapshot();
                useStore.getState().syncServerShellSnapshot(snapshot);
              } catch {
                // Keep the proposed order until the shell stream/snapshot can
                // reconcile it; a blind rollback can undo a committed command.
              }
              toastManager.add({
                type: "error",
                title: "Unable to confirm thread order",
                description: error instanceof Error ? error.message : "Try again.",
              });
            });
        }
        return;
      }
      const source = readSidebarDndData(event.operation.source?.data);
      if (
        event.canceled ||
        event.operation.target?.id !== dropTargetId ||
        source?.type !== "item" ||
        source.item.kind !== "thread"
      ) {
        return;
      }
      const thread = threadShellById[source.item.id];
      const sourceSpaceId =
        thread?.spaceId ??
        folders.find((folder) => folder.id === thread?.folderId)?.spaceId ??
        null;
      if (
        !thread ||
        thread.deckId === deckId ||
        sourceSpaceId === null ||
        sourceSpaceId !== activeSpaceId
      ) {
        return;
      }
      void readNativeApi()?.orchestration.dispatchCommand({
        type: "thread.deck.move",
        commandId: newCommandId(),
        threadId: thread.id,
        deckId,
        position: { type: "end" },
      });
    },
  });

  const tabs = useMemo(() => {
    const deck = decks.find((candidate) => candidate.id === deckId);
    const persisted = (deck?.threadIds ?? [])
      .map((threadId): DeckTab | null => {
        const thread = threadShellById[threadId];
        if (!thread || thread.archivedAt != null) return null;
        const summary = sidebarThreadSummaryById[threadId];
        const status = summary
          ? resolveSidebarThreadSummaryStatus({
              thread: summary,
              dismissedStatusKey: readSidebarUiState().dismissedThreadStatusKeyByThreadId[threadId],
              isPromotedDraftPending: draftThreadsByThreadId[threadId]?.promotedTo !== undefined,
              hasLocalSendOwner: localSendOwnerThreadIds.has(threadId),
            })
          : null;
        return {
          id: thread.id,
          folderId: thread.folderId,
          title: thread.title,
          harness: thread.modelSelection.provider,
          pinned: thread.isPinned ?? false,
          workStatus: resolveVisibleThreadWorkStatus({
            status,
            isRecording: thread.id === recordingThreadId,
            projectedWorkStatus: summary?.workStatus,
          }),
          createdAt: thread.createdAt,
          hasTurn: threadTurnStateById[thread.id]?.latestTurn != null,
        };
      })
      .filter((tab): tab is DeckTab => tab !== null);
    const persistedIds = new Set(persisted.map((tab) => tab.id));
    const drafts = Object.entries(draftThreadsByThreadId)
      .filter(
        ([threadId, draft]) =>
          draft.deckId === deckId &&
          draft.entryPoint === "chat" &&
          draft.promotedTo === undefined &&
          !persistedIds.has(ThreadId.makeUnsafe(threadId)),
      )
      .map(
        ([threadId, draft]): DeckTab => ({
          id: ThreadId.makeUnsafe(threadId),
          folderId: draft.folderId,
          title: "New thread",
          // An unsent thread has no durable provider identity yet. Its tab
          // follows the provider that its composer will use for the first turn.
          harness:
            composerDraftsByThreadId[ThreadId.makeUnsafe(threadId)]?.activeProvider ??
            (threadId === props.activeThread.id
              ? props.activeComposerProvider
              : props.defaultComposerProvider),
          pinned: false,
          workStatus: threadId === recordingThreadId ? "recording" : "idle",
          createdAt: draft.createdAt,
          hasTurn: false,
        }),
      )
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    return [...persisted, ...drafts];
  }, [
    deckId,
    decks,
    composerDraftsByThreadId,
    draftThreadsByThreadId,
    localSendOwnerThreadIds,
    recordingThreadId,
    sidebarThreadSummaryById,
    threadShellById,
    threadTurnStateById,
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
    await removeDeckThreadPreservingNavigation({
      threadIds: tabs.map((tab) => tab.id),
      removedThreadId: threadId,
      activeThreadId: props.activeThread.id,
      isVisible: () => true,
      activate,
      remove: async (removedThreadId) => {
        if (draftThreadsByThreadId[removedThreadId]) {
          clearDraftThread(removedThreadId);
          return;
        }
        const api = readNativeApi();
        if (!api) return;
        await api.orchestration.dispatchCommand({
          type: "thread.archive",
          commandId: newCommandId(),
          threadId: removedThreadId,
        });
      },
    });
  };

  return (
    <header
      ref={droppable.ref}
      className={cn(
        "chat-surface-divider drag-region relative flex h-[46px] w-full shrink-0 items-center bg-transparent px-1.5",
        canAddDraggedThread && "ring-1 ring-inset ring-[var(--color-border-focus)]/40",
        droppable.isDropTarget &&
          canAddDraggedThread &&
          "bg-[var(--color-background-accent)] ring-[var(--color-border-focus)]",
        props.className,
      )}
      data-thread-deck-id={deckId}
    >
      {canAddDraggedThread ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[var(--color-background-primary)]/90 text-xs font-medium text-[var(--color-text-foreground)]"
        >
          {droppable.isDropTarget ? "Add to this deck" : "Drag here to add to deck"}
        </div>
      ) : null}
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
      <div
        className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [-webkit-app-region:no-drag] [&::-webkit-scrollbar]:hidden"
        role="tablist"
      >
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
                  data-slot="thread-deck-divider"
                />
              ) : null}
              <SortableDeckThread
                deckId={deckId}
                dropPreview={deckDropPreview}
                index={index}
                tab={tab}
              >
                <SurfaceTabChip
                  active={active}
                  title={tab.title}
                  label={tab.title}
                  labelClassName="max-w-44"
                  icon={
                    tab.workStatus === "idle" ? (
                      <ThreadIdentityShared harness={tab.harness} pinned={tab.pinned} />
                    ) : (
                      <WorkStatusShared status={tab.workStatus} />
                    )
                  }
                  closeIcon={<ArchiveIcon className="size-3.5" />}
                  closeLabel={`Archive ${tab.title}`}
                  onClose={() => void archive(tab.id)}
                  onSelect={() => activate(tab.id)}
                  onSelectPointerCancel={() => setOptimisticActiveThreadId(null)}
                  onSelectPointerDown={(event) => primeThreadActivation(event, tab.id)}
                />
              </SortableDeckThread>
            </div>
          );
        })}
        {canCreateAnotherDeckThread(tabs) ? (
          <IconButton
            variant="chrome"
            size="icon-xs"
            label="New thread"
            tooltip="New thread"
            tooltipSide="bottom"
            className="ml-1 !size-7 shrink-0 rounded-lg"
            onClick={() =>
              void handleNewThread(props.activeThread.folderId, {
                entryPoint: "chat",
                deckId,
              })
            }
          >
            <PlusIcon className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
    </header>
  );
}
