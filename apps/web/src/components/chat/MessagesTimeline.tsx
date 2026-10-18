// FILE: MessagesTimeline.tsx
// Purpose: Renders chat transcript rows with end-anchored TanStack virtualization.
// Layer: Web chat presentation component
// Exports: MessagesTimeline

import type { CleanCoreThreadItem } from "@penkra/contracts";
import type { ThreadItemsState } from "../../threadItemsStore";
import {
  type MessageId,
  type ProviderMentionReference,
  ThreadId,
  type TurnId,
} from "@penkra/contracts";
import { clampMentionTitle } from "@penkra/shared/threadMentions";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type RefObject,
  type ReactNode,
} from "react";
import { deriveTimelineEntries, formatClockElapsed, type WorkLogEntry } from "../../session-logic";
import {
  areChatScrollDiagnosticsEnabled,
  recordChatPaginationDiagnostic,
} from "../../chatScrollDiagnostics";
import { recordChatLifecycleUiDiagnostic } from "../../chatLifecycleDiagnostics";
import ChatMarkdown from "../ChatMarkdown";
import { InlineLinkChip } from "../InlineLinkChip";
import { BotIcon, type LucideIcon, SteerIcon } from "~/lib/icons";
import { CrossTaskOriginLabel, type CrossTaskOrigin } from "./CrossTaskOriginLabel";
import { useStore } from "../../store";
import { PenkraThreadCreationCard } from "./PenkraThreadCreationCard";
import { PresentedMediaRow } from "./PresentedMediaRow";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { FileEntryIcon } from "./FileEntryIcon";
import { InlineMentionChip } from "./InlineMentionChip";
import { InlineSkillChip } from "./InlineSkillChip";
import { InlineAgentChip } from "./InlineAgentChip";
import { MessageCopyButton } from "./MessageCopyButton";
import { MessageAssistant } from "../middle-panel/message-assistant/MessageAssistant";
import { MessageUser } from "../middle-panel/message-user/MessageUser";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { FileAttachmentChip } from "./FileAttachmentChip";
import { FileCommentsSummaryChip } from "./FileCommentsSummaryChip";
import { UserMessagePastedTextCard } from "./PastedTextChip";
import {
  prefersCompactWorkEntryRow,
  TimelineWorkEntryRow,
  workEntryFindText,
} from "./TimelineWorkEntryRow";
import {
  hasLeadingUserMedia,
  resolveUserTurnMarker,
  type UserTurnMarkerKind,
} from "./userTurnMarker";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
  resolveAssistantMessageCopyState,
  resolveAssistantMessageDisplayText,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
import { ToolCallGroupSummaryRow } from "./ToolCallGroupSummaryRow";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { measureChatPerformanceWork } from "~/chatPerformanceDiagnostics";
import {
  DEFAULT_CHAT_FONT_SIZE_PX,
  normalizeChatFontSizePx,
  type TimestampFormat,
} from "../../appSettings";
import {
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
  CHAT_CONTENT_INSET_MOTION_CLASS_NAME,
} from "./composerPickerStyles";
import { formatMessageTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { splitPromptIntoDisplaySegments } from "~/composer-editor-mentions";
import {
  getChatMessageFooterTextStyle,
  getChatTranscriptTextStyle,
  getChatTranscriptUserMessageLineHeightPx,
  getChatTranscriptUserMessageTextStyle,
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from "./chatTypography";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { getAppTypographyScale } from "../../lib/appTypography";
import {
  USER_MESSAGE_COLLAPSED_FADE_LINES,
  USER_MESSAGE_COLLAPSED_MAX_LINES,
  userMessageLikelyOverflows,
} from "./userMessageCollapse";
import { observeUserMessageOverflow } from "./userMessageOverflowObserver";
import { useOptionalFind } from "../find/FindProvider";
import {
  createVirtualTextFindSurface,
  type VirtualFindEntry,
} from "../../lib/find/virtualTextFindSurface";
import { markdownVisibleText } from "../../lib/find/markdownVisibleText";
import { isFindSurfaceVisible } from "../../lib/find/findVisibility";
import { TranscriptVirtualList, type TranscriptVirtualListRef } from "./TranscriptVirtualList";

interface TimelineVirtualFindEntry extends VirtualFindEntry {
  readonly targetSelector: string;
}
// The composer overlaps the transcript by design, so the list needs extra tail
// space beyond the overlap to keep final cards from sitting flush against it.
const BOTTOM_CONTENT_INSET_PX = 64;
const MESSAGE_HOVER_REVEAL_CLASS_NAME =
  "opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto";
// How long a jumped-to message keeps its highlight tint before fading back out.
const JUMP_HIGHLIGHT_DURATION_MS = 1200;
// Elapsed labels show whole seconds, so their leaf clock updates once per second (decision 6b).
const WORKING_TIMER_TICK_MS = 1_000;
const MESSAGE_SEND_ENTER_ANIMATION_MS = 180;
const MESSAGE_SEND_ENTER_CLEANUP_BUFFER_MS = 60;
const EMPTY_MESSAGE_ID_SET: ReadonlySet<MessageId> = new Set();

// Keep imperative list access opaque to React Compiler. The selected ref is
// `listRef ?? fallbackListRef`; direct `.current` reads otherwise become
// dependencies that manual callback dependency arrays cannot express.
function scrollTranscriptToEnd(listRef: RefObject<TranscriptVirtualListRef | null>): void {
  void listRef.current?.scrollToEnd?.({ animated: false });
}

function scrollTranscriptToIndex(
  listRef: RefObject<TranscriptVirtualListRef | null>,
  params: Parameters<TranscriptVirtualListRef["scrollToIndex"]>[0],
): void {
  void listRef.current?.scrollToIndex(params);
}

function readTranscriptListState(
  listRef: RefObject<TranscriptVirtualListRef | null>,
): ReturnType<TranscriptVirtualListRef["getState"]> | undefined {
  return listRef.current?.getState?.();
}

/**
 * Imperative handle used by transcript-navigation stories to scroll to and briefly
 * highlight a message.
 */
export interface MessagesTimelineController {
  scrollToMessage: (messageId: MessageId) => void;
}

// Keeps the origin/steer marker visually attached to the whole sent-message stack.
// Which marker (if any) applies comes from the shared resolveUserTurnMarker predicate,
// which the timelineHeight estimator also uses — keep presentation-only concerns here.
const USER_TURN_MARKER_PRESENTATION: Record<
  UserTurnMarkerKind,
  { readonly Icon: LucideIcon; readonly label: string }
> = {
  agent: { Icon: BotIcon, label: "Sent by agent" },
  steer: { Icon: SteerIcon, label: "Steering conversation" },
};

function UserDispatchModeChip({
  steered,
  origin,
  hasLeadingMedia,
  onOpenThread,
}: {
  steered: TimelineMessage["steered"];
  origin: TimelineMessage["origin"];
  hasLeadingMedia: boolean;
  onOpenThread?: (threadId: ThreadId) => void;
}) {
  const senderThreadId = origin?._tag === "agent" ? origin.senderThreadId : undefined;
  const senderThread = useStore((state) =>
    senderThreadId ? state.threadShellById?.[senderThreadId] : undefined,
  );
  const markerKind = resolveUserTurnMarker({ steered, origin });
  if (!markerKind) {
    return null;
  }

  const { Icon, label } = USER_TURN_MARKER_PRESENTATION[markerKind];
  const senderTitle = senderThread?.title;
  const clampedSenderTitle = senderTitle?.trim() ? clampMentionTitle(senderTitle) : undefined;
  const hasKnownSenderTitle = clampedSenderTitle !== undefined;
  const senderLabel =
    markerKind === "agent" && hasKnownSenderTitle ? `Sent by ${senderTitle}` : label;
  const content = (
    <>
      <Icon className="size-3 shrink-0 text-muted-foreground/75" />
      <span
        className="min-w-0 max-w-full truncate"
        title={senderThread?.archivedAt ? senderTitle : undefined}
      >
        {senderLabel}
      </span>
    </>
  );
  if (
    markerKind === "agent" &&
    hasKnownSenderTitle &&
    senderThread &&
    !senderThread.archivedAt &&
    senderThreadId &&
    onOpenThread
  ) {
    return (
      <button
        type="button"
        className={cn(
          "inline-flex max-w-full min-w-0 items-center gap-1.5 self-end px-0 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/78 hover:text-foreground/82 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          hasLeadingMedia ? "mb-3" : "mb-1.5",
        )}
        onClick={() => onOpenThread(senderThreadId)}
        aria-label={`Open ${clampedSenderTitle}`}
        title={clampedSenderTitle}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1.5 self-end px-0 text-[length:var(--app-font-size-ui-sm,11px)] font-normal tracking-[0.01em] text-muted-foreground/78",
        hasLeadingMedia ? "mb-3" : "mb-1.5",
      )}
    >
      {content}
    </div>
  );
}

// Per-step status glyph for the worktree setup stepper. Mirrors the active
// task-list card: spinner while active, check when done, hollow node pending.
interface MessagesTimelineProps {
  /** Thread-scoped in-memory viewport identity; intentionally not persisted across reloads. */
  viewportMemoryKey?: string;
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  emptyStateContent?: ReactNode;
  listRef?: RefObject<TranscriptVirtualListRef | null>;
  /** Optional controller for transcript navigation surfaces and interaction stories. */
  controllerRef?: RefObject<MessagesTimelineController | null>;
  /** Provenance for a conversation created from another Penkra task. */
  crossTaskOrigin?: CrossTaskOrigin | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  turns?: Readonly<Record<string, CleanCoreThreadItem>> | undefined;
  finals?: ThreadItemsState["finals"];
  hasSteps?: ThreadItemsState["hasSteps"];
  details?: ThreadItemsState["details"];
  outlineCursor?: number | null;
  onExpandedTurnsChange?: (ids: ReadonlyArray<string>) => void;
  onLoadOlderTurn?: (id: string) => void;
  nowIso?: string;
  onOpenAgentActivity?: (activityId: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  onRemoveFailedMessage?: ((messageId: MessageId) => void) | undefined;
  /** Recent child-thread tool calls rendered under subagent rows, keyed by child thread id. */
  activeTurnId?: TurnId | null;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onIsAtEndChange?: (isAtEnd: boolean) => void;
  onMessagesClickCapture?: ComponentProps<"div">["onClickCapture"];
  onMessagesMouseUp?: ComponentProps<"div">["onMouseUp"];
  onMessagesPointerCancel?: ComponentProps<"div">["onPointerCancel"];
  onMessagesPointerDown?: ComponentProps<"div">["onPointerDown"];
  onMessagesPointerUp?: ComponentProps<"div">["onPointerUp"];
  onMessagesScroll?: ComponentProps<"div">["onScroll"];
  onMessagesTouchEnd?: ComponentProps<"div">["onTouchEnd"];
  onMessagesTouchMove?: ComponentProps<"div">["onTouchMove"];
  onMessagesTouchStart?: ComponentProps<"div">["onTouchStart"];
  onMessagesWheel?: ComponentProps<"div">["onWheel"];
  onLoadOlder?: () => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  chatFontSizePx?: number;
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  /**
   * Right padding (px) applied to the scroll viewport so transcript rows clear a right-edge
   * overlay (e.g. the docked Environment card). The scrollbar stays pinned to the viewport's
   * far right; only the content is inset.
   */
  contentInsetRightPx?: number | undefined;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  viewportMemoryKey,
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  listRef,
  controllerRef,
  crossTaskOrigin: crossTaskOriginProp,
  timelineEntries,
  turns,
  finals,
  hasSteps,
  details,
  outlineCursor,
  onExpandedTurnsChange,
  onLoadOlderTurn,
  nowIso,
  onOpenAgentActivity,
  onOpenThread,
  onRemoveFailedMessage,
  activeTurnId,
  onImageExpand,
  onIsAtEndChange,
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
  onLoadOlder,
  markdownCwd,
  resolvedTheme,
  chatFontSizePx: chatFontSizePxProp,
  timestampFormat,
  workspaceRoot,
  emptyStateContent,
  contentInsetRightPx,
}: MessagesTimelineProps) {
  // Assignment-pattern parameters make React Compiler silently skip the whole
  // timeline, so resolve optional defaults in the body.
  const crossTaskOrigin = crossTaskOriginProp ?? null;
  const registerFindSurface = useOptionalFind()?.register;
  const transcriptFindSurfaceId = useId();
  const normalizedChatFontSizePx = normalizeChatFontSizePx(
    chatFontSizePxProp ?? DEFAULT_CHAT_FONT_SIZE_PX,
  );
  const messageTimestampReference = new Date(nowIso ?? Date.now());
  // Inset rows from the right (overriding the gutter's right padding) without moving the
  // scroll viewport, so the scrollbar stays pinned to the far right while content clears
  // any right-edge overlay. Kept stable so virtualization does not remeasure on unrelated updates.
  const listScrollStyle = useMemo(
    () => (contentInsetRightPx ? { paddingRight: contentInsetRightPx } : undefined),
    [contentInsetRightPx],
  );
  const appTypographyScale = useMemo(
    () => getAppTypographyScale(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const chatTypographyStyle = useMemo(
    () => getChatTranscriptTextStyle(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const userMessageTypographyStyle = useMemo(
    () => getChatTranscriptUserMessageTextStyle(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const chatMessageFooterStyle = useMemo(
    () => getChatMessageFooterTextStyle(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const [toolGroupSummaryOverrides, setToolGroupSummaryOverrides] = useState<
    Record<string, boolean>
  >({});
  const setToolGroupSummaryOpen = useCallback((groupKey: string, open: boolean) => {
    setToolGroupSummaryOverrides((current) => ({
      ...current,
      [groupKey]: open,
    }));
  }, []);
  const [expandedUserMessagesById, setExpandedUserMessagesById] = useState<Record<string, boolean>>(
    {},
  );
  // Transient highlight applied to a message jumped-to from the pinned-message checklist.
  const [highlightedMessageId, setHighlightedMessageId] = useState<MessageId | null>(null);
  const fallbackListRef = useRef<TranscriptVirtualListRef | null>(null);
  const resolvedListRef = listRef ?? fallbackListRef;
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  useEffect(() => {
    onExpandedTurnsChange?.(
      Object.entries(turns ?? {})
        .filter(([id, turn]) => turn.status === "running" || expandedTurns[id])
        .map(([id]) => id),
    );
  }, [turns, expandedTurns, onExpandedTurnsChange]);
  const onRenderedItems = useCallback(
    (items: ReadonlyArray<MessagesTimelineRow>) => {
      for (const row of items)
        if (row.kind === "boundary") {
          if (row.turnId === null) onLoadOlder?.();
          else onLoadOlderTurn?.(row.turnId);
        }
    },
    [onLoadOlder, onLoadOlderTurn],
  );

  const rawRows = useMemo(
    () =>
      measureChatPerformanceWork("transcript-rows", () =>
        deriveMessagesTimelineRows({
          timelineEntries,
          turns,
          finals,
          hasSteps,
          details,
          outlineCursor,
          expandedTurns,
          expandedSummaries: toolGroupSummaryOverrides,
          isWorking,
          activeTurnInProgress,
          activeTurnId,
          activeTurnStartedAt,
        }),
      ),
    [
      timelineEntries,
      turns,
      finals,
      hasSteps,
      details,
      outlineCursor,
      expandedTurns,
      toolGroupSummaryOverrides,
      isWorking,
      activeTurnInProgress,
      activeTurnId,
      activeTurnStartedAt,
    ],
  );
  const rows = useStableRows(rawRows);
  // Record the committed work-state inputs separately from the working predicate.
  // Keep this lightweight: streamed text replaces row objects without changing
  // the lifecycle state, so ownership details stay out of the default render
  // path.
  const previousLayoutSignatureRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!viewportMemoryKey) return;
    const signature = [
      viewportMemoryKey,
      activeTurnId ?? "",
      activeTurnStartedAt ?? "",
      activeTurnInProgress ? "in-progress" : "settled",
      isWorking ? "working" : "idle",
    ].join("|");
    if (previousLayoutSignatureRef.current === signature) return;
    previousLayoutSignatureRef.current = signature;
    recordChatLifecycleUiDiagnostic({
      event: "timeline-layout-committed",
      threadId: viewportMemoryKey,
      activeTurnId: activeTurnId ?? null,
      activeTurnStartedAt,
      isWorking,
      activeTurnInProgress,
    });
  }, [viewportMemoryKey, activeTurnId, activeTurnStartedAt, isWorking, activeTurnInProgress]);
  const thinkingRowDerivedVisible = rows.some((row) => row.kind === "working");
  const workingTimerDerivedVisible = rows.some((row) => row.kind === "working-header");
  const previousLifecycleRowsRef = useRef<{
    threadId: string;
    thinking: boolean;
    timer: boolean;
  } | null>(null);
  useEffect(() => {
    if (!viewportMemoryKey) return;
    const previous = previousLifecycleRowsRef.current;
    if (!previous || previous.threadId !== viewportMemoryKey) {
      previousLifecycleRowsRef.current = {
        threadId: viewportMemoryKey,
        thinking: thinkingRowDerivedVisible,
        timer: workingTimerDerivedVisible,
      };
      if (thinkingRowDerivedVisible) {
        recordChatLifecycleUiDiagnostic({
          event: "thinking-row-derived-visible",
          threadId: viewportMemoryKey,
          activeTurnId: activeTurnId ?? null,
          activeTurnStartedAt,
          isWorking,
        });
      }
      if (workingTimerDerivedVisible) {
        recordChatLifecycleUiDiagnostic({
          event: "working-timer-derived-visible",
          threadId: viewportMemoryKey,
          activeTurnId: activeTurnId ?? null,
          activeTurnStartedAt,
          isWorking,
        });
      }
      return;
    }

    if (previous.thinking !== thinkingRowDerivedVisible) {
      recordChatLifecycleUiDiagnostic({
        event: thinkingRowDerivedVisible
          ? "thinking-row-derived-visible"
          : "thinking-row-derived-hidden",
        threadId: viewportMemoryKey,
        activeTurnId: activeTurnId ?? null,
        activeTurnStartedAt,
        isWorking,
      });
    }
    if (previous.timer !== workingTimerDerivedVisible) {
      recordChatLifecycleUiDiagnostic({
        event: workingTimerDerivedVisible
          ? "working-timer-derived-visible"
          : "working-timer-derived-hidden",
        threadId: viewportMemoryKey,
        activeTurnId: activeTurnId ?? null,
        activeTurnStartedAt,
        isWorking,
      });
    }
    previousLifecycleRowsRef.current = {
      threadId: viewportMemoryKey,
      thinking: thinkingRowDerivedVisible,
      timer: workingTimerDerivedVisible,
    };
  }, [
    activeTurnId,
    activeTurnStartedAt,
    isWorking,
    thinkingRowDerivedVisible,
    viewportMemoryKey,
    workingTimerDerivedVisible,
  ]);
  useEffect(() => {
    if (!viewportMemoryKey || !areChatScrollDiagnosticsEnabled()) return;
    const inputMessages = timelineEntries.flatMap((entry) =>
      entry.kind === "message" ? [entry.message] : [],
    );
    const messageRows = rows.filter(
      (row): row is Extract<MessagesTimelineRow, { kind: "message" }> => row.kind === "message",
    );
    recordChatPaginationDiagnostic({
      event: "timeline-derived",
      threadId: viewportMemoryKey,
      dataCount: rows.length,
      element: resolvedListRef.current?.getScrollableNode() ?? null,
      detail: {
        timelineEntryCount: timelineEntries.length,
        inputMessageCount: inputMessages.length,
        inputUserMessageCount: inputMessages.filter((message) => message.role === "user").length,
        inputAssistantMessageCount: inputMessages.filter((message) => message.role === "assistant")
          .length,
        inputWorkEntryCount: timelineEntries.filter((entry) => entry.kind === "work").length,
        renderedRowCount: rows.length,
        renderedMessageRowCount: messageRows.length,
        renderedUserMessageCount: messageRows.filter((row) => row.message.role === "user").length,
        renderedAssistantMessageCount: messageRows.filter((row) => row.message.role === "assistant")
          .length,
        summaryRowCount: rows.filter((row) => row.kind === "summary").length,
      },
    });
  }, [resolvedListRef, rows, timelineEntries, viewportMemoryKey]);
  const transcriptAnchorRevision = useMemo(() => {
    const messageRows = rows.filter(
      (row): row is Extract<MessagesTimelineRow, { kind: "message" }> => row.kind === "message",
    );
    const tail = messageRows.at(-1)?.message ?? null;
    return [
      messageRows.length,
      tail?.id ?? "empty",
      tail?.role ?? "empty",
      tail?.streaming ? "streaming" : "settled",
      tail?.text.length ?? 0,
      tail?.completedAt ?? "",
    ].join(":");
  }, [rows]);
  const firstUserMessageId = useMemo(() => {
    for (const row of rows) {
      if (row.kind === "message" && row.message.role === "user") {
        return row.message.id;
      }
    }
    return null;
  }, [rows]);
  // Latest rows kept in a ref so the imperative scroll controller can look up a message's
  // index lazily without re-installing the controller on every transcript change.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  // Building the virtual Find index parses the visible text of every Markdown
  // message. Keep that full-history work out of the live streaming render path
  // and perform it only when Find actually asks for entries.
  const buildTranscriptFindEntries = useCallback(
    () =>
      rows.flatMap((row, index): TimelineVirtualFindEntry[] => {
        if (row.kind === "message") {
          const sourceText =
            row.message.role === "assistant"
              ? resolveAssistantMessageDisplayText(row)
              : deriveDisplayedUserMessageState(row.message.text).visibleText;
          const text = sourceText ? markdownVisibleText(sourceText) : "";
          if (!text) return [];
          return [
            {
              id: row.id,
              index,
              text,
              targetSelector: row.message.role === "assistant" ? "" : "[data-find-primary-text]",
            },
          ];
        }
        const visibleText =
          row.kind === "work"
            ? workEntryFindText(row.entry)
            : row.kind === "summary"
              ? row.summary.label
              : "";
        if (!visibleText) return [];
        return [
          {
            id: row.id,
            index,
            text: visibleText,
            targetSelector: "",
          },
        ];
      }),
    [rows],
  );
  const transcriptFindEntriesFactoryRef = useRef(buildTranscriptFindEntries);
  useLayoutEffect(() => {
    transcriptFindEntriesFactoryRef.current = buildTranscriptFindEntries;
  }, [buildTranscriptFindEntries]);
  // A new thread initially renders without the timeline root. Track the
  // empty-to-populated boundary independently of the rows array identity so
  // the find surface registers as soon as the first row mounts.
  const hasRenderableTranscriptContent = hasMessages || rows.length > 0;
  useEffect(() => {
    if (!registerFindSurface) return;
    const root = timelineRootRef.current;
    if (!root) return;
    const highlightName = "penkra-find-transcript-active";
    return registerFindSurface(
      createVirtualTextFindSurface({
        id: `transcript:${transcriptFindSurfaceId}`,
        order: 10,
        // The timeline wrapper uses `display: contents`, so it deliberately has
        // no layout box of its own. A rendered row is the authoritative signal
        // that this virtualized transcript belongs to the open view.
        isVisible: () =>
          isFindSurfaceVisible(root.querySelector<HTMLElement>("[data-find-row-id]")),
        getEntries: () => transcriptFindEntriesFactoryRef.current(),
        reveal: async (entry) => {
          scrollTranscriptToIndex(resolvedListRef, {
            index: entry.index,
            animated: false,
            viewPosition: 0.5,
          });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        },
        highlight: (rawEntry, query, occurrence) => {
          const entry = rawEntry as TimelineVirtualFindEntry;
          const rowSelector = `[data-find-row-id="${CSS.escape(entry.id)}"]`;
          const element = root.querySelector<HTMLElement>(
            entry.targetSelector ? `${rowSelector} ${entry.targetSelector}` : rowSelector,
          );
          if (!element) return;
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const nodes: Text[] = [];
          let text = "";
          let node: Node | null;
          while ((node = walker.nextNode())) {
            nodes.push(node as Text);
            text += node.textContent ?? "";
          }
          const needle = query.toLocaleLowerCase();
          let start = 0;
          for (let index = 0; index <= occurrence; index += 1) {
            start = text
              .toLocaleLowerCase()
              .indexOf(needle, index === 0 ? 0 : start + needle.length);
            if (start < 0) return;
          }
          const end = start + needle.length;
          let offset = 0;
          let startNode: Text | null = null;
          let endNode: Text | null = null;
          let startOffset = 0;
          let endOffset = 0;
          for (const textNode of nodes) {
            const nextOffset = offset + textNode.data.length;
            if (!startNode && start >= offset && start < nextOffset) {
              startNode = textNode;
              startOffset = start - offset;
            }
            if (end > offset && end <= nextOffset) {
              endNode = textNode;
              endOffset = end - offset;
              break;
            }
            offset = nextOffset;
          }
          if (!startNode || !endNode || !CSS.highlights || !globalThis.Highlight) return;
          const range = document.createRange();
          range.setStart(startNode, startOffset);
          range.setEnd(endNode, endOffset);
          CSS.highlights.set(highlightName, new Highlight(range));
          element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
        },
        clearHighlight: () => CSS.highlights?.delete(highlightName),
      }),
    );
  }, [
    hasRenderableTranscriptContent,
    registerFindSurface,
    resolvedListRef,
    transcriptFindSurfaceId,
  ]);
  const jumpHighlightTimeoutRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (jumpHighlightTimeoutRef.current !== null) {
        window.clearTimeout(jumpHighlightTimeoutRef.current);
      }
    },
    [],
  );
  useEffect(() => {
    if (!controllerRef) {
      return;
    }
    const scrollToMessage = (messageId: MessageId) => {
      const index = rowsRef.current.findIndex(
        (row) => row.kind === "message" && row.message.id === messageId,
      );
      if (index < 0) {
        return false;
      }
      scrollTranscriptToIndex(resolvedListRef, {
        index,
        animated: true,
        viewPosition: 0.2,
      });
      return true;
    };
    const clearJumpHighlightAfterDelay = () => {
      if (jumpHighlightTimeoutRef.current !== null) {
        window.clearTimeout(jumpHighlightTimeoutRef.current);
      }
      jumpHighlightTimeoutRef.current = window.setTimeout(() => {
        setHighlightedMessageId(null);
        jumpHighlightTimeoutRef.current = null;
      }, JUMP_HIGHLIGHT_DURATION_MS);
    };
    const controller: MessagesTimelineController = {
      scrollToMessage: (messageId) => {
        if (!scrollToMessage(messageId)) {
          return;
        }
        setHighlightedMessageId(messageId);
        clearJumpHighlightAfterDelay();
      },
    };
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [controllerRef, resolvedListRef]);
  const tailContentRowId = useMemo(() => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.kind !== "working") return row.id;
    }
    return null;
  }, [rows]);
  // Manual memoization kept: the main timeline component does not compile
  // under React Compiler (props-default destructuring bailout), so these
  // identities must be stabilized by hand.
  // A tail row can grow after it mounts (streaming text, image decode). Keep a
  // follower pinned by reacting to the row's measured size, but never pull a
  // reader who owns the scroll back down.
  const handleTailRowResize = useCallback(() => {
    if (readTranscriptListState(resolvedListRef)?.isAtEnd !== true) return;
    scrollTranscriptToEnd(resolvedListRef);
  }, [resolvedListRef]);
  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;
    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }
    onIsAtEndChange?.(true);
    const frameId = window.requestAnimationFrame(() => {
      scrollTranscriptToEnd(resolvedListRef);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [onIsAtEndChange, resolvedListRef, rows.length]);
  const handleListScroll = useCallback<NonNullable<MessagesTimelineProps["onMessagesScroll"]>>(
    (event) => {
      onMessagesScroll?.(event);
      const state = readTranscriptListState(resolvedListRef);
      if (state) {
        onIsAtEndChange?.(state.isAtEnd);
      }
    },
    [onIsAtEndChange, onMessagesScroll, resolvedListRef],
  );

  const renderRowContent = (row: MessagesTimelineRow) => {
    if (row.kind === "boundary")
      return <div data-load-boundary={row.id} className="h-0" aria-hidden="true" />;
    const content = (
      <div
        className={cn(
          CHAT_COLUMN_FRAME_CLASS_NAME,
          "px-1 transition-colors duration-500",
          row.kind === "turn-header" || row.kind === "turn-divider"
            ? "pb-0"
            : row.kind === "work" ||
                row.kind === "working-header" ||
                (row.kind === "message" && row.message.role === "assistant")
              ? "pb-2"
              : "pb-4",
          row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
          row.kind === "message" && row.message.id === highlightedMessageId
            ? "rounded-xl bg-[var(--color-background-elevated-secondary)]"
            : null,
        )}
        data-timeline-row-kind={row.kind}
        data-find-row-id={row.id}
        data-find-model-owned={
          row.kind === "work" || (row.kind === "message" && row.message.role === "assistant")
            ? true
            : undefined
        }
        data-message-id={row.kind === "message" ? row.message.id : undefined}
        data-message-role={row.kind === "message" ? row.message.role : undefined}
      >
        {row.kind === "turn-header" && (
          <button
            type="button"
            aria-expanded={row.expanded}
            className="-ml-0.5 inline-flex items-center gap-1 pb-2 text-left text-muted-foreground/70 hover:text-muted-foreground/90"
            style={{ fontSize: chatTypographyStyle.fontSize }}
            onClick={() =>
              setExpandedTurns((current) => ({ ...current, [row.turnId]: !row.expanded }))
            }
          >
            <span>{row.elapsed ? `Worked for ${row.elapsed}` : "Details"}</span>
            <DisclosureChevron open={row.expanded} className="text-muted-foreground/55" />
          </button>
        )}
        {row.kind === "turn-divider" && <div className="mb-3 h-px w-full bg-border" />}
        {row.kind === "media" && (
          <PresentedMediaRow
            items={row.entries.flatMap((entry) =>
              entry.presentedMedia ? [entry.presentedMedia] : [],
            )}
            onImageExpand={onImageExpand}
          />
        )}
        {row.kind === "summary" && (
          <ToolCallGroupSummaryRow
            summary={row.summary}
            open={row.expanded}
            onToggle={(open) => setToolGroupSummaryOpen(row.id, open)}
            fontSizePx={normalizedChatFontSizePx}
          />
        )}
        {row.kind === "work" &&
          (row.entry.penkraThreadCreation ? (
            !activeTurnInProgress && (
              <PenkraThreadCreationCard
                creation={row.entry.penkraThreadCreation}
                {...(onOpenThread
                  ? { onOpenThread: (id: string) => onOpenThread(ThreadId.makeUnsafe(id)) }
                  : {})}
              />
            )
          ) : (
            <TimelineWorkEntryRow
              workEntry={row.entry}
              chatMetaFontSizePx={appTypographyScale.chatMetaPx}
              textFontSizePx={normalizedChatFontSizePx}
              density={prefersCompactWorkEntryRow(row.entry) ? "compact" : "default"}
              markdownCwd={markdownCwd}
              onImageExpand={onImageExpand}
              {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
              {...(onOpenThread ? { onOpenThread } : {})}
            />
          ))}

        {row.kind === "message" &&
          row.message.role === "user" &&
          (() => {
            const userImages = (row.message.attachments ?? []).filter(
              (
                attachment,
              ): attachment is Extract<
                NonNullable<TimelineMessage["attachments"]>[number],
                { type: "image" }
              > => attachment.type === "image",
            );
            const assistantSelections = (row.message.attachments ?? []).filter(
              (
                attachment,
              ): attachment is Extract<
                NonNullable<TimelineMessage["attachments"]>[number],
                { type: "assistant-selection" }
              > => attachment.type === "assistant-selection",
            );
            const userFiles = (row.message.attachments ?? []).filter(
              (
                attachment,
              ): attachment is Extract<
                NonNullable<TimelineMessage["attachments"]>[number],
                { type: "file" }
              > => attachment.type === "file",
            );
            const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text, {
              hideImageOnlyBootstrapPrompt:
                userImages.length > 0 || userFiles.length > 0 || assistantSelections.length > 0,
            });
            const renderedAssistantSelections =
              assistantSelections.length > 0
                ? assistantSelections
                : displayedUserMessage.assistantSelections.map((selection, index) => ({
                    type: "assistant-selection" as const,
                    id: `fallback-selection-${row.message.id}-${index}`,
                    assistantMessageId: selection.assistantMessageId,
                    text: selection.text,
                  }));
            const terminalContexts = displayedUserMessage.contexts;
            const renderedFileComments = displayedUserMessage.fileComments;
            const renderedPastedTexts = displayedUserMessage.pastedTexts;
            const userMessageText = displayedUserMessage.visibleText;
            const userMessageExpanded = expandedUserMessagesById[row.message.id] ?? false;
            const showUserText = userMessageText.trim().length > 0 || terminalContexts.length > 0;
            const bubbleIsChipOnly =
              showUserText &&
              terminalContexts.length === 0 &&
              hasOnlyInlineSkillChips(userMessageText, row.message.mentions ?? []);
            const hasLeadingMedia = hasLeadingUserMedia({
              imageCount: userImages.length,
              fileCount: userFiles.length,
              assistantSelectionCount: renderedAssistantSelections.length,
              fileCommentCount: renderedFileComments.length,
              pastedTextCount: renderedPastedTexts.length,
            });
            const showCrossTaskOrigin =
              crossTaskOrigin !== null && row.message.id === firstUserMessageId;
            return (
              <MessageUser layoutMode="application" className="flex flex-col gap-3">
                {showCrossTaskOrigin ? (
                  <CrossTaskOriginLabel
                    origin={crossTaskOrigin}
                    {...(onOpenThread ? { onOpenSourceThread: onOpenThread } : {})}
                  />
                ) : null}
                <div className="flex w-full justify-end">
                  <div className={cn("group flex flex-col items-end gap-px", "max-w-[80%]")}>
                    {/* Keep user-message chrome outside the bubble so the message reads as one simple block. */}
                    {/* The cross-task origin label already attributes this turn to another Penkra thread,
                      so suppress the dispatch chip here to avoid a duplicate "Sent by …" marker. */}
                    {showCrossTaskOrigin ? null : (
                      <UserDispatchModeChip
                        steered={row.message.steered}
                        origin={row.message.origin}
                        hasLeadingMedia={hasLeadingMedia}
                        {...(onOpenThread ? { onOpenThread } : {})}
                      />
                    )}
                    {row.message.delivery?.state === "queued" && (
                      <div
                        className="mb-1.5 self-end text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground"
                        data-testid="queued-message-status"
                      >
                        Queued · not delivered · position{" "}
                        {rows
                          .filter(
                            (candidate) =>
                              candidate.kind === "message" &&
                              candidate.message.delivery?.state === "queued",
                          )
                          .findIndex(
                            (candidate) =>
                              candidate.kind === "message" &&
                              candidate.message.id === row.message.id,
                          ) + 1}
                      </div>
                    )}
                    {row.message.sendStatus === "failed" && (
                      <div
                        className="mb-1.5 self-end text-[length:var(--app-font-size-ui-sm,11px)] text-destructive"
                        data-testid="failed-message-status"
                      >
                        Failed · not delivered
                        {onRemoveFailedMessage && (
                          <button
                            type="button"
                            className="ml-2 underline underline-offset-2"
                            aria-label="Remove failed message"
                            onClick={() => onRemoveFailedMessage(row.message.id)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                    {renderedAssistantSelections.length > 0 && (
                      <div className="mb-1 flex max-w-[240px] flex-wrap justify-end gap-1.5 self-end">
                        <AssistantSelectionsSummaryChip selections={renderedAssistantSelections} />
                      </div>
                    )}
                    {renderedFileComments.length > 0 && (
                      <div className="mb-1 flex max-w-[240px] flex-wrap justify-end gap-1.5 self-end">
                        <FileCommentsSummaryChip comments={renderedFileComments} />
                      </div>
                    )}
                    {renderedPastedTexts.length > 0 && (
                      <div className="mb-1 flex max-w-full flex-col items-end gap-1.5 self-end">
                        {renderedPastedTexts.map((pasted) => (
                          <UserMessagePastedTextCard
                            key={pasted.index}
                            text={pasted.text}
                            metrics={{ lineCount: pasted.lineCount, charCount: pasted.charCount }}
                          />
                        ))}
                      </div>
                    )}
                    {userFiles.length > 0 && (
                      <div className="mb-1 flex max-w-[280px] flex-wrap justify-end gap-1.5 self-end">
                        {userFiles.map((file) => (
                          <FileAttachmentChip key={file.id} file={file} />
                        ))}
                      </div>
                    )}
                    {userImages.length > 0 && (
                      <div
                        className={cn(
                          "flex max-w-[240px] flex-wrap justify-end gap-2 self-end",
                          showUserText && "mb-1",
                        )}
                      >
                        {userImages.map((image) => (
                          <UserImageAttachmentThumbnail
                            key={image.id}
                            image={image}
                            userImages={userImages}
                            onImageExpand={onImageExpand}
                            resolvedTheme={resolvedTheme}
                          />
                        ))}
                      </div>
                    )}
                    {showUserText ? (
                      <div
                        data-find-primary-text
                        data-find-model-owned
                        className={cn(
                          "w-max max-w-full min-w-0 self-end bg-[var(--app-user-message-background)]",
                          USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
                          bubbleIsChipOnly
                            ? "py-0.5 px-3"
                            : USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
                        )}
                      >
                        <UserMessageCollapsibleText
                          text={userMessageText}
                          expanded={userMessageExpanded}
                          chatFontSizePx={normalizedChatFontSizePx}
                          onToggle={() => {
                            setExpandedUserMessagesById((previous) => ({
                              ...previous,
                              [row.message.id]: !(previous[row.message.id] ?? false),
                            }));
                          }}
                        >
                          <UserMessageBody
                            text={userMessageText}
                            mentionReferences={row.message.mentions ?? []}
                            terminalContexts={terminalContexts}
                            chatTypographyStyle={userMessageTypographyStyle}
                            resolvedTheme={resolvedTheme}
                            markdownCwd={markdownCwd}
                          />
                        </UserMessageCollapsibleText>
                      </div>
                    ) : null}
                    <div
                      className="flex h-[26px] items-center justify-end font-system-ui font-normal text-muted-foreground/45"
                      data-pencil-component="Bx6FM"
                      style={chatMessageFooterStyle}
                    >
                      <p className={cn("px-2 tabular-nums", MESSAGE_HOVER_REVEAL_CLASS_NAME)}>
                        {formatMessageTimestamp(
                          row.message.createdAt,
                          timestampFormat,
                          messageTimestampReference,
                        )}
                      </p>
                      <div className="flex items-center gap-1">
                        {displayedUserMessage.copyText && (
                          <MessageCopyButton
                            text={displayedUserMessage.copyText}
                            className={MESSAGE_HOVER_REVEAL_CLASS_NAME}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </MessageUser>
            );
          })()}

        {row.kind === "message" &&
          row.message.role === "assistant" &&
          (() => {
            const messageText = resolveAssistantMessageDisplayText(row);
            const assistantCopyState = resolveAssistantMessageCopyState({
              text: row.message.text ?? null,
              showCopyButton: row.showAssistantCopyButton,
              streaming: row.assistantCopyStreaming,
            });
            // Only the server-selected final answer carries a timestamp.
            const isTerminalAssistantMessage = row.showAssistantCopyButton;
            const assistantMeta = [
              isTerminalAssistantMessage
                ? formatMessageTimestamp(
                    row.message.createdAt,
                    timestampFormat,
                    messageTimestampReference,
                  )
                : null,
            ]
              .filter((value): value is string => Boolean(value))
              .join(" • ");
            return (
              <MessageAssistant layoutMode="application" workedFor={null}>
                <div className="group min-w-0 py-0.5">
                  {messageText !== null ? (
                    <div
                      data-assistant-message-id={row.message.id}
                      data-find-primary-text
                      data-find-model-owned
                    >
                      <ChatMarkdown
                        text={messageText}
                        cwd={markdownCwd}
                        isStreaming={Boolean(row.message.streaming)}
                        style={chatTypographyStyle}
                        onImageExpand={onImageExpand}
                      />
                    </div>
                  ) : null}
                  {(assistantCopyState.visible || assistantMeta.length > 0) && (
                    <div
                      className="mt-0.5 flex h-[26px] items-center gap-1 font-system-ui font-normal text-muted-foreground/45"
                      data-pencil-component="vI265"
                      style={chatMessageFooterStyle}
                    >
                      {assistantCopyState.visible ? (
                        <MessageCopyButton
                          text={assistantCopyState.text ?? ""}
                          className={MESSAGE_HOVER_REVEAL_CLASS_NAME}
                          label="Copy response"
                        />
                      ) : null}
                      {assistantMeta.length > 0 ? (
                        <p className={cn("px-2 tabular-nums", MESSAGE_HOVER_REVEAL_CLASS_NAME)}>
                          {assistantMeta}
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
              </MessageAssistant>
            );
          })()}

        {row.kind === "working-header" && (
          <div>
            <div
              className="-ml-0.5 pb-2 text-muted-foreground/70"
              style={{ fontSize: chatTypographyStyle.fontSize }}
            >
              Working for{" "}
              {nowIso ? (
                (formatClockElapsed(row.createdAt, nowIso) ?? "0s")
              ) : (
                <WorkingTimer createdAt={row.createdAt} />
              )}
            </div>
            <div className="h-px w-full bg-border" />
          </div>
        )}

        {row.kind === "working" && (
          <div
            className="shimmer pt-0.5 text-muted-foreground/70 font-system-ui"
            style={{ fontSize: `${appTypographyScale.chatPx}px` }}
          >
            Thinking
          </div>
        )}
      </div>
    );

    return content;
  };

  if (!hasRenderableTranscriptContent && !isWorking) {
    if (emptyStateContent) {
      return <div className="flex h-full items-center justify-center">{emptyStateContent}</div>;
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div ref={timelineRootRef} className="contents" data-messages-timeline-root="true">
      <TranscriptVirtualList<MessagesTimelineRow>
        ref={resolvedListRef}
        data={rows}
        anchorRevision={transcriptAnchorRevision}
        {...(viewportMemoryKey === undefined ? {} : { viewportMemoryKey })}
        keyExtractor={(row) => row.id}
        renderItem={renderRowContent}
        estimatedItemSize={90}
        paddingEnd={BOTTOM_CONTENT_INSET_PX}
        observedTailKey={tailContentRowId}
        onObservedTailResize={handleTailRowResize}
        onClickCapture={onMessagesClickCapture}
        onMouseUp={onMessagesMouseUp}
        onPointerCancel={onMessagesPointerCancel}
        onPointerDown={onMessagesPointerDown}
        onPointerUp={onMessagesPointerUp}
        onScroll={handleListScroll}
        onTouchEnd={onMessagesTouchEnd}
        onTouchMove={onMessagesTouchMove}
        onTouchStart={onMessagesTouchStart}
        onWheel={onMessagesWheel}
        onRenderedItems={onRenderedItems}
        isLoadBoundary={(row) => row.kind === "boundary"}
        data-chat-scroll-container="true"
        // `scroll-fade-b` (vendored shadcn 4.12.0 util in index.css) masks the bottom
        // edge so streamed content dissolves toward the composer. It is scroll-aware
        // via `animation-timeline: scroll()`, so the fade clears at the live edge and a
        // pinned or non-scrollable transcript stays crisp (no permanent shadow).
        className={cn(
          "scroll-fade-b h-full overflow-x-hidden overscroll-y-contain py-3 [scrollbar-gutter:stable] sm:py-4",
          CHAT_CONTENT_INSET_MOTION_CLASS_NAME,
          CHAT_COLUMN_GUTTER_CLASS_NAME,
        )}
        {...(listScrollStyle ? { style: listScrollStyle } : {})}
      />
    </div>
  );
});

type TimelineMessage = Extract<MessagesTimelineRow, { kind: "message" }>["message"];
// Reuse stable row references so streaming updates only force React work for
// rows whose visible content actually changed.
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const previousStateRef = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => reconcileStableTimelineRows(rows, previousStateRef), [rows]);
}

// The reconciliation reads and rewrites the previous-state cache during the memo,
// which the compiler rejects. Keeping it in a module helper that takes the ref
// (module functions aren't compiled) preserves the per-row identity reuse: a
// whole-array useStableValue would drop every row reference whenever any single row
// changed, re-rendering the entire streaming transcript instead of just that row.
function reconcileStableTimelineRows(
  rows: MessagesTimelineRow[],
  previousStateRef: RefObject<StableMessagesTimelineRowsState>,
): MessagesTimelineRow[] {
  const nextState = computeStableMessagesTimelineRows(rows, previousStateRef.current);
  previousStateRef.current = nextState;
  return nextState.result;
}

// Keep the live clock scoped to tiny leaf components so active Claude turns do
// not force the full transcript tree to re-render every second.
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = window.setInterval(updateText, WORKING_TIMER_TICK_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [createdAt]);

  return <span ref={textRef}>{initialText}</span>;
}

function formatWorkingTimerNow(startIso: string): string {
  return formatClockElapsed(startIso, new Date().toISOString()) ?? "0s";
}

const UserImageAttachmentThumbnail = memo(function UserImageAttachmentThumbnail(props: {
  image: Extract<NonNullable<TimelineMessage["attachments"]>[number], { type: "image" }>;
  userImages: Array<
    Extract<NonNullable<TimelineMessage["attachments"]>[number], { type: "image" }>
  >;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  resolvedTheme: "light" | "dark";
}) {
  return (
    <button
      type="button"
      className="flex size-15 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-background/82 text-left shadow-[0_1px_0_rgba(255,255,255,0.2)_inset] transition-colors hover:bg-background/94"
      aria-label={`Preview ${props.image.name}`}
      title={props.image.name}
      onClick={() => {
        const preview = buildExpandedImagePreview(props.userImages, props.image.id);
        if (!preview) return;
        props.onImageExpand(preview);
      }}
    >
      {props.image.previewUrl ? (
        <img
          src={props.image.previewUrl}
          alt={props.image.name}
          className="size-full object-cover"
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <FileEntryIcon
            pathValue={props.image.name}
            kind="file"
            theme={props.resolvedTheme}
            className="size-4 opacity-70"
          />
        </div>
      )}
    </button>
  );
});

// Renders read-only user text with the same inline skill pill treatment as the composer.
function renderUserMessageInlineText(
  text: string,
  keyPrefix: string,
  resolvedTheme: "light" | "dark",
  mentionReferences: ReadonlyArray<ProviderMentionReference> = [],
): ReactNode[] {
  return splitPromptIntoDisplaySegments(text, mentionReferences).flatMap((segment, index) => {
    const key = `${keyPrefix}:${index}`;
    if (segment.type === "text") {
      return segment.text.length > 0 ? [<span key={`${key}:text`}>{segment.text}</span>] : [];
    }
    if (segment.type === "skill") {
      return [<InlineSkillChip key={`${key}:skill`} skillName={segment.name} />];
    }
    if (segment.type === "mention") {
      return [
        <InlineMentionChip
          key={`${key}:mention`}
          path={segment.path}
          theme={resolvedTheme}
          mentionReferences={mentionReferences}
          {...(segment.kind ? { kind: segment.kind } : {})}
        />,
      ];
    }
    if (segment.type === "agent-mention") {
      return [<InlineAgentChip key={`${key}:agent`} alias={segment.alias} color={segment.color} />];
    }
    if (segment.type === "link") {
      return [<InlineLinkChip key={`${key}:link`} url={segment.url} interactive />];
    }
    return [];
  });
}

function hasOnlyInlineSkillChips(
  text: string,
  mentionReferences: ReadonlyArray<ProviderMentionReference> = [],
): boolean {
  const segments = splitPromptIntoDisplaySegments(text, mentionReferences);
  let skillCount = 0;

  for (const segment of segments) {
    if (segment.type === "skill") {
      skillCount += 1;
      continue;
    }
    if (segment.type === "text" && segment.text.trim().length === 0) {
      continue;
    }
    return false;
  }

  return skillCount > 0;
}

// Measures the clamped message against its content before paint so the fade mask
// never flickers. Kept in a module helper (not compiled) so the synchronous
// overflow setState — unavoidable for a layout measurement — stays out of the
// compiled component.
function measureUserMessageOverflow(
  collapsed: boolean,
  contentRef: RefObject<HTMLDivElement | null>,
  setOverflowing: (overflowing: boolean) => void,
): (() => void) | undefined {
  if (!collapsed) {
    return undefined;
  }
  const element = contentRef.current;
  if (!element) {
    return undefined;
  }
  const measure = () => {
    setOverflowing(element.scrollHeight - element.clientHeight > 1);
  };
  measure();
  return observeUserMessageOverflow(element, measure);
}

// Show more/less for long user messages: a visual max-height clamp (with a fade
// mask) around the fully rendered message instead of the old character slice.
const UserMessageCollapsibleText = memo(function UserMessageCollapsibleText(props: {
  text: string;
  expanded: boolean;
  chatFontSizePx: number;
  onToggle: () => void;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [overflowing, setOverflowing] = useState(() => userMessageLikelyOverflows(props.text));
  const collapsed = !props.expanded;

  useLayoutEffect(
    () => measureUserMessageOverflow(collapsed, contentRef, setOverflowing),
    [collapsed, props.text],
  );

  const lineHeightPx = getChatTranscriptUserMessageLineHeightPx(props.chatFontSizePx);
  const clampHeightPx = USER_MESSAGE_COLLAPSED_MAX_LINES * lineHeightPx;
  const fadeStartPx = clampHeightPx - USER_MESSAGE_COLLAPSED_FADE_LINES * lineHeightPx;
  const clamped = collapsed && overflowing;

  return (
    <>
      <div
        id={contentId}
        ref={contentRef}
        data-user-message-clamp={clamped ? "true" : "false"}
        className={cn("min-w-0", collapsed && "overflow-hidden")}
        style={
          collapsed
            ? {
                maxHeight: `${clampHeightPx}px`,
                ...(clamped
                  ? {
                      maskImage: `linear-gradient(to bottom, black ${fadeStartPx}px, transparent 100%)`,
                    }
                  : {}),
              }
            : undefined
        }
      >
        {props.children}
      </div>
      {(clamped || props.expanded) && (
        <button
          type="button"
          data-scroll-anchor-ignore
          className="mt-1 block text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/72"
          style={{ fontSize: `${props.chatFontSizePx}px` }}
          aria-expanded={props.expanded}
          aria-controls={contentId}
          onClick={props.onToggle}
        >
          {props.expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  mentionReferences: ReadonlyArray<ProviderMentionReference>;
  terminalContexts: ParsedTerminalContextEntry[];
  chatTypographyStyle: CSSProperties;
  resolvedTheme: "light" | "dark";
  markdownCwd: string | undefined;
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const markdownText = hasEmbeddedInlineLabels
      ? props.text
      : [inlinePrefix, props.text].filter((part) => part.length > 0).join(" ");
    if (markdownText.length === 0) {
      return null;
    }
    return (
      <ChatMarkdown
        text={markdownText}
        cwd={props.markdownCwd}
        variant="user"
        mentionReferences={props.mentionReferences}
        terminalContexts={props.terminalContexts}
        className="font-system-ui wrap-break-word"
        style={props.chatTypographyStyle}
      />
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  if (
    props.terminalContexts.length === 0 &&
    hasOnlyInlineSkillChips(props.text, props.mentionReferences)
  ) {
    return (
      <div
        className="flex max-w-full min-w-0 items-center leading-none text-foreground [&>span]:translate-y-0"
        style={props.chatTypographyStyle}
      >
        {renderUserMessageInlineText(
          props.text,
          "user-message-inline-chip-only",
          props.resolvedTheme,
          props.mentionReferences,
        )}
      </div>
    );
  }

  // Plain sent text renders as markdown (same pipeline as assistant messages);
  // the user variant keeps single newlines, skips math, and renders composer
  // tokens as chips via the composer-chips remark plugin.
  return (
    <ChatMarkdown
      variant="user"
      text={props.text}
      cwd={props.markdownCwd}
      isStreaming={false}
      mentionReferences={props.mentionReferences}
      className="font-system-ui"
      style={props.chatTypographyStyle}
    />
  );
});
