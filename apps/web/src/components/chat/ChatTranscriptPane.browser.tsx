import "../../index.css";

import { MessageId } from "@penkra/contracts";
import { page, userEvent } from "vitest/browser";
import { Profiler, useRef, useState, type ProfilerOnRenderCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ChatTranscriptPane } from "./ChatTranscriptPane";
import { ComposerPromptEditor } from "../ComposerPromptEditor";
import type { TranscriptVirtualListRef } from "./TranscriptVirtualList";
import { useTranscriptAssistantSelectionAction } from "./useTranscriptAssistantSelectionAction";
import {
  ChatPerformanceBoundary,
  enableChatPerformanceDiagnostics,
  getChatPerformanceSummary,
  resetChatPerformanceDiagnostics,
} from "../../chatPerformanceDiagnostics";

const EMPTY_WORK_GROUPS: Record<string, boolean> = {};
const NOOP = () => {};
const TIMELINE_ENTRIES = Array.from({ length: 300 }, (_, index) => ({
  id: `assistant-message-entry-${index}`,
  kind: "message" as const,
  createdAt: "2026-03-17T19:12:28.000Z",
  message: {
    id: MessageId.makeUnsafe(`assistant-message-${index}`),
    role: "assistant" as const,
    text: `Stable assistant message ${index} for the long transcript performance harness.`,
    createdAt: "2026-03-17T19:12:28.000Z",
    streaming: false,
  },
}));

async function settleLayout(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function TranscriptPerfHarness(props: { onTranscriptRender: () => void }) {
  const [composerValue, setComposerValue] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const composerImagesRef = useRef<readonly []>([]);
  const composerFilesRef = useRef<readonly []>([]);
  const composerAssistantSelectionsRef = useRef<readonly []>([]);
  const listRef = useRef<TranscriptVirtualListRef | null>(null);
  const {
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
  } = useTranscriptAssistantSelectionAction({
    threadId: "thread-transcript-perf",
    enabled: true,
    composerImagesRef,
    composerFilesRef,
    composerAssistantSelectionsRef,
    addComposerAssistantSelectionToDraft: () => true,
    scheduleComposerFocus: NOOP,
    onMessagesClickCaptureBase: NOOP,
    onMessagesPointerCancelBase: NOOP,
    onMessagesPointerDownBase: NOOP,
    onMessagesPointerUpBase: NOOP,
    onMessagesScrollBase: NOOP,
    onMessagesTouchEndBase: NOOP,
    onMessagesTouchMoveBase: NOOP,
    onMessagesTouchStartBase: NOOP,
    onMessagesWheelBase: NOOP,
  });
  const handleComposerChange = (nextValue: string, nextCursor: number) => {
    setComposerValue(nextValue);
    setComposerCursor(nextCursor);
  };
  const handleTranscriptRender: ProfilerOnRenderCallback = () => {
    props.onTranscriptRender();
  };

  return (
    <div>
      <ChatPerformanceBoundary surface="composer">
        <ComposerPromptEditor
          value={composerValue}
          cursor={composerCursor}
          terminalContexts={[]}
          disabled={false}
          placeholder="Type composer text"
          onRemoveTerminalContext={NOOP}
          onChange={handleComposerChange}
          onPaste={NOOP}
        />
      </ChatPerformanceBoundary>
      <Profiler id="chat-transcript-pane" onRender={handleTranscriptRender}>
        <ChatPerformanceBoundary surface="transcript">
          <ChatTranscriptPane
            activeThreadId="thread-transcript-perf"
            activeTurnInProgress={false}
            activeTurnStartedAt={null}
            chatFontSizePx={15}
            emptyStateProjectName={undefined}
            expandedWorkGroups={EMPTY_WORK_GROUPS}
            hasMessages
            isWorking={false}
            listRef={listRef}
            markdownCwd={undefined}
            onExpandTimelineImage={NOOP}
            onMessagesClickCapture={onMessagesClickCapture}
            onMessagesMouseUp={onMessagesMouseUp}
            onMessagesPointerCancel={onMessagesPointerCancel}
            onMessagesPointerDown={onMessagesPointerDown}
            onMessagesPointerUp={onMessagesPointerUp}
            onMessagesScroll={onMessagesScroll}
            onMessagesTouchEnd={onMessagesTouchEnd}
            onMessagesTouchMove={onMessagesTouchMove}
            onMessagesTouchStart={onMessagesTouchStart}
            onMessagesWheel={onMessagesWheel}
            onIsAtEndChange={NOOP}
            onOpenThread={NOOP}
            onScrollToBottom={NOOP}
            onToggleWorkGroup={NOOP}
            resolvedTheme="dark"
            scrollButtonVisible={false}
            timelineEntries={TIMELINE_ENTRIES}
            timestampFormat="locale"
            workspaceRoot={undefined}
          />
        </ChatPerformanceBoundary>
      </Profiler>
    </div>
  );
}

describe("ChatTranscriptPane", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not re-render the transcript subtree when only composer text changes", async () => {
    resetChatPerformanceDiagnostics();
    enableChatPerformanceDiagnostics();
    let transcriptCommitCount = 0;

    const screen = await render(
      <TranscriptPerfHarness
        onTranscriptRender={() => {
          transcriptCommitCount += 1;
        }}
      />,
    );
    try {
      await vi.waitFor(() => {
        expect(transcriptCommitCount).toBeGreaterThan(0);
      });

      const baselineCommitCount = transcriptCommitCount;
      await page.getByTestId("composer-editor").click();
      await userEvent.keyboard("reply follow up");

      await vi.waitFor(() => {
        expect(page.getByTestId("composer-editor")).toHaveTextContent("reply follow up");
        expect(getChatPerformanceSummary().sampleCount).toBeGreaterThan(0);
      });

      expect(transcriptCommitCount).toBe(baselineCommitCount);
      expect(getChatPerformanceSummary().transcriptCommitCount).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("expands collapsed user messages from the Show more control", async () => {
    const hiddenTail = "TAIL_SHOULD_APPEAR_AFTER_EXPAND";
    // Well past the visual line clamp so the collapsed message measures as
    // overflowing regardless of viewport width.
    const longUserText = `${Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n")}\n${hiddenTail}`;
    const host = document.createElement("div");
    host.style.cssText = "display:flex;width:600px;height:520px;overflow:hidden;";
    document.body.append(host);

    const screen = await render(
      <ChatTranscriptPane
        activeThreadId="thread-user-message-expand"
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        chatFontSizePx={15}
        emptyStateProjectName={undefined}
        hasMessages
        isWorking={false}
        listRef={{ current: null }}
        markdownCwd={undefined}
        onExpandTimelineImage={NOOP}
        onMessagesClickCapture={NOOP}
        onMessagesMouseUp={NOOP}
        onMessagesPointerCancel={NOOP}
        onMessagesPointerDown={NOOP}
        onMessagesPointerUp={NOOP}
        onMessagesScroll={NOOP}
        onMessagesTouchEnd={NOOP}
        onMessagesTouchMove={NOOP}
        onMessagesTouchStart={NOOP}
        onMessagesWheel={NOOP}
        onIsAtEndChange={NOOP}
        onOpenThread={NOOP}
        onScrollToBottom={NOOP}
        resolvedTheme="dark"
        scrollButtonVisible={false}
        timelineEntries={[
          {
            id: "user-message-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("user-message-expand"),
              role: "user",
              text: longUserText,
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
      { container: host },
    );
    try {
      // Collapsing is a visual clamp: the tail stays in the DOM but the clamp
      // wrapper is overflowing (cut off) until the message is expanded.
      await vi.waitFor(() => {
        const clampWrapper = screen.container.querySelector('[data-user-message-clamp="true"]');
        expect(clampWrapper).not.toBeNull();
        expect(clampWrapper!.scrollHeight).toBeGreaterThan(clampWrapper!.clientHeight);
      });
      expect(screen.container.querySelector("button[data-scroll-anchor-ignore]")?.textContent).toBe(
        "Show more",
      );

      await page.getByText("Show more").click();

      await vi.waitFor(() => {
        const wrapper = screen.container.querySelector("[data-user-message-clamp]");
        expect(wrapper?.getAttribute("data-user-message-clamp")).toBe("false");
        expect(wrapper!.scrollHeight).toBeLessThanOrEqual(wrapper!.clientHeight + 1);
      });
      await expect.element(page.getByText("Show less")).toBeInTheDocument();
      expect(screen.container.querySelector("button[data-scroll-anchor-ignore]")?.textContent).toBe(
        "Show less",
      );
      await settleLayout();
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });
});
