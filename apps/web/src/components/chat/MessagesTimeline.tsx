// FILE: MessagesTimeline.tsx
// Purpose: Renders chat transcript rows with end-anchored TanStack virtualization.
// Layer: Web chat presentation component
// Exports: MessagesTimeline

import {
  type MessageId,
  type ProviderMentionReference,
  ThreadId,
  type TurnId,
} from "@penkra/contracts";
import { resolveLatestTailUserMessageEditTarget } from "@penkra/shared/conversationEdit";
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
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  deriveTimelineEntries,
  formatClockElapsed,
  isFileChangeWorkLogEntry,
  type WorkLogEntry,
} from "../../session-logic";
import {
  areChatScrollDiagnosticsEnabled,
  recordChatPaginationDiagnostic,
} from "../../chatScrollDiagnostics";
import { recordChatLifecycleUiDiagnostic } from "../../chatLifecycleDiagnostics";
import ChatMarkdown from "../ChatMarkdown";
import { InlineLinkChip } from "../InlineLinkChip";
import {
  BotIcon,
  type LucideIcon,
  PencilIcon,
  PinIcon,
  RotateCcwIcon,
  SteerIcon,
} from "~/lib/icons";
import { pinActionLabel } from "~/lib/pin";
import { Button } from "../ui/button";
import { CrossTaskOriginLabel, type CrossTaskOrigin } from "./CrossTaskOriginLabel";
import { PenkraThreadCreationCard } from "./PenkraThreadCreationCard";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { FileEntryIcon } from "./FileEntryIcon";
import { InlineMentionChip } from "./InlineMentionChip";
import { InlineSkillChip } from "./InlineSkillChip";
import { InlineAgentChip } from "./InlineAgentChip";
import { MessageActionButton, MESSAGE_ACTION_ICON_CLASS_NAME } from "./MessageActionButton";
import { MessageCopyButton } from "./MessageCopyButton";
import { MessageAssistant } from "../middle-panel/message-assistant/MessageAssistant";
import { MessageUser } from "../middle-panel/message-user/MessageUser";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { FileAttachmentChip } from "./FileAttachmentChip";
import { FileCommentsSummaryChip } from "./FileCommentsSummaryChip";
import { UserMessagePastedTextCard } from "./PastedTextChip";
import {
  EditedFileRowContent,
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
  capOpenWorkEntryRenderChunks,
  chunkCollapsedTurnItems,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  findLastLiveWorkGroupId,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  planWorkEntryRenderChunks,
  type CollapsedTurnChunk,
  type CollapsedTurnItem,
  type MessagesTimelineRow,
  resolveAssistantMessageCopyState,
  resolveAssistantMessageDisplayText,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
import { summarizeToolCallGroup } from "./toolCallGroup.logic";
import { ToolCallGroupSummaryRow } from "./ToolCallGroupSummaryRow";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
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
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DISCLOSURE_TRANSITION_MS, disclosureContentClassName } from "~/lib/disclosureMotion";
import { getAppTypographyScale } from "../../lib/appTypography";
import type { SubagentToolTrace } from "./subagentToolTrace.logic";
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

const MAX_VISIBLE_INLINE_TOOL_ENTRIES = 4;
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
  dispatchMode,
  dispatchOrigin,
  hasLeadingMedia,
}: {
  dispatchMode: TimelineMessage["dispatchMode"];
  dispatchOrigin: TimelineMessage["dispatchOrigin"];
  hasLeadingMedia: boolean;
}) {
  const markerKind = resolveUserTurnMarker({ dispatchMode, dispatchOrigin });
  if (!markerKind) {
    return null;
  }

  const { Icon, label } = USER_TURN_MARKER_PRESENTATION[markerKind];
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 self-end px-0 text-[length:var(--app-font-size-ui-sm,11px)] font-normal tracking-[0.01em] text-muted-foreground/78",
        hasLeadingMedia ? "mb-3" : "mb-1.5",
      )}
    >
      <Icon className="size-3 shrink-0 text-muted-foreground/75" />
      <span>{label}</span>
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
  /** Message ids currently pinned for the active thread (drives the footer pin toggle state). */
  pinnedMessageIds?: ReadonlySet<MessageId>;
  /** Excludes transient rows from persistent pin affordances. */
  canPinMessage?: (messageId: MessageId) => boolean;
  /** Toggle a message's pinned state from the assistant footer. */
  onTogglePinMessage?: (messageId: MessageId) => void;
  /** User messages inserted locally by send actions, eligible for the subtle enter affordance. */
  enteringUserMessageIds?: ReadonlySet<MessageId>;
  /** Provenance for a conversation created from another Penkra task. */
  crossTaskOrigin?: CrossTaskOrigin | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  nowIso?: string;
  expandedWorkGroups?: Record<string, boolean>;
  onToggleWorkGroup?: (groupId: string) => void;
  onOpenAgentActivity?: (activityId: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  /** Recent child-thread tool calls rendered under subagent rows, keyed by child thread id. */
  subagentToolTraceByThreadId?: ReadonlyMap<string, SubagentToolTrace>;
  onEditUserMessage?: (messageId: MessageId, text: string) => boolean | Promise<boolean>;
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
  onNearStart?: () => void;
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
  pinnedMessageIds,
  canPinMessage,
  onTogglePinMessage,
  enteringUserMessageIds: enteringUserMessageIdsProp,
  crossTaskOrigin: crossTaskOriginProp,
  timelineEntries,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenAgentActivity,
  onOpenThread,
  subagentToolTraceByThreadId,
  onEditUserMessage,
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
  onNearStart,
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
  const enteringUserMessageIds = enteringUserMessageIdsProp ?? EMPTY_MESSAGE_ID_SET;
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
  const [localExpandedWorkGroups, setLocalExpandedWorkGroups] = useState<Record<string, boolean>>(
    {},
  );
  const expandedWorkGroupsState = expandedWorkGroups ?? localExpandedWorkGroups;
  const handleToggleWorkGroup = useCallback(
    (groupId: string) => {
      if (onToggleWorkGroup) {
        onToggleWorkGroup(groupId);
        return;
      }
      setLocalExpandedWorkGroups((current) => ({
        ...current,
        [groupId]: !(current[groupId] ?? false),
      }));
    },
    [onToggleWorkGroup],
  );
  const [expandedCollapsedWork, setExpandedCollapsedWork] = useState<Record<string, boolean>>({});
  const setCollapsedWorkExpanded = useCallback((messageId: string, open: boolean) => {
    setExpandedCollapsedWork((current) => ({
      ...current,
      [messageId]: open,
    }));
  }, []);
  // Manual open/closed overrides for the collapsed tool-group summary rows,
  // keyed per group. Deliberately separate from expandedWorkGroupsState, whose
  // meaning is "show rows past the live +N cap".
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
  const [editingUserMessageId, setEditingUserMessageId] = useState<MessageId | null>(null);
  const [submittingEditedUserMessageId, setSubmittingEditedUserMessageId] =
    useState<MessageId | null>(null);
  // Transient highlight applied to a message jumped-to from the pinned-message checklist.
  const [highlightedMessageId, setHighlightedMessageId] = useState<MessageId | null>(null);
  const fallbackListRef = useRef<TranscriptVirtualListRef | null>(null);
  const resolvedListRef = listRef ?? fallbackListRef;
  const timelineRootRef = useRef<HTMLDivElement | null>(null);

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        isWorking,
        activeTurnInProgress,
        activeTurnId,
        activeTurnStartedAt,
      }),
    [timelineEntries, isWorking, activeTurnInProgress, activeTurnId, activeTurnStartedAt],
  );
  const rows = useStableRows(rawRows);
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
    const collapsedOwners = messageRows.filter((row) => (row.collapsedTurnItems?.length ?? 0) > 0);
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
        collapsedOwnerCount: collapsedOwners.length,
        collapsedNarrationCount: collapsedOwners.reduce(
          (count, row) =>
            count +
            (row.collapsedTurnItems?.filter((item) => item.kind === "narration").length ?? 0),
          0,
        ),
        collapsedWorkItemCount: collapsedOwners.reduce(
          (count, row) =>
            count + (row.collapsedTurnItems?.filter((item) => item.kind === "work").length ?? 0),
          0,
        ),
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
  // The newest work group renders its rows inline while the turn is live; every
  // older run of tool calls folds into a "Ran N commands..." summary row.
  const lastLiveWorkGroupId = useMemo(() => findLastLiveWorkGroupId(rows), [rows]);
  const firstUserMessageId = useMemo(() => {
    for (const row of rows) {
      if (row.kind === "message" && row.message.role === "user") {
        return row.message.id;
      }
    }
    return null;
  }, [rows]);
  const settledTurnCollapseTransitions = useSettledTurnCollapseTransitions(rows);
  const enteringMessageRowIds = useMessageSendEnterAnimations(rows, enteringUserMessageIds);
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
          const assistantWorkText = (
            workEntries: readonly WorkLogEntry[],
            workGroupId: string | null,
            placement: "leading" | "inline",
          ): string[] => {
            const displayEntries = workEntries.filter((entry) => !entry.penkraThreadCreation);
            const toolEntries = displayEntries.filter((entry) => entry.tone === "tool");
            const statusEntries = displayEntries.filter((entry) => entry.tone !== "tool");
            const hasGenericFileChangeEntry = toolEntries.some(
              (entry) => isFileChangeWorkLogEntry(entry) && (entry.changedFiles?.length ?? 0) === 0,
            );
            const orderedRenderableEntries = displayEntries.filter(
              (entry) =>
                !(
                  hasGenericFileChangeEntry &&
                  isFileChangeWorkLogEntry(entry) &&
                  (entry.changedFiles?.length ?? 0) === 0
                ),
            );
            const toolGroupId = toolEntries.length > 0 ? workGroupId : null;
            const toolExpanded =
              toolGroupId !== null ? (expandedWorkGroupsState[toolGroupId] ?? false) : false;
            const isLiveGroup =
              toolGroupId !== null &&
              toolGroupId === lastLiveWorkGroupId &&
              (activeTurnInProgress || isWorking);
            const renderPlan = capOpenWorkEntryRenderChunks(
              planWorkEntryRenderChunks(orderedRenderableEntries, {
                tailIsLive: placement === "inline" && isLiveGroup,
              }),
              {
                expanded: toolExpanded,
                maxVisibleEntries: MAX_VISIBLE_INLINE_TOOL_ENTRIES,
                keep: activeTurnInProgress ? "last" : "first",
                shouldCapEntry: (entry) => entry.tone === "tool",
              },
            );
            const toolText = renderPlan.chunks.flatMap((chunk) => {
              if (!chunk.summary) {
                return chunk.entries
                  .filter((entry) => entry.tone === "tool")
                  .map(workEntryFindText);
              }
              const summaryKey = `${placement}:${row.message.id}:${chunk.id}`;
              return (toolGroupSummaryOverrides[summaryKey] ?? false)
                ? [chunk.summary.label, ...chunk.entries.map(workEntryFindText)]
                : [chunk.summary.label];
            });
            return [...toolText, ...statusEntries.map(workEntryFindText)];
          };
          const hasCollapsedWork = Boolean(
            row.collapsedTurnItems?.some(
              (item) => item.kind !== "work" || !item.entry.penkraThreadCreation,
            ),
          );
          const leadingWorkText =
            row.message.role === "assistant" && !hasCollapsedWork
              ? assistantWorkText(
                  row.leadingWorkEntries ?? [],
                  row.leadingWorkGroupId ?? null,
                  "leading",
                )
              : [];
          const inlineWorkText =
            row.message.role === "assistant" && !hasCollapsedWork
              ? assistantWorkText(
                  row.inlineWorkEntries ?? [],
                  row.inlineWorkGroupId ?? null,
                  "inline",
                )
              : [];
          const text = [
            ...leadingWorkText,
            sourceText ? markdownVisibleText(sourceText) : "",
            ...inlineWorkText,
          ]
            .filter(Boolean)
            .join("\n");
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
        if (row.kind !== "work") return [];
        const displayEntries = row.groupedEntries.filter((entry) => !entry.penkraThreadCreation);
        const isLiveGroup = row.id === lastLiveWorkGroupId && (activeTurnInProgress || isWorking);
        const renderPlan = capOpenWorkEntryRenderChunks(
          planWorkEntryRenderChunks(displayEntries, { tailIsLive: isLiveGroup }),
          {
            expanded: expandedWorkGroupsState[row.id] ?? false,
            maxVisibleEntries: MAX_VISIBLE_WORK_LOG_ENTRIES,
            keep: "last",
          },
        );
        const visibleText = renderPlan.chunks
          .flatMap((chunk) => {
            if (!chunk.summary) return chunk.entries.map(workEntryFindText);
            const summaryKey = `${row.id}:${chunk.id}`;
            return (toolGroupSummaryOverrides[summaryKey] ?? false)
              ? [chunk.summary.label, ...chunk.entries.map(workEntryFindText)]
              : [chunk.summary.label];
          })
          .filter(Boolean)
          .join("\n");
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
    [
      activeTurnInProgress,
      expandedWorkGroupsState,
      isWorking,
      lastLiveWorkGroupId,
      rows,
      toolGroupSummaryOverrides,
    ],
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
  const tailScrollFrameRef = useRef<number | null>(null);
  const tailScrollTimeoutsRef = useRef<number[]>([]);
  const clearTailExpansionScrollTimers = useCallback(() => {
    if (tailScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(tailScrollFrameRef.current);
      tailScrollFrameRef.current = null;
    }
    for (const timeoutId of tailScrollTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    tailScrollTimeoutsRef.current = [];
  }, []);
  // Manual memoization kept: the main timeline component does not compile
  // under React Compiler (props-default destructuring bailout), so these
  // identities must be stabilized by hand.
  const scrollTailExpansionToEnd = useCallback(() => {
    clearTailExpansionScrollTimers();
    const scrollToEnd = () => {
      scrollTranscriptToEnd(resolvedListRef);
    };
    tailScrollFrameRef.current = window.requestAnimationFrame(() => {
      tailScrollFrameRef.current = null;
      scrollToEnd();
    });
    for (const delay of [80, 180, 260]) {
      const timeoutId = window.setTimeout(scrollToEnd, delay);
      tailScrollTimeoutsRef.current.push(timeoutId);
    }
  }, [clearTailExpansionScrollTimers, resolvedListRef]);
  useEffect(() => clearTailExpansionScrollTimers, [clearTailExpansionScrollTimers]);
  const ignoreTimelineImageLoad = useCallback(() => {}, []);
  const latestEditableUserMessageId = useMemo(() => {
    const messages = rows.flatMap((row) => (row.kind === "message" ? [row.message] : []));
    const editTarget = resolveLatestTailUserMessageEditTarget({
      messages,
      activeTurnId,
    });
    return editTarget.editable ? (editTarget.messageId as MessageId) : null;
  }, [activeTurnId, rows]);
  const latestEditableUserMessageText = useMemo(() => {
    if (!latestEditableUserMessageId) return null;
    const row = rows.find(
      (candidate) =>
        candidate.kind === "message" && candidate.message.id === latestEditableUserMessageId,
    );
    if (!row || row.kind !== "message" || row.message.role !== "user") return null;
    return deriveDisplayedUserMessageState(row.message.text).copyText.trim() || null;
  }, [latestEditableUserMessageId, rows]);
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
  const cancelUserMessageEdit = useCallback(() => {
    setEditingUserMessageId(null);
  }, []);
  const startUserMessageEdit = useCallback((messageId: MessageId) => {
    setEditingUserMessageId(messageId);
  }, []);
  const submitUserMessageEdit = useCallback(
    (messageId: MessageId, text: string) => {
      if (!onEditUserMessage) {
        return Promise.resolve();
      }
      const nextText = text.trim();
      if (!nextText) {
        return Promise.resolve();
      }
      setSubmittingEditedUserMessageId(messageId);
      // Promise chain instead of async/try-finally: React Compiler does not yet
      // support try/finally, and it would skip optimizing this whole component.
      return Promise.resolve(onEditUserMessage(messageId, nextText))
        .then((saved) => {
          if (saved) {
            cancelUserMessageEdit();
          }
        })
        .finally(() => {
          setSubmittingEditedUserMessageId(null);
        });
    },
    [cancelUserMessageEdit, onEditUserMessage],
  );

  const renderRowContent = (row: MessagesTimelineRow) => {
    const content = (
      <div
        className={cn(
          CHAT_COLUMN_FRAME_CLASS_NAME,
          "px-1 transition-colors duration-500",
          row.kind === "work" ||
            row.kind === "working-header" ||
            (row.kind === "message" && row.message.role === "assistant")
            ? "pb-2"
            : "pb-4",
          row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
          row.kind === "message" && row.message.id === highlightedMessageId
            ? "rounded-xl bg-[var(--color-background-elevated-secondary)]"
            : null,
          enteringMessageRowIds.has(row.id) ? "chat-message-send-enter" : null,
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
        {row.kind === "work" &&
          (() => {
            const groupId = row.id;
            // Creation milestones are reserved for the end-of-turn recap card.
            // The provider's actual Penkra MCP tool rows remain visible here.
            const groupedEntries = row.groupedEntries.filter(
              (workEntry) => !workEntry.penkraThreadCreation,
            );
            if (groupedEntries.length === 0) {
              return null;
            }
            const renderEntryRow = (workEntry: WorkLogEntry) => (
              <TimelineWorkEntryRow
                key={`work-row:${workEntry.id}`}
                workEntry={workEntry}
                chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                textFontSizePx={normalizedChatFontSizePx}
                density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
                markdownCwd={markdownCwd}
                onImageExpand={onImageExpand}
                {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
                {...(onOpenThread ? { onOpenThread } : {})}
                {...(subagentToolTraceByThreadId ? { subagentToolTraceByThreadId } : {})}
              />
            );
            const isLiveGroup =
              groupId === lastLiveWorkGroupId && (activeTurnInProgress || isWorking);
            const isExpanded = expandedWorkGroupsState[groupId] ?? false;
            const plannedRenderChunks = planWorkEntryRenderChunks(groupedEntries, {
              tailIsLive: isLiveGroup,
            });
            const cappedRenderPlan = capOpenWorkEntryRenderChunks(plannedRenderChunks, {
              expanded: isExpanded,
              maxVisibleEntries: MAX_VISIBLE_WORK_LOG_ENTRIES,
              keep: "last",
            });
            const renderChunks = cappedRenderPlan.chunks;
            const hasCollapsedChunk = renderChunks.some((chunk) => chunk.summary !== null);
            if (hasCollapsedChunk) {
              return (
                <div>
                  <div className="space-y-0.5">
                    {renderChunks.map((chunk) => {
                      if (!chunk.summary) return chunk.entries.map(renderEntryRow);
                      const summary = chunk.summary;
                      const summaryKey = `${groupId}:${chunk.id}`;
                      return (
                        <ToolCallGroupSummaryRow
                          key={`tool-summary:${summaryKey}`}
                          summary={summary}
                          open={toolGroupSummaryOverrides[summaryKey] ?? false}
                          onToggle={(open) => setToolGroupSummaryOpen(summaryKey, open)}
                          fontSizePx={normalizedChatFontSizePx}
                          renderChildren={() => (
                            <div className="space-y-0.5 pt-0.5">
                              {chunk.entries.map(renderEntryRow)}
                            </div>
                          )}
                        />
                      );
                    })}
                  </div>
                  {cappedRenderPlan.hasOverflow && (
                    <div className="mt-1.5 flex items-center justify-start gap-2 px-0.5">
                      <button
                        type="button"
                        className="font-system-ui text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                        style={{ fontSize: `${appTypographyScale.uiSmPx}px` }}
                        onClick={() => handleToggleWorkGroup(groupId)}
                      >
                        {isExpanded
                          ? "Show less"
                          : `Show ${cappedRenderPlan.hiddenEntryCount} more`}
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
            const visibleEntries =
              hasOverflow && !isExpanded
                ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
                : groupedEntries;
            const hiddenCount = groupedEntries.length - visibleEntries.length;
            const showOverflowToggle = hasOverflow;

            return (
              <div>
                <div className="space-y-0.5">{visibleEntries.map(renderEntryRow)}</div>
                {showOverflowToggle && (
                  <div className="mt-1.5 flex items-center justify-start gap-2 px-0.5">
                    <button
                      type="button"
                      className="font-system-ui text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                      style={{ fontSize: `${appTypographyScale.uiSmPx}px` }}
                      onClick={() => handleToggleWorkGroup(groupId)}
                    >
                      {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                    </button>
                  </div>
                )}
              </div>
            );
          })()}

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
            const isEditingThisMessage = editingUserMessageId === row.message.id;
            const isSubmittingThisEdit = submittingEditedUserMessageId === row.message.id;
            const showEditUserMessage =
              Boolean(onEditUserMessage) &&
              row.message.id === latestEditableUserMessageId &&
              displayedUserMessage.copyText.trim().length > 0;
            const hasLeadingMedia = hasLeadingUserMedia({
              imageCount: userImages.length,
              fileCount: userFiles.length,
              assistantSelectionCount: renderedAssistantSelections.length,
              fileCommentCount: renderedFileComments.length,
              pastedTextCount: renderedPastedTexts.length,
            });
            const isTailContentRow = row.id === tailContentRowId;
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
                  <div
                    className={cn(
                      "group flex flex-col items-end gap-px",
                      isEditingThisMessage ? "w-full max-w-full" : "max-w-[80%]",
                    )}
                  >
                    {/* Keep user-message chrome outside the bubble so the message reads as one simple block. */}
                    {/* The cross-task origin label already attributes this turn to another Penkra thread,
                      so suppress the dispatch chip here to avoid a duplicate "Sent by …" marker. */}
                    {showCrossTaskOrigin ? null : (
                      <UserDispatchModeChip
                        dispatchMode={row.message.dispatchMode}
                        dispatchOrigin={row.message.dispatchOrigin}
                        hasLeadingMedia={hasLeadingMedia}
                      />
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
                            onTimelineImageLoad={
                              isTailContentRow ? scrollTailExpansionToEnd : ignoreTimelineImageLoad
                            }
                            resolvedTheme={resolvedTheme}
                          />
                        ))}
                      </div>
                    )}
                    {isEditingThisMessage ? (
                      <UserMessageEditForm
                        key={row.message.id}
                        initialValue={displayedUserMessage.copyText}
                        disabled={isSubmittingThisEdit}
                        chatTypographyStyle={userMessageTypographyStyle}
                        onCancel={cancelUserMessageEdit}
                        onSubmit={(text) => void submitUserMessageEdit(row.message.id, text)}
                      />
                    ) : showUserText ? (
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
                    {!isEditingThisMessage && (
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
                          {showEditUserMessage && (
                            <MessageActionButton
                              label="Edit message"
                              tooltip="Edit message"
                              className={cn(
                                MESSAGE_HOVER_REVEAL_CLASS_NAME,
                                "disabled:text-muted-foreground/35",
                              )}
                              onClick={() => startUserMessageEdit(row.message.id)}
                            >
                              <PencilIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
                            </MessageActionButton>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </MessageUser>
            );
          })()}

        {row.kind === "message" &&
          row.message.role === "assistant" &&
          (() => {
            const messageText = resolveAssistantMessageDisplayText(row);
            const buildWorkDisplay = (workEntries: WorkLogEntry[], workGroupId: string | null) => {
              const displayEntries = workEntries.filter((entry) => !entry.penkraThreadCreation);
              const toolEntries = displayEntries.filter((entry) => entry.tone === "tool");
              const statusEntries = displayEntries.filter((entry) => entry.tone !== "tool");
              const toolGroupId = toolEntries.length > 0 ? workGroupId : null;
              const toolExpanded =
                toolGroupId !== null ? (expandedWorkGroupsState[toolGroupId] ?? false) : false;
              const visibleToolEntries =
                toolExpanded || toolEntries.length <= MAX_VISIBLE_INLINE_TOOL_ENTRIES
                  ? toolEntries
                  : activeTurnInProgress
                    ? toolEntries.slice(-MAX_VISIBLE_INLINE_TOOL_ENTRIES)
                    : toolEntries.slice(0, MAX_VISIBLE_INLINE_TOOL_ENTRIES);
              const hasGenericFileChangeEntry = toolEntries.some(
                (workEntry) =>
                  isFileChangeWorkLogEntry(workEntry) &&
                  (workEntry.changedFiles?.length ?? 0) === 0,
              );
              const isRenderableToolEntry = (workEntry: WorkLogEntry) =>
                !(
                  hasGenericFileChangeEntry &&
                  isFileChangeWorkLogEntry(workEntry) &&
                  (workEntry.changedFiles?.length ?? 0) === 0
                );
              return {
                toolEntries,
                statusEntries,
                toolGroupId,
                toolExpanded,
                // Ordered (tool + narration interleaved) so chunking sees the
                // thinking/info boundaries that split tool runs mid-turn.
                orderedRenderableEntries: displayEntries.filter(isRenderableToolEntry),
                renderableToolEntries: toolEntries.filter(isRenderableToolEntry),
                visibleRenderableToolEntries: visibleToolEntries.filter(isRenderableToolEntry),
                hiddenToolCount: toolEntries.length - visibleToolEntries.length,
                hasGenericFileChangeEntry,
              };
            };
            const leadingWorkDisplay = buildWorkDisplay(
              row.leadingWorkEntries ?? [],
              row.leadingWorkGroupId ?? null,
            );
            const inlineWorkDisplay = buildWorkDisplay(
              row.inlineWorkEntries ?? [],
              row.inlineWorkGroupId ?? null,
            );
            const assistantCopyState = resolveAssistantMessageCopyState({
              text: row.message.text ?? null,
              showCopyButton: row.showAssistantCopyButton,
              streaming: row.assistantCopyStreaming,
            });
            const messagePinned = pinnedMessageIds?.has(row.message.id) ?? false;
            const messageCanPin = canPinMessage?.(row.message.id) ?? true;
            // Offer the pin toggle wherever copy is offered (a complete, terminal answer);
            // keep it visible for an already-pinned message so it can always be unpinned.
            const showPinToggle =
              messageCanPin &&
              Boolean(onTogglePinMessage) &&
              (assistantCopyState.visible || messagePinned);
            // Only the turn's final answer carries a timestamp. Intermediate
            // working preambles (and their inline tool calls) stay timestamp-free
            // so a live turn reads as one block, not a stack of timestamped
            // fragments. `showAssistantCopyButton` is exactly the terminal-message
            // signal (see deriveTerminalAssistantMessageIds).
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
            const allTurnWorkEntries = [
              ...(row.leadingWorkEntries ?? []),
              ...(row.inlineWorkEntries ?? []),
              ...(row.collapsedTurnItems ?? []).flatMap((item) =>
                item.kind === "work" ? [item.entry] : [],
              ),
            ];
            const penkraThreadCreationRecaps = [
              ...new Map(
                allTurnWorkEntries.flatMap((entry) =>
                  entry.penkraThreadCreation
                    ? [
                        [
                          entry.penkraThreadCreation.operationId,
                          entry.penkraThreadCreation,
                        ] as const,
                      ]
                    : [],
                ),
              ).values(),
            ];
            const collapsedTurnItems = row.collapsedTurnItems?.filter(
              (item) => item.kind !== "work" || !item.entry.penkraThreadCreation,
            );
            const hasCollapsedWork = Boolean(collapsedTurnItems && collapsedTurnItems.length > 0);
            const isCollapsedWorkExpanded = hasCollapsedWork
              ? (expandedCollapsedWork[row.message.id] ?? false)
              : false;
            const settledCollapseTransition = isCollapsedWorkExpanded
              ? undefined
              : settledTurnCollapseTransitions[row.message.id];
            const isTailContentRow = row.id === tailContentRowId;
            const renderWorkDisplay = (
              display: typeof leadingWorkDisplay,
              placement: "leading" | "inline",
            ) => {
              const renderInlineToolRow = (workEntry: WorkLogEntry) => (
                <TimelineWorkEntryRow
                  key={`${placement}-tool-row:${row.message.id}:${workEntry.id}`}
                  workEntry={workEntry}
                  chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                  textFontSizePx={normalizedChatFontSizePx}
                  density="compact"
                  markdownCwd={markdownCwd}
                  onImageExpand={onImageExpand}
                  {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
                  {...(onOpenThread ? { onOpenThread } : {})}
                  {...(subagentToolTraceByThreadId ? { subagentToolTraceByThreadId } : {})}
                />
              );
              const isLiveGroup =
                display.toolGroupId !== null &&
                display.toolGroupId === lastLiveWorkGroupId &&
                (activeTurnInProgress || isWorking);
              // Leading groups are never a live tail: the message's own text
              // already follows them, so their last tool run collapses too.
              const plannedRenderChunks = planWorkEntryRenderChunks(
                display.orderedRenderableEntries,
                {
                  tailIsLive: placement === "inline" && isLiveGroup,
                },
              );
              const cappedRenderPlan = capOpenWorkEntryRenderChunks(plannedRenderChunks, {
                expanded: display.toolExpanded,
                maxVisibleEntries: MAX_VISIBLE_INLINE_TOOL_ENTRIES,
                keep: activeTurnInProgress ? "last" : "first",
                shouldCapEntry: (workEntry) => workEntry.tone === "tool",
              });
              const renderChunks = cappedRenderPlan.chunks;
              const collapseAsSummary = renderChunks.some((chunk) => chunk.summary !== null);
              return (
                <>
                  {!hasCollapsedWork &&
                    collapseAsSummary &&
                    display.renderableToolEntries.length > 0 && (
                      <div className={placement === "leading" ? "mb-1.5" : "mt-1.5"}>
                        <div className="space-y-px">
                          {renderChunks.map((chunk) => {
                            if (!chunk.summary) {
                              // Narration-tone entries render in the status block
                              // below; here they only serve as run boundaries.
                              return chunk.entries
                                .filter((workEntry) => workEntry.tone === "tool")
                                .map(renderInlineToolRow);
                            }
                            const summary = chunk.summary;
                            // Message ids stay stable while a live group's first-entry id can drift.
                            const summaryOverrideKey = `${placement}:${row.message.id}:${chunk.id}`;
                            return (
                              <ToolCallGroupSummaryRow
                                key={`inline-tool-summary:${summaryOverrideKey}`}
                                summary={summary}
                                open={toolGroupSummaryOverrides[summaryOverrideKey] ?? false}
                                onToggle={(open) =>
                                  setToolGroupSummaryOpen(summaryOverrideKey, open)
                                }
                                fontSizePx={normalizedChatFontSizePx}
                                renderChildren={() => (
                                  <div className="space-y-px pt-0.5">
                                    {chunk.entries.map(renderInlineToolRow)}
                                  </div>
                                )}
                              />
                            );
                          })}
                        </div>
                        {display.toolGroupId && cappedRenderPlan.hasOverflow && (
                          <div className="py-0.5">
                            <button
                              type="button"
                              className="text-muted-foreground/50 transition-colors duration-150 hover:text-foreground/72"
                              style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                              onClick={() => handleToggleWorkGroup(display.toolGroupId!)}
                            >
                              {display.toolExpanded
                                ? "Show less"
                                : `+${cappedRenderPlan.hiddenEntryCount} more tool calls`}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  {!hasCollapsedWork &&
                    !collapseAsSummary &&
                    display.visibleRenderableToolEntries.length > 0 && (
                      <div className={placement === "leading" ? "mb-1.5" : "mt-1.5"}>
                        <div className="space-y-px">
                          {display.visibleRenderableToolEntries.map(renderInlineToolRow)}
                        </div>
                        {display.toolGroupId &&
                          display.toolEntries.length > MAX_VISIBLE_INLINE_TOOL_ENTRIES && (
                            <div className="py-0.5">
                              <button
                                type="button"
                                className="text-muted-foreground/50 transition-colors duration-150 hover:text-foreground/72"
                                style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                                onClick={() => handleToggleWorkGroup(display.toolGroupId!)}
                              >
                                {display.toolExpanded
                                  ? "Show less"
                                  : `+${display.hiddenToolCount} more tool calls`}
                              </button>
                            </div>
                          )}
                      </div>
                    )}
                  {!hasCollapsedWork && display.statusEntries.length > 0 && (
                    <div className={cn("space-y-0.5", placement === "leading" ? "mb-2" : "mt-2")}>
                      {display.statusEntries.map((workEntry) => (
                        <TimelineWorkEntryRow
                          key={`${placement}-status-row:${row.message.id}:${workEntry.id}`}
                          workEntry={workEntry}
                          chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                          textFontSizePx={normalizedChatFontSizePx}
                          density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
                          markdownCwd={markdownCwd}
                          onImageExpand={onImageExpand}
                          {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
                          {...(onOpenThread ? { onOpenThread } : {})}
                          {...(subagentToolTraceByThreadId ? { subagentToolTraceByThreadId } : {})}
                        />
                      ))}
                    </div>
                  )}
                </>
              );
            };
            const renderCollapsedTurnItem = (item: CollapsedTurnItem, keyPrefix: string) =>
              item.kind === "work" ? (
                <TimelineWorkEntryRow
                  key={`${keyPrefix}:work:${row.message.id}:${item.id}`}
                  workEntry={item.entry}
                  chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                  textFontSizePx={normalizedChatFontSizePx}
                  density={prefersCompactWorkEntryRow(item.entry) ? "compact" : "default"}
                  markdownCwd={markdownCwd}
                  onImageExpand={onImageExpand}
                  {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
                  {...(onOpenThread ? { onOpenThread } : {})}
                  {...(subagentToolTraceByThreadId ? { subagentToolTraceByThreadId } : {})}
                />
              ) : (
                <div
                  key={`${keyPrefix}:narration:${row.message.id}:${item.id}`}
                  className="text-muted-foreground/80"
                >
                  <ChatMarkdown
                    text={item.message.text}
                    cwd={markdownCwd}
                    isStreaming={false}
                    style={chatTypographyStyle}
                    onImageExpand={onImageExpand}
                  />
                </div>
              );
            const renderCollapsedTurnChunk = (chunk: CollapsedTurnChunk, keyPrefix: string) => {
              if (chunk.kind === "item") {
                return renderCollapsedTurnItem(chunk.item, keyPrefix);
              }
              const summary = summarizeToolCallGroup(chunk.entries);
              if (!summary) {
                return chunk.entries.map((entry) =>
                  renderCollapsedTurnItem({ kind: "work", id: entry.id, entry }, keyPrefix),
                );
              }
              const summaryOverrideKey = `turn:${row.message.id}:${chunk.id}`;
              return (
                <ToolCallGroupSummaryRow
                  key={`${keyPrefix}:tool-group:${row.message.id}:${chunk.id}`}
                  summary={summary}
                  open={toolGroupSummaryOverrides[summaryOverrideKey] ?? false}
                  onToggle={(open) => setToolGroupSummaryOpen(summaryOverrideKey, open)}
                  fontSizePx={normalizedChatFontSizePx}
                  renderChildren={() => (
                    <div className="space-y-0.5 pt-0.5">
                      {chunk.entries.map((entry) =>
                        renderCollapsedTurnItem({ kind: "work", id: entry.id, entry }, keyPrefix),
                      )}
                    </div>
                  )}
                />
              );
            };
            return (
              <MessageAssistant layoutMode="application" workedFor={null}>
                {settledCollapseTransition && (
                  <div
                    aria-hidden="true"
                    inert
                    // The clone is visual-only for the entire close transition; keep it inert
                    // even while the inner DisclosureRegion starts open for its first frame.
                    className="pointer-events-none mb-3 select-none"
                    data-settled-turn-collapse-transition="true"
                  >
                    <DisclosureRegion
                      open={settledCollapseTransition.open}
                      contentClassName="space-y-1.5 pb-2.5"
                    >
                      {chunkCollapsedTurnItems(settledCollapseTransition.items).map((chunk) =>
                        renderCollapsedTurnChunk(chunk, "settling-turn-close"),
                      )}
                    </DisclosureRegion>
                  </div>
                )}
                {hasCollapsedWork && (
                  <div className="mb-3">
                    <Collapsible
                      className="group/collapsed-work"
                      open={isCollapsedWorkExpanded}
                      onOpenChange={(open) => {
                        setCollapsedWorkExpanded(row.message.id, open);
                      }}
                    >
                      <CollapsibleTrigger
                        // ChatView's click anchor preserves this trigger's screen position
                        // while the disclosure height animates, so opening it should not tail-scroll.
                        // -ml-0.5 optically aligns the leading "W" with the reply
                        // text below: the box is already flush, but the W glyph
                        // carries a left side-bearing that reads as an inset.
                        className="-ml-0.5 inline-flex items-center gap-1 pb-2 text-left text-muted-foreground/70 transition-colors duration-200 hover:text-muted-foreground/90"
                        style={{ fontSize: chatTypographyStyle.fontSize }}
                      >
                        <span>
                          {row.collapsedWorkElapsed
                            ? `Worked for ${row.collapsedWorkElapsed}`
                            : "Details"}
                        </span>
                        <DisclosureChevron
                          open={isCollapsedWorkExpanded}
                          className="text-muted-foreground/55"
                        />
                      </CollapsibleTrigger>
                      <CollapsiblePanel>
                        <div
                          className={disclosureContentClassName(
                            isCollapsedWorkExpanded,
                            "mb-2.5 space-y-1.5",
                          )}
                        >
                          {chunkCollapsedTurnItems(collapsedTurnItems!).map((chunk) =>
                            renderCollapsedTurnChunk(chunk, "collapsed-panel"),
                          )}
                        </div>
                      </CollapsiblePanel>
                    </Collapsible>
                    <div className="h-px w-full bg-border" />
                  </div>
                )}
                <div className="group min-w-0 py-0.5">
                  {renderWorkDisplay(leadingWorkDisplay, "leading")}
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
                  {renderWorkDisplay(inlineWorkDisplay, "inline")}
                  {(showPinToggle || assistantCopyState.visible || assistantMeta.length > 0) && (
                    <div
                      className="mt-0.5 flex h-[26px] items-center gap-1 font-system-ui font-normal text-muted-foreground/45"
                      data-pencil-component="vI265"
                      style={chatMessageFooterStyle}
                    >
                      {showPinToggle ? (
                        // Pin sits at the left edge of the footer, before the copy action. It stays
                        // visible when pinned so it reads as a persistent "this is pinned" marker; an
                        // unpinned message only reveals it on hover, like the other footer actions.
                        // Same Central pin glyph in both states — persistence signals the pinned state.
                        <MessageActionButton
                          label={pinActionLabel("message", messagePinned)}
                          tooltip={messagePinned ? "Unpin from panel" : "Pin to panel"}
                          aria-pressed={messagePinned}
                          className={
                            messagePinned
                              ? "text-muted-foreground/80"
                              : MESSAGE_HOVER_REVEAL_CLASS_NAME
                          }
                          onClick={() => onTogglePinMessage?.(row.message.id)}
                        >
                          <PinIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
                        </MessageActionButton>
                      ) : null}
                      {assistantCopyState.visible ? (
                        <MessageCopyButton
                          text={assistantCopyState.text ?? ""}
                          className={MESSAGE_HOVER_REVEAL_CLASS_NAME}
                          label="Copy response"
                        />
                      ) : null}
                      {assistantCopyState.visible &&
                      latestEditableUserMessageId &&
                      latestEditableUserMessageText &&
                      onEditUserMessage ? (
                        <MessageActionButton
                          label="Retry response"
                          tooltip="Retry response"
                          className={MESSAGE_HOVER_REVEAL_CLASS_NAME}
                          onClick={() =>
                            void onEditUserMessage(
                              latestEditableUserMessageId,
                              latestEditableUserMessageText,
                            )
                          }
                        >
                          <RotateCcwIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
                        </MessageActionButton>
                      ) : null}
                      {assistantMeta.length > 0 ? (
                        <p className={cn("px-2 tabular-nums", MESSAGE_HOVER_REVEAL_CLASS_NAME)}>
                          {assistantMeta}
                        </p>
                      ) : null}
                    </div>
                  )}
                  {!row.assistantTurnInProgress && row.showAssistantCopyButton
                    ? penkraThreadCreationRecaps.map((creation) => (
                        <div key={creation.operationId} className="mt-2 mb-4">
                          <PenkraThreadCreationCard
                            creation={creation}
                            {...(onOpenThread
                              ? {
                                  onOpenThread: (createdThreadId) =>
                                    onOpenThread(ThreadId.makeUnsafe(createdThreadId)),
                                }
                              : {})}
                          />
                        </div>
                      ))
                    : null}
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
        {...(onNearStart === undefined ? {} : { onNearStart })}
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
type SettledTurnCollapseTransition = {
  open: boolean;
  items: readonly CollapsedTurnItem[];
};
type SettledTurnCollapseTimer = {
  closeFrame: number | null;
  cleanupTimeout: number | null;
};

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

// Animates only user rows that ChatView identifies as local optimistic sends;
// transcript hydration can add rows too, but should not replay send motion.
function useMessageSendEnterAnimations(
  rows: readonly MessagesTimelineRow[],
  enteringUserMessageIds: ReadonlySet<MessageId>,
): ReadonlySet<string> {
  const [enteringRowIds, setEnteringRowIds] = useState<ReadonlySet<string>>(() => new Set());
  const previousRowIdsRef = useRef<ReadonlySet<string> | null>(null);
  const cleanupTimeoutsRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    applyMessageSendEnterAnimation({
      rows,
      enteringUserMessageIds,
      previousRowIdsRef,
      cleanupTimeoutsRef,
      setEnteringRowIds,
    });
  }, [enteringUserMessageIds, rows]);

  useEffect(
    () => () => {
      for (const timeoutId of cleanupTimeoutsRef.current) {
        window.clearTimeout(timeoutId);
      }
      cleanupTimeoutsRef.current = [];
    },
    [],
  );

  return enteringRowIds;
}

// The fresh-row detection compares against the previous layout pass and stamps the
// entering class before paint, so the send motion cannot flash. Running it from a
// module helper (which the compiler doesn't scan) keeps that synchronous setState
// out of the compiled hook without deferring it to a rAF/timeout that would paint a
// frame before the class lands.
function applyMessageSendEnterAnimation(params: {
  rows: readonly MessagesTimelineRow[];
  enteringUserMessageIds: ReadonlySet<MessageId>;
  previousRowIdsRef: RefObject<ReadonlySet<string> | null>;
  cleanupTimeoutsRef: RefObject<number[]>;
  setEnteringRowIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
}): void {
  const { rows, enteringUserMessageIds, previousRowIdsRef, cleanupTimeoutsRef, setEnteringRowIds } =
    params;
  const currentRowIds = new Set(rows.map((row) => row.id));
  const previousRowIds = previousRowIdsRef.current;
  previousRowIdsRef.current = currentRowIds;

  const freshUserRowIds = rows
    .filter(
      (row) =>
        row.kind === "message" &&
        row.message.role === "user" &&
        enteringUserMessageIds.has(row.message.id) &&
        (previousRowIds === null || !previousRowIds.has(row.id)),
    )
    .map((row) => row.id);
  if (freshUserRowIds.length === 0) {
    return;
  }

  setEnteringRowIds((current) => {
    const next = new Set(current);
    for (const rowId of freshUserRowIds) {
      next.add(rowId);
    }
    return next;
  });

  const cleanupTimeout = window.setTimeout(() => {
    cleanupTimeoutsRef.current = cleanupTimeoutsRef.current.filter((id) => id !== cleanupTimeout);
    setEnteringRowIds((current) => {
      const next = new Set(current);
      for (const rowId of freshUserRowIds) {
        next.delete(rowId);
      }
      return next.size === current.size ? current : next;
    });
  }, MESSAGE_SEND_ENTER_ANIMATION_MS + MESSAGE_SEND_ENTER_CLEANUP_BUFFER_MS);
  cleanupTimeoutsRef.current.push(cleanupTimeout);
}

// Keeps newly folded turn details mounted for one shared-disclosure close
// animation, so settled turns do not disappear in one height recalculation.
function useSettledTurnCollapseTransitions(
  rows: readonly MessagesTimelineRow[],
): Readonly<Record<string, SettledTurnCollapseTransition>> {
  const [transitions, setTransitions] = useState<Record<string, SettledTurnCollapseTransition>>({});
  const previousAssistantMessageIdsRef = useRef<ReadonlySet<string>>(new Set());
  const previousCollapsedSignaturesRef = useRef<ReadonlyMap<string, string>>(new Map());
  const timersRef = useRef(new Map<string, SettledTurnCollapseTimer>());

  const clearTransitionTimer = useCallback((messageId: string) => {
    const timer = timersRef.current.get(messageId);
    if (!timer) {
      return;
    }
    if (timer.closeFrame !== null) {
      window.cancelAnimationFrame(timer.closeFrame);
    }
    if (timer.cleanupTimeout !== null) {
      window.clearTimeout(timer.cleanupTimeout);
    }
    timersRef.current.delete(messageId);
  }, []);

  const scheduleTransitionClose = useCallback(
    (messageId: string) => {
      clearTransitionTimer(messageId);
      const closeFrame = window.requestAnimationFrame(() => {
        const timer = timersRef.current.get(messageId);
        if (!timer) {
          return;
        }
        timersRef.current.set(messageId, { ...timer, closeFrame: null });
        setTransitions((current) => {
          const transition = current[messageId];
          if (!transition || !transition.open) {
            return current;
          }
          return {
            ...current,
            [messageId]: { ...transition, open: false },
          };
        });

        const cleanupTimeout = window.setTimeout(() => {
          timersRef.current.delete(messageId);
          setTransitions((current) => {
            if (!current[messageId]) {
              return current;
            }
            const next = { ...current };
            delete next[messageId];
            return next;
          });
        }, DISCLOSURE_TRANSITION_MS);
        timersRef.current.set(messageId, { closeFrame: null, cleanupTimeout });
      });
      timersRef.current.set(messageId, { closeFrame, cleanupTimeout: null });
    },
    [clearTransitionTimer],
  );

  useLayoutEffect(() => {
    applySettledTurnCollapseTransitions({
      rows,
      previousAssistantMessageIdsRef,
      previousCollapsedSignaturesRef,
      clearTransitionTimer,
      scheduleTransitionClose,
      setTransitions,
    });
  }, [clearTransitionTimer, rows, scheduleTransitionClose]);

  useEffect(
    () => () => {
      for (const messageId of Array.from(timersRef.current.keys())) {
        clearTransitionTimer(messageId);
      }
    },
    [clearTransitionTimer],
  );

  return transitions;
}

// Detects turns that just folded and drives their close animation. Kept in a module
// helper (not compiled) so the synchronous open setState stays out of the hook while
// its ordering against scheduleTransitionClose — which needs the open state committed
// before it schedules the closing rAF — is preserved exactly.
function applySettledTurnCollapseTransitions(params: {
  rows: readonly MessagesTimelineRow[];
  previousAssistantMessageIdsRef: RefObject<ReadonlySet<string>>;
  previousCollapsedSignaturesRef: RefObject<ReadonlyMap<string, string>>;
  clearTransitionTimer: (messageId: string) => void;
  scheduleTransitionClose: (messageId: string) => void;
  setTransitions: Dispatch<SetStateAction<Record<string, SettledTurnCollapseTransition>>>;
}): void {
  const {
    rows,
    previousAssistantMessageIdsRef,
    previousCollapsedSignaturesRef,
    clearTransitionTimer,
    scheduleTransitionClose,
    setTransitions,
  } = params;
  const currentAssistantMessageIds = new Set<string>();
  const currentCollapsed = new Map<
    string,
    { signature: string; items: readonly CollapsedTurnItem[] }
  >();

  for (const row of rows) {
    if (row.kind !== "message" || row.message.role !== "assistant") {
      continue;
    }
    const messageId = row.message.id;
    currentAssistantMessageIds.add(messageId);
    if (row.collapsedTurnItems && row.collapsedTurnItems.length > 0) {
      currentCollapsed.set(messageId, {
        signature: collapsedTurnItemsSignature(row.collapsedTurnItems),
        items: row.collapsedTurnItems,
      });
    }
  }

  const previousAssistantMessageIds = previousAssistantMessageIdsRef.current;
  const previousCollapsedSignatures = previousCollapsedSignaturesRef.current;
  const startedTransitions: Array<{
    messageId: string;
    items: readonly CollapsedTurnItem[];
  }> = [];

  for (const [messageId, collapsed] of currentCollapsed) {
    if (previousAssistantMessageIds.has(messageId) && !previousCollapsedSignatures.has(messageId)) {
      startedTransitions.push({ messageId, items: collapsed.items });
    }
  }

  previousAssistantMessageIdsRef.current = currentAssistantMessageIds;
  previousCollapsedSignaturesRef.current = new Map(
    Array.from(currentCollapsed, ([messageId, collapsed]) => [messageId, collapsed.signature]),
  );

  setTransitions((current) => {
    let next: Record<string, SettledTurnCollapseTransition> | null = null;
    const ensureNext = () => {
      next ??= { ...current };
      return next;
    };

    for (const messageId of Object.keys(current)) {
      if (!currentCollapsed.has(messageId)) {
        clearTransitionTimer(messageId);
        delete ensureNext()[messageId];
      }
    }

    for (const transition of startedTransitions) {
      ensureNext()[transition.messageId] = {
        open: true,
        items: transition.items,
      };
    }

    return next ?? current;
  });

  for (const transition of startedTransitions) {
    scheduleTransitionClose(transition.messageId);
  }
}

function collapsedTurnItemsSignature(items: readonly CollapsedTurnItem[]): string {
  return items.map((item) => `${item.kind}:${item.id}`).join("|");
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
    const id = window.setInterval(updateText, 1000);
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
  onTimelineImageLoad: () => void;
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
          onLoad={props.onTimelineImageLoad}
          onError={props.onTimelineImageLoad}
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

// Inline editor for replaying a user message after the following assistant turn is rolled back.
const UserMessageEditForm = memo(function UserMessageEditForm(props: {
  initialValue: string;
  disabled: boolean;
  chatTypographyStyle: CSSProperties;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(props.initialValue);
  const canSubmit = draft.trim().length > 0 && !props.disabled;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSubmit) {
        props.onSubmit(draft);
      }
    }
  };

  return (
    <form
      className={cn(
        "w-full bg-[var(--app-user-message-background)]",
        USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
        USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) {
          props.onSubmit(draft);
        }
      }}
    >
      <textarea
        ref={textareaRef}
        value={draft}
        disabled={props.disabled}
        rows={1}
        aria-label="Edit message"
        className="max-h-60 min-h-0 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 font-system-ui text-foreground outline-none placeholder:text-muted-foreground/45 disabled:opacity-70"
        style={props.chatTypographyStyle}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="rounded-full px-2.5"
          style={props.chatTypographyStyle}
          disabled={props.disabled}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          className="rounded-full px-2.5"
          style={props.chatTypographyStyle}
          disabled={!canSubmit}
        >
          Send
        </Button>
      </div>
    </form>
  );
});

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
