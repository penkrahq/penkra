import { ThreadId, type ProviderKind } from "@penkra/contracts";
import { useDragDropMonitor, useDragOperation, useDroppable } from "@dnd-kit/react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { SurfaceTabChip } from "~/components/chat/chatHeaderControls";
import {
  WorkStatusShared,
  type WorkStatus,
} from "~/components/left-rail/work-status-shared/WorkStatusShared";
import { ThreadIdentityShared } from "~/components/middle-panel/thread-identity-shared/ThreadIdentityShared";
import { IconButton } from "~/components/ui/icon-button";
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
import { readSidebarDndData, SIDEBAR_THREAD_DRAG_TYPES } from "~/components/sidebar/SidebarDnd";

const DECK_THREAD_DRAG_TYPE = "application/x-penkra-thread-deck-thread";

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

  useDragDropMonitor({
    onDragEnd(event) {
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
          harness: "codex",
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
    draftThreadsByThreadId,
    localSendOwnerThreadIds,
    recordingThreadId,
    sidebarThreadSummaryById,
    threadShellById,
    threadTurnStateById,
  ]);

  const activate = async (threadId: ThreadId | null): Promise<void> => {
    if (threadId) {
      await navigate({ to: "/$threadId", params: { threadId } });
      return;
    }
    await navigate({ to: "/" });
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

  const reorder = async (event: React.DragEvent<HTMLDivElement>, targetThreadId: ThreadId) => {
    event.preventDefault();
    const sourceThreadId = event.dataTransfer.getData(DECK_THREAD_DRAG_TYPE);
    if (!sourceThreadId || sourceThreadId === targetThreadId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
    await readNativeApi()?.orchestration.dispatchCommand({
      type: "thread.deck.move",
      commandId: newCommandId(),
      threadId: ThreadId.makeUnsafe(sourceThreadId),
      deckId,
      position: { type: position, threadId: targetThreadId },
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
          const active = tab.id === props.activeThread.id;
          const previousActive = tabs[index - 1]?.id === props.activeThread.id;
          return (
            <div key={tab.id} className="flex shrink-0 items-center">
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "mx-0.5 h-4 w-px bg-[var(--app-surface-divider)]",
                    (active || previousActive) && "invisible",
                  )}
                  data-slot="thread-deck-divider"
                />
              ) : null}
              <div
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(DECK_THREAD_DRAG_TYPE, tab.id);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => void reorder(event, tab.id)}
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
                />
              </div>
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
