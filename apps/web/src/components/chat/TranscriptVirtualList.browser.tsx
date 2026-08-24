import "../../index.css";

import { StrictMode, useEffect, useRef, useState } from "react";
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

async function settleLayout(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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
        expect(samples.some((sample) => sample.event === "initial-end-follow:settled")).toBe(true);
        expect(samples.some((sample) => sample.event === "initial-placement:revealed")).toBe(true);
        expect(
          samples.some(
            (sample) =>
              sample.event === "scroll-checkpoint" &&
              sample.detail.source === "initial-end-follow-settled" &&
              sample.dom !== null &&
              sample.virtual !== null,
          ),
        ).toBe(true);
      });
      const samples = getChatScrollDiagnosticSamples();
      expect(
        samples.findIndex((sample) => sample.event === "initial-placement:revealed"),
      ).toBeGreaterThan(
        samples.findIndex((sample) => sample.event === "initial-end-follow:settled"),
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
});
