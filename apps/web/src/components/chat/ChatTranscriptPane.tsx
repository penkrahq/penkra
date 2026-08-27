// FILE: ChatTranscriptPane.tsx
// Purpose: Isolate the transcript shell so composer state changes do not re-render it unnecessarily.
// Layer: Chat transcript shell
// Depends on: MessagesTimeline and ChatView's list-owned scroll contract.

import { type MessageId, ThreadId, type TurnId } from "@penkra/contracts";
import {
  memo,
  useCallback,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
} from "react";
import { type TimestampFormat } from "../../appSettings";
import { recordChatTranscriptPropChanges } from "../../chatPerformanceDiagnostics";
import { recordChatPaginationDiagnostic } from "../../chatScrollDiagnostics";
import {
  readPaginationViewportAnchor,
  summarizeThreadTurnsPage,
} from "../../chatPaginationDiagnostics";
import { ArrowDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { DISCLOSURE_CONTENT_MOTION_CLASS } from "~/lib/disclosureMotion";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { ChatEmptyStateHero } from "./ChatEmptyStateHero";
import { MessagesTimeline } from "./MessagesTimeline";
import { AgentActivityDetailView } from "./AgentActivityDetailView";
import type { AgentActivityDetail } from "./agentActivity.logic";
import type { TranscriptVirtualListRef } from "./TranscriptVirtualList";
import { useStore } from "../../store";
import { readNativeApi } from "../../nativeApi";
import { toastManager } from "../ui/toast";

interface ChatTranscriptPaneProps {
  activeThreadId: string;
  activeTurnId?: TurnId | null;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  agentActivityDetail?: AgentActivityDetail | null;
  contentInsetRightPx?: ComponentProps<typeof MessagesTimeline>["contentInsetRightPx"];
  chatFontSizePx: number;
  emptyStateContent?: ReactNode;
  emptyStateProjectName: string | undefined;
  expandedWorkGroups?: Record<string, boolean>;
  hasMessages: boolean;
  isWorking: boolean;
  listRef: RefObject<TranscriptVirtualListRef | null>;
  pinnedMessageIds?: ReadonlySet<MessageId>;
  canPinMessage?: (messageId: MessageId) => boolean;
  onTogglePinMessage?: (messageId: MessageId) => void;
  enteringUserMessageIds?: ComponentProps<typeof MessagesTimeline>["enteringUserMessageIds"];
  crossTaskOrigin?: ComponentProps<typeof MessagesTimeline>["crossTaskOrigin"];
  markdownCwd: string | undefined;
  onExpandTimelineImage: (preview: ExpandedImagePreview) => void;
  onMessagesClickCapture: MouseEventHandler<HTMLDivElement>;
  onMessagesMouseUp: MouseEventHandler<HTMLDivElement>;
  onMessagesPointerCancel: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerDown: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerUp: PointerEventHandler<HTMLDivElement>;
  onMessagesScroll: ComponentProps<typeof MessagesTimeline>["onMessagesScroll"];
  onMessagesTouchEnd: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchMove: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchStart: TouchEventHandler<HTMLDivElement>;
  onMessagesWheel: WheelEventHandler<HTMLDivElement>;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onCloseAgentActivityDetail?: () => void;
  onOpenAgentActivity?: ComponentProps<typeof MessagesTimeline>["onOpenAgentActivity"];
  onOpenThread: (threadId: ThreadId) => void;
  onEditUserMessage?: (messageId: MessageId, text: string) => boolean | Promise<boolean>;
  onScrollToBottom: () => void;
  onToggleWorkGroup?: (groupId: string) => void;
  resolvedTheme: "light" | "dark";
  scrollButtonVisible: boolean;
  subagentToolTraceByThreadId?: ComponentProps<
    typeof MessagesTimeline
  >["subagentToolTraceByThreadId"];
  timelineEntries: ComponentProps<typeof MessagesTimeline>["timelineEntries"];
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
}

function ChatTranscriptPaneImpl({
  activeThreadId,
  activeTurnId,
  activeTurnInProgress,
  activeTurnStartedAt,
  agentActivityDetail,
  contentInsetRightPx,
  chatFontSizePx,
  emptyStateContent,
  emptyStateProjectName,
  expandedWorkGroups,
  hasMessages,
  isWorking,
  listRef,
  pinnedMessageIds,
  canPinMessage,
  onTogglePinMessage,
  enteringUserMessageIds,
  crossTaskOrigin,
  markdownCwd,
  onExpandTimelineImage,
  onMessagesClickCapture,
  onMessagesMouseUp,
  onMessagesPointerCancel,
  onMessagesPointerDown,
  onMessagesPointerUp,
  onMessagesScroll,
  onMessagesTouchEnd,
  onMessagesTouchMove,
  onMessagesTouchStart,
  onMessagesWheel,
  onIsAtEndChange,
  onCloseAgentActivityDetail,
  onOpenAgentActivity,
  onOpenThread,
  onEditUserMessage,
  onScrollToBottom,
  onToggleWorkGroup,
  resolvedTheme,
  scrollButtonVisible,
  subagentToolTraceByThreadId,
  timelineEntries,
  timestampFormat,
  workspaceRoot,
}: ChatTranscriptPaneProps) {
  const threadId = ThreadId.makeUnsafe(activeThreadId);
  const pagination = useStore((state) => state.threadTurnPaginationById?.[threadId]);
  const syncServerThreadTurnsPage = useStore((state) => state.syncServerThreadTurnsPage);
  const paginationRequestSequenceRef = useRef(0);
  const paginationRequestInFlightRef = useRef(false);
  const loadOlderTurns = useCallback(() => {
    if (
      paginationRequestInFlightRef.current ||
      !pagination?.hasOlder ||
      pagination.nextCursor === null
    ) {
      return;
    }
    const api = readNativeApi();
    if (!api) return;
    paginationRequestInFlightRef.current = true;
    const cursor = pagination.nextCursor;
    const requestId = ++paginationRequestSequenceRef.current;
    const element = listRef.current?.getScrollableNode() ?? null;
    recordChatPaginationDiagnostic({
      event: "request-started",
      threadId,
      dataCount: timelineEntries.length,
      element,
      detail: {
        requestId,
        trigger: "near-start",
        cursorPresent: true,
        ...readPaginationViewportAnchor(element),
      },
    });
    void api.orchestration
      .getThreadTurnsPage({ threadId, before: cursor })
      .then((page) => {
        recordChatPaginationDiagnostic({
          event: "response-received",
          threadId,
          dataCount: page.messages.length,
          element: listRef.current?.getScrollableNode() ?? null,
          detail: { requestId, ...summarizeThreadTurnsPage(page) },
        });
        syncServerThreadTurnsPage(page);
        const recordViewportCheckpoint = (checkpoint: string) => {
          const nextElement = listRef.current?.getScrollableNode() ?? null;
          recordChatPaginationDiagnostic({
            event: "viewport-after-merge",
            threadId,
            dataCount: page.messages.length,
            element: nextElement,
            detail: {
              requestId,
              checkpoint,
              elementMatchesRequest: nextElement === element,
              elementConnected: nextElement?.isConnected ?? false,
              ...readPaginationViewportAnchor(nextElement),
            },
          });
        };
        recordViewportCheckpoint("sync-after-store");
        window.requestAnimationFrame(() => {
          recordViewportCheckpoint("next-frame");
          window.requestAnimationFrame(() => {
            recordViewportCheckpoint("second-frame");
          });
        });
        window.setTimeout(() => recordViewportCheckpoint("100ms"), 100);
        window.setTimeout(() => recordViewportCheckpoint("500ms"), 500);
      })
      .catch((error) => {
        recordChatPaginationDiagnostic({
          event: "request-failed",
          threadId,
          dataCount: timelineEntries.length,
          element: listRef.current?.getScrollableNode() ?? null,
          detail: {
            requestId,
            errorName: error instanceof Error ? error.name : "unknown",
          },
        });
        toastManager.add({
          type: "error",
          title: "Unable to load earlier turns",
          description: error instanceof Error ? error.message : "The history request failed.",
        });
      })
      .finally(() => {
        paginationRequestInFlightRef.current = false;
      });
  }, [listRef, pagination, syncServerThreadTurnsPage, threadId, timelineEntries.length]);
  const scrollButtonFrameStyle: CSSProperties | undefined = contentInsetRightPx
    ? { paddingRight: contentInsetRightPx }
    : undefined;

  return (
    <div
      data-chat-transcript-pane="true"
      data-pencil-region="PGsVQ"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {agentActivityDetail && onCloseAgentActivityDetail ? (
          <AgentActivityDetailView
            detail={agentActivityDetail}
            chatFontSizePx={chatFontSizePx}
            contentInsetRightPx={contentInsetRightPx}
            markdownCwd={markdownCwd}
            onBack={onCloseAgentActivityDetail}
            onImageExpand={onExpandTimelineImage}
            timestampFormat={timestampFormat}
          />
        ) : (
          <MessagesTimeline
            key={activeThreadId}
            viewportMemoryKey={activeThreadId}
            hasMessages={hasMessages}
            isWorking={isWorking}
            activeTurnId={activeTurnId ?? null}
            activeTurnInProgress={activeTurnInProgress}
            activeTurnStartedAt={activeTurnStartedAt}
            listRef={listRef}
            {...(pinnedMessageIds ? { pinnedMessageIds } : {})}
            {...(canPinMessage ? { canPinMessage } : {})}
            {...(onTogglePinMessage ? { onTogglePinMessage } : {})}
            {...(enteringUserMessageIds ? { enteringUserMessageIds } : {})}
            {...(crossTaskOrigin ? { crossTaskOrigin } : {})}
            timelineEntries={timelineEntries}
            onOpenThread={onOpenThread}
            {...(subagentToolTraceByThreadId ? { subagentToolTraceByThreadId } : {})}
            {...(onEditUserMessage ? { onEditUserMessage } : {})}
            onImageExpand={onExpandTimelineImage}
            onIsAtEndChange={onIsAtEndChange}
            onMessagesScroll={onMessagesScroll}
            onMessagesClickCapture={onMessagesClickCapture}
            onMessagesMouseUp={onMessagesMouseUp}
            onMessagesWheel={onMessagesWheel}
            onNearStart={loadOlderTurns}
            onMessagesPointerDown={onMessagesPointerDown}
            onMessagesPointerUp={onMessagesPointerUp}
            onMessagesPointerCancel={onMessagesPointerCancel}
            onMessagesTouchStart={onMessagesTouchStart}
            onMessagesTouchMove={onMessagesTouchMove}
            onMessagesTouchEnd={onMessagesTouchEnd}
            markdownCwd={markdownCwd}
            resolvedTheme={resolvedTheme}
            chatFontSizePx={chatFontSizePx}
            timestampFormat={timestampFormat}
            workspaceRoot={workspaceRoot}
            contentInsetRightPx={contentInsetRightPx}
            {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
            emptyStateContent={
              emptyStateContent === undefined ? (
                <ChatEmptyStateHero projectName={emptyStateProjectName} />
              ) : (
                emptyStateContent
              )
            }
            {...(expandedWorkGroups ? { expandedWorkGroups } : {})}
            {...(onToggleWorkGroup ? { onToggleWorkGroup } : {})}
          />
        )}

        {!agentActivityDetail ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center py-1",
              // Reuse the shared disclosure motion so the arrow fades + drifts in/out with
              // the same 220ms ease-out curve (and motion-reduce fallback) as every other
              // show/hide in the app. The wrapper stays pointer-events-none; only the
              // button re-enables pointer events while visible.
              DISCLOSURE_CONTENT_MOTION_CLASS,
              scrollButtonVisible ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
            )}
            // Follow the same right inset as transcript rows so the button centers in the
            // visible chat column while the side panel overlays the viewport edge.
            style={scrollButtonFrameStyle}
          >
            <button
              type="button"
              onClick={onScrollToBottom}
              data-scroll-anchor-ignore
              aria-label="Scroll to bottom"
              aria-hidden={!scrollButtonVisible}
              tabIndex={scrollButtonVisible ? 0 : -1}
              className={cn(
                "flex size-8 items-center justify-center rounded-full border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground)] backdrop-blur-md transition-colors hover:cursor-pointer hover:bg-[var(--color-background-elevated-secondary)]",
                scrollButtonVisible ? "pointer-events-auto" : "pointer-events-none",
              )}
            >
              <ArrowDownIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Composer state currently lives above this surface. Keep the transcript boundary
// explicit so a compiler regression cannot turn prompt updates into transcript work.
function chatTranscriptPanePropsEqual(
  previous: ChatTranscriptPaneProps,
  next: ChatTranscriptPaneProps,
): boolean {
  const keys = Object.keys({ ...previous, ...next }) as (keyof ChatTranscriptPaneProps)[];
  const changedProps = keys.filter((key) => !Object.is(previous[key], next[key]));
  recordChatTranscriptPropChanges(changedProps);
  return changedProps.length === 0;
}

export const ChatTranscriptPane = memo(ChatTranscriptPaneImpl, chatTranscriptPanePropsEqual);
