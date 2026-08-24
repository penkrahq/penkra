// FILE: TranscriptVirtualList.tsx
// Purpose: Own dynamic transcript virtualization and end-anchored chat scrolling.
// Layer: Web chat infrastructure

import { measureElement as measureVirtualElement, useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import {
  areChatScrollDiagnosticsEnabled,
  nextChatScrollDiagnosticInstanceId,
  recordChatScrollDiagnostic,
} from "../../chatScrollDiagnostics";

export interface TranscriptVirtualListRef {
  scrollToEnd: (options?: { animated?: boolean }) => void;
  scrollToIndex: (options: { index: number; animated?: boolean; viewPosition?: number }) => void;
  getScrollableNode: () => HTMLDivElement | null;
  getState: () => { isAtEnd: boolean };
}

interface TranscriptVirtualListProps<TItem> extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  data: readonly TItem[];
  anchorRevision: string;
  estimatedItemSize: number;
  keyExtractor: (item: TItem) => string;
  renderItem: (item: TItem) => ReactNode;
  paddingEnd: number;
}

const END_THRESHOLD_PX = 80;
const OVERSCAN_ROWS = 6;

function alignFromViewPosition(viewPosition: number | undefined): "start" | "center" | "end" {
  if (viewPosition === undefined) return "center";
  if (viewPosition <= 0.25) return "start";
  if (viewPosition >= 0.75) return "end";
  return "center";
}

function TranscriptVirtualListInner<TItem>(
  {
    data,
    anchorRevision,
    estimatedItemSize,
    keyExtractor,
    renderItem,
    paddingEnd,
    onKeyDown,
    onPointerDown,
    onScroll,
    onTouchStart,
    onWheel,
    ...scrollProps
  }: TranscriptVirtualListProps<TItem>,
  ref: React.ForwardedRef<TranscriptVirtualListRef>,
) {
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const diagnosticInstanceIdRef = useRef<number | null>(null);
  diagnosticInstanceIdRef.current ??= nextChatScrollDiagnosticInstanceId();
  const getItemKey = useCallback(
    (index: number) => keyExtractor(data[index]!),
    [data, keyExtractor],
  );
  const previousAnchorRevisionRef = useRef(anchorRevision);
  const hasSemanticAppend = previousAnchorRevisionRef.current !== anchorRevision;
  const wasAtEndRef = useRef(true);
  const shouldEndAnchor = hasSemanticAppend && wasAtEndRef.current;
  const initialEndFollowRef = useRef(false);
  const initialEndFrameRef = useRef<number | null>(null);
  const initialEndFrameCountRef = useRef(0);
  const initialEndStableFramesRef = useRef(0);
  const scheduleInitialEndCorrectionRef = useRef<((source: string) => void) | null>(null);
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => estimatedItemSize,
    getItemKey,
    // Only real message-tail changes end-anchor. Tool/status rows preserve the
    // viewport even when their insertion changes the virtual row count.
    anchorTo: shouldEndAnchor ? "end" : "start",
    followOnAppend: false,
    scrollEndThreshold: END_THRESHOLD_PX,
    overscan: OVERSCAN_ROWS,
    paddingEnd,
    directDomUpdates: true,
    measureElement: (element, entry, instance) => {
      const size = measureVirtualElement(element, entry, instance);
      if (initialEndFollowRef.current) {
        initialEndStableFramesRef.current = 0;
        scheduleInitialEndCorrectionRef.current?.("row-measured");
      }
      recordChatScrollDiagnostic({
        instanceId: diagnosticInstanceIdRef.current!,
        event: "row-measured",
        dataCount: data.length,
        anchorRevision,
        element: scrollElementRef.current,
        detail: {
          index: Number(element.getAttribute("data-index")),
          size,
          source: entry ? "resize-observer" : "sync",
        },
      });
      return size;
    },
    // Streaming measurements can arrive while React is committing an
    // adjacent transcript update. TanStack supports ordinary scheduled
    // rerenders here; avoiding flushSync keeps that valid timing warning-free.
    useFlushSync: false,
    // Streaming Markdown can resize the measured tail again from inside the
    // observer delivery cycle. Frame-batching prevents Chromium's undelivered
    // ResizeObserver loop without adding a second scroll correction owner.
    useAnimationFrameWithResizeObserver: true,
  });

  const diagnosticTimeoutsRef = useRef<number[]>([]);
  const recordDiagnostic = useCallback(
    (event: string, detail?: Readonly<Record<string, unknown>>) => {
      recordChatScrollDiagnostic({
        instanceId: diagnosticInstanceIdRef.current!,
        event,
        dataCount: data.length,
        anchorRevision,
        element: scrollElementRef.current,
        virtualizer,
        ...(detail === undefined ? {} : { detail }),
      });
    },
    [anchorRevision, data.length, virtualizer],
  );
  const scheduleDiagnosticCheckpoints = useCallback(
    (source: string) => {
      if (!areChatScrollDiagnosticsEnabled()) return;
      window.requestAnimationFrame(() => {
        recordDiagnostic("scroll-checkpoint", { source, checkpoint: "next-frame" });
      });
      for (const delayMs of [80, 260, 1_000, 2_000]) {
        const timeoutId = window.setTimeout(() => {
          recordDiagnostic("scroll-checkpoint", { source, checkpoint: `${delayMs}ms` });
        }, delayMs);
        diagnosticTimeoutsRef.current.push(timeoutId);
      }
    },
    [recordDiagnostic],
  );
  useEffect(() => {
    return () => {
      if (initialEndFrameRef.current !== null) {
        window.cancelAnimationFrame(initialEndFrameRef.current);
        initialEndFrameRef.current = null;
      }
      for (const timeoutId of diagnosticTimeoutsRef.current) {
        window.clearTimeout(timeoutId);
      }
      diagnosticTimeoutsRef.current = [];
    };
  }, []);

  useLayoutEffect(() => {
    previousAnchorRevisionRef.current = anchorRevision;
  }, [anchorRevision]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: (options) => {
        recordDiagnostic("imperative-scroll-to-end:before", {
          animated: options?.animated ?? false,
        });
        virtualizer.scrollToEnd({ behavior: options?.animated ? "smooth" : "auto" });
        recordDiagnostic("imperative-scroll-to-end:after", {
          animated: options?.animated ?? false,
        });
        scheduleDiagnosticCheckpoints("imperative-scroll-to-end");
      },
      scrollToIndex: (options) => {
        virtualizer.scrollToIndex(options.index, {
          align: alignFromViewPosition(options.viewPosition),
          behavior: options.animated ? "smooth" : "auto",
        });
      },
      getScrollableNode: () => scrollElementRef.current,
      getState: () => ({ isAtEnd: virtualizer.isAtEnd(END_THRESHOLD_PX) }),
    }),
    [recordDiagnostic, scheduleDiagnosticCheckpoints, virtualizer],
  );

  const didInitialScrollRef = useRef(false);
  const cancelInitialEndFollow = useCallback(
    (source: string) => {
      if (!initialEndFollowRef.current) return;
      initialEndFollowRef.current = false;
      if (initialEndFrameRef.current !== null) {
        window.cancelAnimationFrame(initialEndFrameRef.current);
        initialEndFrameRef.current = null;
      }
      recordDiagnostic("initial-end-follow:cancelled", { source });
    },
    [recordDiagnostic],
  );
  const scheduleInitialEndCorrection = useCallback(
    (source: string) => {
      if (!initialEndFollowRef.current || initialEndFrameRef.current !== null) return;
      initialEndFrameRef.current = window.requestAnimationFrame(() => {
        initialEndFrameRef.current = null;
        if (!initialEndFollowRef.current) return;

        const element = scrollElementRef.current;
        if (!element) {
          cancelInitialEndFollow("scroll-element-missing");
          return;
        }

        initialEndFrameCountRef.current += 1;
        element.scrollTop = element.scrollHeight;

        const renderedTailIndex = virtualizer.getVirtualItems().at(-1)?.index ?? null;
        const distanceFromEnd = Math.max(
          0,
          element.scrollHeight - element.clientHeight - element.scrollTop,
        );
        const isSettledAtEnd =
          renderedTailIndex === data.length - 1 && distanceFromEnd <= Math.max(1, paddingEnd);
        initialEndStableFramesRef.current = isSettledAtEnd
          ? initialEndStableFramesRef.current + 1
          : 0;

        recordDiagnostic("initial-end-follow:correction", {
          source,
          frame: initialEndFrameCountRef.current,
          stableFrames: initialEndStableFramesRef.current,
          renderedTailIndex,
          distanceFromEnd,
        });

        if (initialEndStableFramesRef.current >= 2) {
          initialEndFollowRef.current = false;
          recordDiagnostic("initial-end-follow:settled", {
            frames: initialEndFrameCountRef.current,
          });
          scheduleDiagnosticCheckpoints("initial-end-follow-settled");
          return;
        }

        // This is a safety valve, not the settling strategy. Ordinary static
        // transcripts finish once the measured tail is stable for two frames.
        if (initialEndFrameCountRef.current >= 240) {
          cancelInitialEndFollow("frame-limit");
          return;
        }
        scheduleInitialEndCorrectionRef.current?.("converging");
      });
    },
    [
      cancelInitialEndFollow,
      data.length,
      paddingEnd,
      recordDiagnostic,
      scheduleDiagnosticCheckpoints,
      virtualizer,
    ],
  );
  scheduleInitialEndCorrectionRef.current = scheduleInitialEndCorrection;

  useLayoutEffect(() => {
    recordDiagnostic("data-committed", {
      hasSemanticAppend,
      shouldEndAnchor,
      wasAtEnd: wasAtEndRef.current,
    });
  }, [hasSemanticAppend, recordDiagnostic, shouldEndAnchor]);

  useLayoutEffect(() => {
    if (didInitialScrollRef.current || data.length === 0) return;
    didInitialScrollRef.current = true;
    // End placement owns the brief dynamic-measurement phase rather than
    // jumping once against estimates. Unlike TanStack's absolute scroll state,
    // this raw-DOM convergence is cancellable the instant a reader interacts.
    initialEndFollowRef.current = true;
    initialEndFrameCountRef.current = 0;
    initialEndStableFramesRef.current = 0;
    recordDiagnostic("initial-end-follow:started");
    scheduleInitialEndCorrection("initial-layout");
    return () => cancelInitialEndFollow("effect-cleanup");
  }, [cancelInitialEndFollow, data.length, recordDiagnostic, scheduleInitialEndCorrection]);

  const virtualItems = virtualizer.getVirtualItems();
  const containerStyle: CSSProperties = {
    position: "relative",
    width: "100%",
  };
  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const distanceFromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
      wasAtEndRef.current = distanceFromEnd <= END_THRESHOLD_PX;
      if (initialEndFollowRef.current && distanceFromEnd > END_THRESHOLD_PX) {
        cancelInitialEndFollow("scroll-away-from-end");
      }
      recordDiagnostic("dom-scroll", { wasAtEnd: wasAtEndRef.current });
      onScroll?.(event);
    },
    [cancelInitialEndFollow, onScroll, recordDiagnostic],
  );

  return (
    <div
      {...scrollProps}
      ref={scrollElementRef}
      onKeyDown={(event) => {
        cancelInitialEndFollow("keyboard");
        onKeyDown?.(event);
      }}
      onPointerDown={(event) => {
        cancelInitialEndFollow("pointer");
        onPointerDown?.(event);
      }}
      onScroll={handleScroll}
      onTouchStart={(event) => {
        cancelInitialEndFollow("touch");
        onTouchStart?.(event);
      }}
      onWheel={(event) => {
        cancelInitialEndFollow("wheel");
        onWheel?.(event);
      }}
    >
      <div ref={virtualizer.containerRef} style={containerStyle}>
        {virtualItems.map((virtualItem) => (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            style={{ position: "absolute", top: 0, left: 0, width: "100%" }}
          >
            {renderItem(data[virtualItem.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}

export const TranscriptVirtualList = forwardRef(TranscriptVirtualListInner) as <TItem>(
  props: TranscriptVirtualListProps<TItem> & {
    ref?: React.ForwardedRef<TranscriptVirtualListRef>;
  },
) => ReactNode;
