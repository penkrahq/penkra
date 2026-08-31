import "../../index.css";

import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  disableChatScrollDiagnostics,
  enableChatScrollDiagnostics,
  getChatScrollDiagnosticSamples,
  resetChatScrollDiagnostics,
} from "../../chatScrollDiagnostics";
import { TranscriptVirtualList, type TranscriptVirtualListRef } from "./TranscriptVirtualList";
import {
  readTranscriptViewportSnapshot,
  resetTranscriptViewportMemory,
} from "./transcriptViewportMemory";

interface TestRow {
  id: string;
  height: number;
}

function VirtualListHarness() {
  const [rows, setRows] = useState<TestRow[]>(() =>
    Array.from({ length: 60 }, (_, index) => ({ id: `row-${index}`, height: 32 })),
  );
  const listRef = useRef<TranscriptVirtualListRef | null>(null);
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          setRows((current) =>
            current.map((row, index) =>
              index === current.length - 1 ? { ...row, height: 220 } : row,
            ),
          )
        }
      >
        Grow tail
      </button>
      <button
        type="button"
        onClick={() =>
          setRows((current) => [...current, { id: `row-${current.length}`, height: 32 }])
        }
      >
        Append row
      </button>
      <TranscriptVirtualList
        ref={listRef}
        data={rows}
        anchorRevision={`${rows.length}:${rows.at(-1)?.id ?? "empty"}:${rows.at(-1)?.height ?? 0}`}
        estimatedItemSize={32}
        keyExtractor={(row) => row.id}
        renderItem={(row) => <div style={{ height: row.height }}>{row.id}</div>}
        paddingEnd={16}
        data-testid="virtual-scroll"
        style={{ height: 300, overflowY: "auto" }}
      />
    </div>
  );
}

function PrependingListHarness({ onNearStart }: { onNearStart?: () => void }) {
  const [firstIndex, setFirstIndex] = useState(0);
  const rows = Array.from({ length: 60 - firstIndex }, (_, index) => ({
    id: `prepend-row-${firstIndex + index}`,
    height: 40,
  }));
  return (
    <div>
      <button type="button" onClick={() => setFirstIndex((current) => Math.max(-20, current - 20))}>
        Prepend history
      </button>
      <TranscriptVirtualList
        data={rows}
        anchorRevision={`prepend-row-${rows.at(-1)?.id ?? "empty"}`}
        estimatedItemSize={40}
        keyExtractor={(row) => row.id}
        renderItem={(row) => (
          <div data-row-id={row.id} style={{ height: row.height }}>
            {row.id}
          </div>
        )}
        paddingEnd={16}
        {...(onNearStart === undefined ? {} : { onNearStart })}
        data-testid="prepend-virtual-scroll"
        style={{ height: 300, overflowY: "auto" }}
      />
    </div>
  );
}

function LongDynamicListHarness() {
  const rows = Array.from({ length: 193 }, (_, index) => ({
    id: `long-row-${index}`,
    height: index >= 178 ? 360 : 48,
  }));
  return (
    <TranscriptVirtualList
      data={rows}
      anchorRevision="193:long-row-192:settled"
      estimatedItemSize={90}
      keyExtractor={(row) => row.id}
      renderItem={(row) => <div style={{ height: row.height }}>{row.id}</div>}
      paddingEnd={16}
      data-testid="long-virtual-scroll"
      style={{ height: 300, overflowY: "auto" }}
    />
  );
}

function ProgressivelyHydratedLongListHarness() {
  const [rowCount, setRowCount] = useState(60);
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setRowCount(193), 80);
    return () => window.clearTimeout(timeoutId);
  }, []);
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    id: `hydrated-row-${index}`,
    height: index >= 178 ? 360 : 48,
  }));
  return (
    <TranscriptVirtualList
      data={rows}
      anchorRevision={`${rowCount}:hydrated-row-${rowCount - 1}:settled`}
      estimatedItemSize={90}
      keyExtractor={(row) => row.id}
      renderItem={(row) => <div style={{ height: row.height }}>{row.id}</div>}
      paddingEnd={16}
      data-testid="hydrated-virtual-scroll"
      style={{ height: 300, overflowY: "auto" }}
    />
  );
}

function SyntheticWorkRowHarness() {
  const [rows, setRows] = useState<TestRow[]>(() =>
    Array.from({ length: 60 }, (_, index) => ({ id: `message-row-${index}`, height: 32 })),
  );
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          setRows((current) => [
            ...current,
            { id: `synthetic-work-row-${current.length}`, height: 48 },
          ])
        }
      >
        Append work row
      </button>
      <TranscriptVirtualList
        data={rows}
        // Work/status rows do not advance the semantic transcript revision.
        anchorRevision="60:message-row-59:settled"
        estimatedItemSize={32}
        keyExtractor={(row) => row.id}
        renderItem={(row) => <div style={{ height: row.height }}>{row.id}</div>}
        paddingEnd={16}
        data-testid="synthetic-work-virtual-scroll"
        style={{ height: 300, overflowY: "auto" }}
      />
    </div>
  );
}

function HeterogeneousRemeasureListHarness() {
  const [expanded, setExpanded] = useState(false);
  const rows = Array.from({ length: 120 }, (_, index) => ({
    id: `remeasure-row-${index}`,
    height: index === 48 && expanded ? 304 : 48,
  }));
  return (
    <div>
      <button type="button" onClick={() => setExpanded(true)}>
        Settle offscreen Markdown
      </button>
      <TranscriptVirtualList
        data={rows}
        anchorRevision="120:remeasure-row-119:settled"
        estimatedItemSize={48}
        keyExtractor={(row) => row.id}
        renderItem={(row) => (
          <div data-row-id={row.id} style={{ height: row.height }}>
            {row.id}
          </div>
        )}
        paddingEnd={16}
        data-testid="remeasure-virtual-scroll"
        style={{ height: 300, overflowY: "auto" }}
      />
    </div>
  );
}

function LongChatFirstMeasureHarness() {
  const measuredHeights = new Map<number, number>([
    [27, 309],
    [28, 140],
    [29, 286],
    [30, 97],
    [31, 6_894],
    [32, 302],
  ]);
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: `first-measure-row-${index}`,
    height: measuredHeights.get(index) ?? 90,
  }));
  return (
    <TranscriptVirtualList
      data={rows}
      anchorRevision="40:first-measure-row-39:settled"
      estimatedItemSize={90}
      keyExtractor={(row) => row.id}
      renderItem={(row) => (
        <div data-row-id={row.id} style={{ height: row.height }}>
          {row.id}
        </div>
      )}
      paddingEnd={16}
      data-testid="first-measure-virtual-scroll"
      style={{ height: 300, overflowY: "auto" }}
    />
  );
}

function HeterogeneousTailPlacementHarness() {
  const tailHeights = new Map<number, number>([
    [226, 2_900],
    [229, 7_200],
    [232, 1_450],
    [235, 5_800],
    [238, 3_600],
  ]);
  const rows = Array.from({ length: 241 }, (_, index) => ({
    id: `heterogeneous-tail-row-${index}`,
    height: tailHeights.get(index) ?? 52,
  }));
  return (
    <TranscriptVirtualList
      data={rows}
      anchorRevision="241:heterogeneous-tail-row-240:settled"
      estimatedItemSize={90}
      keyExtractor={(row) => row.id}
      renderItem={(row) => (
        <div data-row-id={row.id} style={{ height: row.height }}>
          {row.id}
        </div>
      )}
      paddingEnd={16}
      data-testid="heterogeneous-tail-virtual-scroll"
      style={{ height: 300, overflowY: "auto" }}
    />
  );
}

function PlacementFeedbackRow({ id }: { id: string }) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(7_200);
  useLayoutEffect(() => {
    let animationFrameId = 0;
    let remainingChanges = 18;
    const tick = () => {
      if (remainingChanges <= 0) return;
      remainingChanges -= 1;
      setHeight((current) => (current === 7_200 ? 9_000 : 7_200));
      animationFrameId = requestAnimationFrame(tick);
    };
    animationFrameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrameId);
  }, []);
  return (
    <div ref={rowRef} data-row-id={id} style={{ height }}>
      {id}
    </div>
  );
}

function PlacementFeedbackHarness() {
  const rows = Array.from({ length: 9 }, (_, index) => ({
    id: `placement-feedback-row-${index}`,
    height: index === 7 ? 7_200 : 52,
  }));
  return (
    <TranscriptVirtualList
      data={rows}
      anchorRevision="9:placement-feedback-row-8:settled"
      estimatedItemSize={90}
      keyExtractor={(row) => row.id}
      renderItem={(row) =>
        row.id === "placement-feedback-row-7" ? (
          <PlacementFeedbackRow id={row.id} />
        ) : (
          <div data-row-id={row.id} style={{ height: row.height }}>
            {row.id}
          </div>
        )
      }
      paddingEnd={16}
      data-testid="placement-feedback-virtual-scroll"
      style={{ height: 300, overflowY: "auto" }}
    />
  );
}

function AnimationFrameSuspendedListHarness() {
  const rows = Array.from({ length: 120 }, (_, index) => ({
    id: `timer-row-${index}`,
    height: 48,
  }));
  return (
    <TranscriptVirtualList
      data={rows}
      anchorRevision="120:timer-row-119:settled"
      estimatedItemSize={48}
      keyExtractor={(row) => row.id}
      renderItem={(row) => <div style={{ height: row.height }}>{row.id}</div>}
      paddingEnd={16}
      data-testid="timer-virtual-scroll"
      style={{ height: 300, overflowY: "auto" }}
    />
  );
}

function ThreadSwitchingListHarness() {
  const [activeThread, setActiveThread] = useState<"thread-a" | "thread-b">("thread-a");
  const [threadARowCount, setThreadARowCount] = useState(120);
  const rowCount = activeThread === "thread-a" ? threadARowCount : 40;
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    id: `${activeThread}-row-${index}`,
    // A giant measured row exercises restoration from the middle of Markdown
    // content, where a raw row index without its pixel offset is insufficient.
    height: activeThread === "thread-a" && index === 1 ? 7_000 : 48,
  }));
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          setActiveThread((current) => (current === "thread-a" ? "thread-b" : "thread-a"))
        }
      >
        Switch thread
      </button>
      <button type="button" onClick={() => setThreadARowCount((current) => current + 4)}>
        Append to A
      </button>
      <TranscriptVirtualList
        key={activeThread}
        viewportMemoryKey={activeThread}
        data={rows}
        anchorRevision={`${rowCount}:${rows.at(-1)?.id ?? "empty"}:settled`}
        estimatedItemSize={48}
        keyExtractor={(row) => row.id}
        renderItem={(row) => (
          <div data-row-id={row.id} style={{ height: row.height }}>
            {row.id}
          </div>
        )}
        paddingEnd={16}
        data-testid="switching-virtual-scroll"
        style={{ height: 300, overflowY: "auto" }}
      />
    </div>
  );
}

function ProductionThreadsRegressionHarness() {
  const [activeThread, setActiveThread] = useState<"threads" | "other">("threads");
  const [activityCommit, setActivityCommit] = useState(0);
  const [lateTailHeight, setLateTailHeight] = useState(188);
  const rowCount = 40;
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    id: `${activeThread}-timeline-row-${index}`,
    // The production Threads page projects 245 messages and 2,870 activities
    // into 40 conversation rows. Its failed trace grew the committed tail by
    // 235px after a same-key activity-model commit.
    height:
      activeThread === "threads" && index === rowCount - 1
        ? lateTailHeight
        : index === 31
          ? 6_894
          : 114,
    activityCommit,
  }));
  return (
    <div>
      <button type="button" onClick={() => setActivityCommit((current) => current + 1)}>
        Commit projected activities
      </button>
      <button type="button" onClick={() => setLateTailHeight(423)}>
        Settle delayed tail content
      </button>
      <button
        type="button"
        onClick={() => setActiveThread((current) => (current === "threads" ? "other" : "threads"))}
      >
        Switch production thread
      </button>
      <TranscriptVirtualList
        key={activeThread}
        viewportMemoryKey={activeThread}
        data={rows}
        // Projected work/activity commits intentionally leave the semantic
        // transcript revision unchanged.
        anchorRevision={`${rowCount}:${activeThread}-timeline-row-39:settled`}
        estimatedItemSize={90}
        keyExtractor={(row) => row.id}
        renderItem={(row) => (
          <div
            data-row-id={row.id}
            data-activity-commit={row.activityCommit}
            style={{ height: row.height }}
          >
            {row.id}
          </div>
        )}
        paddingEnd={16}
        data-testid="production-threads-virtual-scroll"
        style={{ height: 1_058, overflowY: "auto" }}
      />
    </div>
  );
}

async function settleLayout(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function sampleAnimationFrameOffsets(
  scrollElement: HTMLElement,
  rowId: string,
  frameCount: number,
): Promise<number[]> {
  const offsets: number[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const row = scrollElement.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
    if (row) {
      offsets.push(row.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top);
    }
  }
  return offsets;
}

describe("TranscriptVirtualList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    disableChatScrollDiagnostics();
    resetChatScrollDiagnostics();
    resetTranscriptViewportMemory();
    document.body.innerHTML = "";
  });

  it("records initial placement, real geometry, and dynamic row measurements when enabled", async () => {
    enableChatScrollDiagnostics();
    const screen = await render(<VirtualListHarness />);
    try {
      await vi.waitFor(() => {
        const samples = getChatScrollDiagnosticSamples();
        expect(samples.some((sample) => sample.event === "row-measured")).toBe(true);
        const firstMeasuredRow = samples.find((sample) => sample.event === "row-measured");
        expect(firstMeasuredRow?.detail.index).toBeGreaterThan(0);
        expect(samples.some((sample) => sample.event === "initial-end-follow:tail-visible")).toBe(
          true,
        );
        expect(samples.some((sample) => sample.event === "initial-placement:revealed")).toBe(true);
        expect(
          samples.some(
            (sample) =>
              sample.event === "scroll-checkpoint" &&
              sample.detail.source === "initial-end-follow-tail-visible" &&
              sample.dom !== null &&
              sample.virtual !== null,
          ),
        ).toBe(true);
      });
      const samples = getChatScrollDiagnosticSamples();
      expect(
        samples.findIndex((sample) => sample.event === "initial-placement:revealed"),
      ).toBeGreaterThan(
        samples.findIndex((sample) => sample.event === "initial-end-follow:tail-visible"),
      );
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="virtual-scroll"]',
      )!;
      expect(scrollElement).not.toHaveAttribute("aria-busy");
      expect(scrollElement).toHaveAttribute("data-initial-placement", "resolved");
      expect(scrollElement.firstElementChild).toHaveStyle({ visibility: "visible" });
    } finally {
      await screen.unmount();
    }
  });

  it("converges on the measured end when tall tail rows invalidate initial estimates", async () => {
    const screen = await render(<LongDynamicListHarness />);
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="long-virtual-scroll"]',
      )!;
      await vi.waitFor(() => {
        expect(scrollElement.scrollTop).toBeGreaterThan(0);
        expect(
          scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop,
        ).toBeLessThanOrEqual(16);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("settles a long heterogeneous tail without re-entering a measurement scroll loop", async () => {
    enableChatScrollDiagnostics();
    const screen = await render(<HeterogeneousTailPlacementHarness />);
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="heterogeneous-tail-virtual-scroll"]',
      )!;
      await vi.waitFor(() => {
        expect(scrollElement.textContent).toContain("heterogeneous-tail-row-240");
        expect(
          getChatScrollDiagnosticSamples().some(
            (sample) => sample.event === "initial-end-follow:tail-visible",
          ),
        ).toBe(true);
      });

      resetChatScrollDiagnostics();
      const offsets: number[] = [];
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        offsets.push(scrollElement.scrollTop);
      }

      expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1);
      expect(scrollElement.textContent).toContain("heterogeneous-tail-row-240");
      expect(
        getChatScrollDiagnosticSamples().some(
          (sample) => sample.event === "initial-end-follow:correction",
        ),
      ).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("never exposes an intermediate range while measured tail geometry is still changing", async () => {
    const screen = await render(<PlacementFeedbackHarness />);
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="placement-feedback-virtual-scroll"]',
      )!;
      await vi.waitFor(
        () => {
          expect(scrollElement).toHaveAttribute("data-initial-placement", "resolved");
          expect(scrollElement.textContent).toContain("placement-feedback-row-8");
        },
        { timeout: 1_000, interval: 20 },
      );
      for (let frame = 0; frame < 18; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const tail = scrollElement.querySelector<HTMLElement>(
          '[data-row-id="placement-feedback-row-8"]',
        );
        expect(tail).not.toBeNull();
        const viewportRect = scrollElement.getBoundingClientRect();
        const tailRect = tail!.getBoundingClientRect();
        expect(tailRect.bottom).toBeGreaterThanOrEqual(viewportRect.top);
        expect(tailRect.bottom).toBeLessThanOrEqual(viewportRect.bottom + 16);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("re-enters end convergence when staged hydration expands a settled transcript", async () => {
    const screen = await render(<ProgressivelyHydratedLongListHarness />);
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="hydrated-virtual-scroll"]',
      )!;
      await vi.waitFor(() => {
        expect(scrollElement.textContent).toContain("hydrated-row-192");
        expect(
          scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop,
        ).toBeLessThanOrEqual(16);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not restart end convergence when only a synthetic work row is appended", async () => {
    enableChatScrollDiagnostics();
    const screen = await render(<SyntheticWorkRowHarness />);
    try {
      await vi.waitFor(() => {
        expect(
          getChatScrollDiagnosticSamples().some(
            (sample) => sample.event === "initial-end-follow:tail-visible",
          ),
        ).toBe(true);
      });
      resetChatScrollDiagnostics();

      await screen.getByText("Append work row").click();
      await settleLayout();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 80));

      const samples = getChatScrollDiagnosticSamples();
      expect(samples.some((sample) => sample.event === "data-committed")).toBe(true);
      expect(samples.some((sample) => sample.event === "initial-end-follow:started")).toBe(false);
      expect(samples.some((sample) => sample.event === "initial-end-follow:correction")).toBe(
        false,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("places the initial tail when animation frames are suspended", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const screen = await render(
      <StrictMode>
        <AnimationFrameSuspendedListHarness />
      </StrictMode>,
    );
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="timer-virtual-scroll"]',
      )!;
      await vi.waitFor(() => {
        expect(scrollElement.textContent).toContain("timer-row-119");
        expect(
          scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop,
        ).toBeLessThanOrEqual(16);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("cancels initial end convergence as soon as a reader gestures", async () => {
    const screen = await render(<LongDynamicListHarness />);
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="long-virtual-scroll"]',
      )!;
      scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      scrollElement.scrollTop = 0;
      await settleLayout();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
      expect(scrollElement.scrollTop).toBeLessThanOrEqual(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a pinned viewport at the end while the streaming tail grows", async () => {
    const screen = await render(<VirtualListHarness />);
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="virtual-scroll"]',
      )!;
      await vi.waitFor(() => {
        expect(scrollElement.scrollTop).toBeGreaterThan(0);
        expect(
          scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop,
        ).toBeLessThanOrEqual(80);
      });

      await screen.getByText("Grow tail").click();
      await vi.waitFor(() => {
        expect(
          scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop,
        ).toBeLessThanOrEqual(80);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not pull a reader at the top down when output is appended", async () => {
    const screen = await render(<VirtualListHarness />);
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="virtual-scroll"]',
      )!;
      await vi.waitFor(() => expect(scrollElement.scrollTop).toBeGreaterThan(0));
      scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      scrollElement.scrollTo({ top: 0, behavior: "instant" });
      await vi.waitFor(() => expect(scrollElement.scrollTop).toBeLessThanOrEqual(1));
      await settleLayout();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 150));

      await screen.getByText("Append row").click();
      await settleLayout();
      expect(scrollElement.scrollTop).toBeLessThanOrEqual(1);
    } finally {
      await screen.unmount();
    }
  });

  it("requests history near the top and preserves the visible keyed row after prepend", async () => {
    const onNearStart = vi.fn();
    const screen = await render(<PrependingListHarness onNearStart={onNearStart} />);
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="prepend-virtual-scroll"]',
      )!;
      await vi.waitFor(() => expect(scrollElement.scrollTop).toBeGreaterThan(0));
      scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
      scrollElement.scrollTop = 200;
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
      await vi.waitFor(() => expect(onNearStart).toHaveBeenCalled());

      let anchor: HTMLElement | null = null;
      await vi.waitFor(() => {
        anchor = scrollElement.querySelector<HTMLElement>('[data-row-id="prepend-row-5"]');
        expect(anchor).not.toBeNull();
      });
      const anchorOffset =
        anchor!.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top;

      await screen.getByText("Prepend history").click();
      await vi.waitFor(() => {
        const preservedAnchor = scrollElement.querySelector<HTMLElement>(
          '[data-row-id="prepend-row-5"]',
        );
        expect(preservedAnchor).not.toBeNull();
        expect(
          preservedAnchor!.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top,
        ).toBeCloseTo(anchorOffset, 0);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a visible semantic row stable while above-viewport Markdown rows remeasure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    enableChatScrollDiagnostics();
    const screen = await render(
      <StrictMode>
        <HeterogeneousRemeasureListHarness />
      </StrictMode>,
    );
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="remeasure-virtual-scroll"]',
      )!;
      await vi.waitFor(() => expect(scrollElement.scrollTop).toBeGreaterThan(0));

      // Measure the target region once at its compact size and record the
      // reader's semantic position inside row 52.
      scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
      scrollElement.scrollTop = 2_520;
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
      await settleLayout();
      await vi.waitFor(() => {
        expect(
          scrollElement.querySelector<HTMLElement>('[data-row-id="remeasure-row-52"]'),
        ).not.toBeNull();
      });
      const originalAnchor = scrollElement.querySelector<HTMLElement>(
        '[data-row-id="remeasure-row-52"]',
      )!;
      const originalAnchorOffset =
        originalAnchor.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top;

      // Unmount row 48 while retaining its 48px measurement, then let its
      // Markdown settle offscreen. It will be rediscovered at 304px while the
      // reader is scrolling backward—the exact path that used to skip the
      // virtualizer's scroll compensation.
      scrollElement.scrollTop = 3_500;
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
      await settleLayout();
      await vi.waitFor(() => {
        expect(
          scrollElement.querySelector<HTMLElement>('[data-row-id="remeasure-row-48"]'),
        ).toBeNull();
      });
      await screen.getByText("Settle offscreen Markdown").click();

      scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -980 }));
      scrollElement.scrollTop = 2_520;
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
      await settleLayout();
      await vi.waitFor(() => {
        expect(
          getChatScrollDiagnosticSamples().some(
            (sample) =>
              sample.event === "row-measured" &&
              sample.detail.index === 48 &&
              sample.detail.size === 304,
          ),
        ).toBe(true);
      });
      const frameOffsets = await sampleAnimationFrameOffsets(scrollElement, "remeasure-row-52", 8);

      expect(frameOffsets.length).toBeGreaterThan(0);
      expect(
        Math.max(...frameOffsets.map((offset) => Math.abs(offset - originalAnchorOffset))),
      ).toBeLessThanOrEqual(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("preserves the painted anchor when a backward scroll first measures a giant chat row", async () => {
    enableChatScrollDiagnostics();
    const screen = await render(<LongChatFirstMeasureHarness />);
    try {
      const scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="first-measure-virtual-scroll"]',
      )!;
      await vi.waitFor(() => {
        expect(scrollElement.scrollTop).toBeGreaterThan(0);
        expect(
          scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop,
        ).toBeLessThanOrEqual(16);
      });

      for (let step = 0; step < 4; step += 1) {
        const anchor = scrollElement.querySelector<HTMLElement>(
          '[data-row-id="first-measure-row-37"]',
        );
        expect(anchor).not.toBeNull();
        const before =
          anchor!.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top;
        scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -122 }));
        scrollElement.scrollBy({ top: -122, behavior: "instant" });
        await settleLayout();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
        const afterAnchor = scrollElement.querySelector<HTMLElement>(
          '[data-row-id="first-measure-row-37"]',
        );
        expect(afterAnchor).not.toBeNull();
        expect(
          afterAnchor!.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top,
        ).toBeCloseTo(before + 122, 0);
      }

      await vi.waitFor(() => {
        const samples = getChatScrollDiagnosticSamples();
        const deferred = samples.find(
          (sample) =>
            sample.event === "virtual-scroll-write:deferred" && sample.detail.adjustments === 6_804,
        );
        expect(deferred).toBeDefined();
        const applied = samples.find(
          (sample) =>
            sample.event === "virtual-scroll-write:applied" && sample.detail.adjustments === 6_804,
        );
        expect(applied).toBeDefined();
        expect(Number(applied!.detail.after) - Number(applied!.detail.before)).toBe(6_804);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("restores a detached row anchor after switching away while output continues", async () => {
    const screen = await render(
      <StrictMode>
        <ThreadSwitchingListHarness />
      </StrictMode>,
    );
    try {
      let scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="switching-virtual-scroll"]',
      )!;
      await vi.waitFor(() => expect(scrollElement.scrollTop).toBeGreaterThan(0));

      scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -600 }));
      scrollElement.scrollTop = 1_440;
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
      await vi.waitFor(() => expect(scrollElement.scrollTop).toBeCloseTo(1_440, 0));

      await screen.getByText("Switch thread").click();
      await vi.waitFor(() => {
        expect(readTranscriptViewportSnapshot("thread-a")?.isAtEnd).toBe(false);
      });
      const saved = readTranscriptViewportSnapshot("thread-a")!;

      // Model a live thread continuing to append while the reader is elsewhere.
      await screen.getByText("Append to A").click();
      await screen.getByText("Switch thread").click();
      await vi.waitFor(() => {
        scrollElement = screen.container.querySelector<HTMLElement>(
          '[data-testid="switching-virtual-scroll"]',
        )!;
        const anchor = scrollElement.querySelector<HTMLElement>(
          `[data-row-id="${saved.anchorKey}"]`,
        );
        expect(anchor).not.toBeNull();
        expect(
          anchor!.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top,
        ).toBeCloseTo(saved.anchorOffset, 0);
        expect(scrollElement.textContent).not.toContain("thread-a-row-123");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not turn delayed production-scale tail layout into reader detachment", async () => {
    enableChatScrollDiagnostics();
    const screen = await render(<ProductionThreadsRegressionHarness />);
    try {
      let scrollElement = screen.container.querySelector<HTMLElement>(
        '[data-testid="production-threads-virtual-scroll"]',
      )!;
      await vi.waitFor(() => {
        expect(
          scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop,
        ).toBeLessThanOrEqual(16);
      });

      // Reproduce the exact ordering from production: a same-key projected
      // activity commit releases initial tail ownership, then ResizeObserver
      // reports a 235px late expansion in the final conversation row.
      await screen.getByText("Commit projected activities").click();
      await settleLayout();
      await screen.getByText("Settle delayed tail content").click();
      await vi.waitFor(() => {
        expect(
          scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop,
        ).toBeLessThanOrEqual(16);
      });

      await screen.getByText("Switch production thread").click();
      await vi.waitFor(() => expect(readTranscriptViewportSnapshot("threads")?.isAtEnd).toBe(true));
      await screen.getByText("Switch production thread").click();
      await vi.waitFor(() => {
        scrollElement = screen.container.querySelector<HTMLElement>(
          '[data-testid="production-threads-virtual-scroll"]',
        )!;
        expect(
          scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop,
        ).toBeLessThanOrEqual(16);
      });
    } finally {
      await screen.unmount();
    }
  });
});
