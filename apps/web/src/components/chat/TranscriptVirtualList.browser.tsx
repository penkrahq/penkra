import "../../index.css";

import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TranscriptVirtualList, type TranscriptVirtualListRef } from "./TranscriptVirtualList";

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
        estimatedItemSize={32}
        followLiveOutput
        keyExtractor={(row) => row.id}
        renderItem={(row) => <div style={{ height: row.height }}>{row.id}</div>}
        paddingEnd={16}
        data-testid="virtual-scroll"
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
    document.body.innerHTML = "";
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
});
