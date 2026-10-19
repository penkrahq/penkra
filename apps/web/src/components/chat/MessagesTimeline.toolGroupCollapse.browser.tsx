// FILE: MessagesTimeline.toolGroupCollapse.browser.tsx
// Purpose: Real transcript rows preserve summary identity and independent member layout.
import "../../index.css";
import { ThreadId, TurnId, type CleanCoreThreadItem } from "@penkra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createThreadItemsController,
  type ThreadItemsController,
  type ThreadItemsApi,
  type TurnItemsRange,
} from "../../useThreadItems";
import { EMPTY_THREAD_ITEMS_STATE, turnSegmentKey } from "../../threadItemsStore";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { MessagesTimeline } from "./MessagesTimeline";
import { threadItemsToTimelineEntries } from "./threadItemMappers";
import type { TranscriptVirtualListRef } from "./TranscriptVirtualList";

const turnId = TurnId.makeUnsafe("turn");
const detailKey = turnSegmentKey(turnId, 0);
const marker: CleanCoreThreadItem = {
  threadId: ThreadId.makeUnsafe("thread"),
  seq: 1,
  sourceId: "turn:turn",
  turnId,
  kind: "turn",
  status: "done",
  text: null,
  data: '{"startedAt":"2026-10-17T00:00:00.000Z","endedAt":"2026-10-17T00:05:00.000Z"}',
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:05:00.000Z",
};
const final: CleanCoreThreadItem = {
  ...marker,
  seq: 203,
  sourceId: "answer",
  kind: "text",
  text: "Finished.",
  data: null,
};
const segments = {
  turn: [
    {
      fromSeq: 0,
      toSeq: null,
      hasSteps: true,
      startedAt: marker.createdAt,
      endedAt: marker.updatedAt,
    },
  ],
};
const step = (seq: number): CleanCoreThreadItem => ({
  ...marker,
  seq,
  sourceId: "step-" + seq,
  kind: "tool",
  text: "git status",
  data: JSON.stringify({
    kind: "tool.completed",
    summary: "Ran command",
    payload: {
      itemType: "command_execution",
      title: "Ran command",
      data: { command: "git status" },
    },
  }),
});
function PagedTurn() {
  const [state, setState] = useState(EMPTY_THREAD_ITEMS_STATE);
  const [reads, setReads] = useState(0);
  const [anchorSample, setAnchorSample] = useState<{ key: string; top: number } | null>(null);
  const ref = useRef<TranscriptVirtualListRef | null>(null);
  const controller = useRef<ThreadItemsController | null>(null);
  useEffect(() => {
    const api: ThreadItemsApi = {
      listThreadItemsPage: async () => ({
        items: [marker],
        turns: { turn: marker },
        finals: { turn: final },
        segments,
        nextCursor: null,
      }),
      listTurnItems: async ({ beforeSeq }) => {
        setReads((n) => n + 1);
        const ceiling = beforeSeq ?? 202;
        const items = Array.from({ length: Math.min(50, ceiling - 2) }, (_, index) =>
          step(ceiling - index - 1),
        );
        return { items, nextCursor: items.length === 50 ? items.at(-1)!.seq : null };
      },
      subscribeThread: async () => {},
      unsubscribeThread: async () => {},
      onThreadChange: (listener) => {
        queueMicrotask(() => listener({ threadId: "thread" }));
        return () => {};
      },
    };
    const instance = createThreadItemsController(
      api,
      "thread",
      setState,
      (error) => {
        throw error;
      },
      () => {
        const scroll = ref.current?.getScrollableNode();
        const key = controller.current?.getState().details[detailKey]?.items[0]?.sourceId;
        const row = key ? scroll?.querySelector<HTMLElement>('[data-row-key="' + key + '"]') : null;
        if (scroll && row && key)
          setAnchorSample({
            key,
            top: row.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
          });
        ref.current?.preserveAnchorBelowBoundary("turn-boundary:" + detailKey);
      },
    );
    controller.current = instance;
    return () => {
      controller.current = null;
      instance.dispose();
    };
  }, []);
  const onExpanded = useCallback(
    (ranges: ReadonlyArray<TurnItemsRange>) => controller.current?.setExpandedTurns(ranges),
    [],
  );
  const onOlder = useCallback(() => {
    void controller.current?.loadOlderTurn(detailKey);
  }, []);
  const steps = state.details[detailKey]?.items ?? [];
  const loaded = steps.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", width: 700, height: 600 }}>
      <output data-testid="page-reads">{reads}</output>
      <output data-testid="loaded-steps">{loaded}</output>
      <output data-testid="anchor-sample">{JSON.stringify(anchorSample)}</output>
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        turns={{ turn: marker }}
        finals={{ turn: final }}
        segments={segments}
        details={{
          [detailKey]: {
            items: steps,
            nextCursor: state.details[detailKey]?.nextCursor ?? null,
            loaded: loaded > 0,
          },
        }}
        timelineEntries={threadItemsToTimelineEntries([...steps, final])}
        onExpandedTurnsChange={onExpanded}
        onLoadOlderTurn={onOlder}
        listRef={ref}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}
function button(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((node) =>
    (node.textContent ?? "").includes(text),
  );
}
describe("independent transcript summary rows", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });
  it("keeps a steer between two independently expandable work segments", async () => {
    await page.viewport(900, 800);
    const steer: CleanCoreThreadItem = {
      ...marker,
      seq: 4,
      sourceId: "steer",
      kind: "user",
      status: "sent",
      text: "Focus on the tests next.",
      data: JSON.stringify({
        origin: { _tag: "agent", senderThreadId: "service" },
        attachments: [],
        steered: true,
      }),
    };
    const answer = { ...final, seq: 7, text: "Both parts are complete." };
    const before = step(2);
    const after = step(5);
    const parts = [
      {
        fromSeq: 0,
        toSeq: 4,
        hasSteps: true,
        startedAt: marker.createdAt,
        endedAt: "2026-10-17T00:00:30.000Z",
      },
      {
        fromSeq: 4,
        toSeq: null,
        hasSteps: true,
        startedAt: "2026-10-17T00:00:30.000Z",
        endedAt: "2026-10-17T00:01:15.000Z",
      },
    ];
    const screen = await render(
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 700,
          height: 600,
        }}
      >
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          turns={{ turn: marker }}
          finals={{ turn: answer }}
          segments={{ turn: parts }}
          details={{
            [turnSegmentKey(turnId, 0, 4)]: { items: [before], nextCursor: null, loaded: true },
            [turnSegmentKey(turnId, 4)]: { items: [after], nextCursor: null, loaded: true },
          }}
          timelineEntries={threadItemsToTimelineEntries([marker, before, steer, after, answer])}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>,
    );
    try {
      await expect
        .poll(
          () => screen.container.querySelectorAll('[data-timeline-row-kind="turn-header"]').length,
        )
        .toBe(2);
      const headers = Array.from(
        screen.container.querySelectorAll<HTMLElement>('[data-timeline-row-kind="turn-header"]'),
      );
      const message = screen.container.querySelector<HTMLElement>('[data-message-id="steer"]')!;
      expect(headers[0]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        message.getBoundingClientRect().top,
      );
      expect(message.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        headers[1]!.getBoundingClientRect().top,
      );
      expect(message.textContent).toContain("Steered by agent");
      expect(button(screen.container, "Worked for 30s")).toBeDefined();
      button(screen.container, "Worked for 45s")!.click();
      await expect
        .poll(() => screen.container.querySelectorAll('[data-timeline-row-kind="work"]').length)
        .toBe(1);
      expect(headers[0]!.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
      await page.screenshot({
        element: screen.container,
        path: "../../../../../.penkra/scratch/stream-steer-regressions/steer-segments.png",
      });
    } finally {
      await screen.unmount();
    }
  });
  it("preserves the settled header typography and divider before the answer", async () => {
    const screen = await render(<PagedTurn />);
    try {
      await expect.poll(() => button(screen.container, "Worked for") !== undefined).toBe(true);
      const header = button(screen.container, "Worked for")!;
      expect(header.style.fontSize).not.toBe("");
      const divider = () =>
        screen.container.querySelector('[data-timeline-row-kind="turn-divider"]');
      expect(divider()).not.toBeNull();
      await page.screenshot({
        element: screen.container,
        path: "../../../../../.penkra/scratch/p4-render-boundary/settled-header-closed.png",
      });
      header.click();
      await expect.poll(() => button(screen.container, "Ran 50 commands") !== undefined).toBe(true);
      const summary = screen.container.querySelector('[data-timeline-row-kind="summary"]')!;
      expect(
        summary.compareDocumentPosition(divider()!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      const answer = screen.container.querySelector('[data-message-id="answer"]')!;
      expect(
        divider()!.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      await page.screenshot({
        element: screen.container,
        path: "../../../../../.penkra/scratch/p4-render-boundary/settled-header-expanded.png",
      });
    } finally {
      await screen.unmount();
    }
  });
  it("loads one details page on expansion and mounts summary members as sibling list rows", async () => {
    const screen = await render(<PagedTurn />);
    try {
      await expect.poll(() => button(screen.container, "Worked for") !== undefined).toBe(true);
      button(screen.container, "Worked for")!.click();
      await expect
        .poll(() => screen.container.querySelector('[data-testid="page-reads"]')?.textContent)
        .toBe("1");
      await expect.poll(() => button(screen.container, "Ran 50 commands") !== undefined).toBe(true);
      const summary = button(screen.container, "Ran 50 commands")!;
      expect(summary.getAttribute("aria-expanded")).toBe("false");
      expect(screen.container.querySelectorAll('[data-timeline-row-kind="work"]')).toHaveLength(0);
      summary.click();
      await expect
        .poll(() => screen.container.querySelectorAll('[data-timeline-row-kind="work"]').length)
        .toBeGreaterThan(0);
      const member = screen.container.querySelector('[data-timeline-row-kind="work"]')!;
      expect(member.closest('[data-timeline-row-kind="summary"]')).toBeNull();
      await expect
        .poll(
          () =>
            button(screen.container, "Ran 100 commands") !== undefined ||
            button(screen.container, "Ran 50 commands") !== undefined,
        )
        .toBe(true);
      const scroll = screen.container.querySelector<HTMLElement>(
        '[data-chat-scroll-container="true"]',
      );
      expect(scroll).not.toBeNull();
      for (const expected of [100, 150, 200]) {
        const loaded = Number(
          screen.container.querySelector('[data-testid="loaded-steps"]')?.textContent,
        );
        if (loaded < expected) {
          scroll!.scrollTop = 0;
          scroll!.dispatchEvent(new Event("scroll"));
        }
        await expect
          .poll(() =>
            Number(screen.container.querySelector('[data-testid="loaded-steps"]')?.textContent),
          )
          .toBe(expected);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(
          Number(screen.container.querySelector('[data-testid="page-reads"]')?.textContent),
        ).toBe(expected / 50);
        const sample = JSON.parse(
          screen.container.querySelector('[data-testid="anchor-sample"]')!.textContent!,
        ) as { key: string; top: number };
        await expect
          .poll(() => {
            const row = scroll!.querySelector<HTMLElement>('[data-row-key="' + sample.key + '"]');
            return row
              ? row.getBoundingClientRect().top - scroll!.getBoundingClientRect().top
              : null;
          })
          .toBeCloseTo(sample.top, 0);
      }
      await page.screenshot({
        element: screen.container,
        path: "../../../../../.penkra/scratch/p4-render-boundary/flat-summary.png",
      });
    } finally {
      await page.screenshot({
        element: screen.container,
        path: "../../../../../.penkra/scratch/p4-render-boundary/flat-summary.png",
      });
      await screen.unmount();
    }
  });
});
