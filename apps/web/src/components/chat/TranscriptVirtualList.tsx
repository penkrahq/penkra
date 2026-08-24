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
import {
  readTranscriptViewportSnapshot,
  saveTranscriptViewportSnapshot,
  type TranscriptViewportSnapshot,
} from "./transcriptViewportMemory";

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
  /** In-memory identity used to restore a detached viewport after switching transcripts. */
  viewportMemoryKey?: string;
}

const END_THRESHOLD_PX = 80;
const OVERSCAN_ROWS = 6;
const INITIAL_END_CORRECTION_DELAY_MS = 16;

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
    viewportMemoryKey,
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
  const initialPlacementResolvedRef = useRef(false);
  const initialViewportSnapshotRef = useRef<TranscriptViewportSnapshot | null>(
    viewportMemoryKey ? (readTranscriptViewportSnapshot(viewportMemoryKey) ?? null) : null,
  );
  const diagnosticInstanceIdRef = useRef<number | null>(null);
  diagnosticInstanceIdRef.current ??= nextChatScrollDiagnosticInstanceId();
  const getItemKey = useCallback(
    (index: number) => keyExtractor(data[index]!),
    [data, keyExtractor],
  );
  const previousAnchorRevisionRef = useRef(anchorRevision);
  const hasSemanticAppend = previousAnchorRevisionRef.current !== anchorRevision;
  const wasAtEndRef = useRef(initialViewportSnapshotRef.current?.isAtEnd !== false);
  const shouldEndAnchor = hasSemanticAppend && wasAtEndRef.current;
  const initialEndFollowEligibleRef = useRef(initialViewportSnapshotRef.current?.isAtEnd !== false);
  const initialEndFollowRef = useRef(false);
  const initialEndTimerRef = useRef<number | null>(null);
  const initialEndFrameCountRef = useRef(0);
  const initialEndStableFramesRef = useRef(0);
  const scheduleInitialEndCorrectionRef = useRef<((source: string) => void) | null>(null);
  const initialAnchorRestoreActiveRef = useRef(
    initialViewportSnapshotRef.current?.isAtEnd === false,
  );
  const initialAnchorRestoreTimerRef = useRef<number | null>(null);
  const initialAnchorRestoreAttemptRef = useRef(0);
  const initialAnchorRestoreStableTicksRef = useRef(0);
  const initialAnchorRestoreLastTargetOffsetRef = useRef<number | null>(null);
  const scheduleInitialAnchorRestoreRef = useRef<(() => void) | null>(null);
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => estimatedItemSize,
    getItemKey,
    // A chat transcript is bottom-first. Seed the virtualizer near the final
    // row (or remembered detached anchor) before it chooses its first range;
    // starting at offset zero makes long threads traverse every estimated
    // range before the tail can be measured and revealed.
    initialOffset: () => {
      const snapshot = initialViewportSnapshotRef.current;
      if (snapshot?.isAtEnd === false) {
        const anchorIndex = data.findIndex((item) => keyExtractor(item) === snapshot.anchorKey);
        if (anchorIndex >= 0) {
          return Math.max(0, anchorIndex * estimatedItemSize - snapshot.anchorOffset);
        }
      }
      const viewportHeight = scrollElementRef.current?.clientHeight ?? 0;
      return Math.max(0, data.length * estimatedItemSize + paddingEnd - viewportHeight);
    },
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
      if (initialAnchorRestoreActiveRef.current) {
        initialAnchorRestoreStableTicksRef.current = 0;
        initialAnchorRestoreLastTargetOffsetRef.current = null;
        scheduleInitialAnchorRestoreRef.current?.();
      }
      if (initialEndFollowEligibleRef.current) {
        initialEndFollowRef.current = true;
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
  const isAtRenderedTail = useCallback(
    (threshold = END_THRESHOLD_PX) => {
      if (data.length === 0) return true;
      const element = scrollElementRef.current;
      const scrollOffset = virtualizer.scrollOffset;
      const renderedTail = virtualizer.getVirtualItems().at(-1);
      if (!element || scrollOffset === null || renderedTail?.index !== data.length - 1) {
        return false;
      }
      // TanStack's public isAtEnd uses the DOM spacer height. With highly
      // heterogeneous rows, unmeasured estimates can leave that spacer much
      // taller than the actual final row even while the final row is visible.
      // Follow the rendered causal tail, not estimated blank space below it.
      return (
        renderedTail.end >= scrollOffset - threshold &&
        renderedTail.end <= scrollOffset + element.clientHeight + threshold
      );
    },
    [data.length, virtualizer],
  );
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
  const resolveInitialPlacement = useCallback(
    (source: string) => {
      if (initialPlacementResolvedRef.current) return;
      initialPlacementResolvedRef.current = true;
      const scrollElement = scrollElementRef.current;
      const virtualContent = scrollElement?.firstElementChild;
      if (virtualContent instanceof HTMLElement) {
        virtualContent.style.visibility = "visible";
      }
      scrollElement?.removeAttribute("aria-busy");
      scrollElement?.setAttribute("data-initial-placement", "resolved");
      recordDiagnostic("initial-placement:revealed", {
        source,
        memoryKey: viewportMemoryKey ?? null,
      });
    },
    [recordDiagnostic, viewportMemoryKey],
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
  const captureViewport = useCallback(() => {
    if (!viewportMemoryKey) return;
    // React Strict Mode probes layout-effect cleanup before the initial
    // placement timers have restored their anchor. Persisting that transient
    // estimated viewport would overwrite the valid snapshot we are currently
    // trying to restore.
    if (!initialPlacementResolvedRef.current) {
      recordDiagnostic("viewport-memory:save-skipped", {
        memoryKey: viewportMemoryKey,
        reason: "initial-placement-pending",
      });
      return;
    }
    const element = scrollElementRef.current;
    if (!element) return;
    const distanceFromEnd = Math.max(
      0,
      element.scrollHeight - element.clientHeight - element.scrollTop,
    );
    const isAtEnd = initialEndFollowEligibleRef.current || isAtRenderedTail();
    const virtualItems = virtualizer.getVirtualItems();
    const anchor =
      virtualItems.find((item) => item.end > element.scrollTop + 0.5) ?? virtualItems.at(0) ?? null;
    if (!anchor) return;
    const anchorElement = element.querySelector<HTMLElement>(`[data-index="${anchor.index}"]`);
    const anchorOffset = anchorElement
      ? anchorElement.getBoundingClientRect().top - element.getBoundingClientRect().top
      : anchor.start - element.scrollTop;
    saveTranscriptViewportSnapshot(viewportMemoryKey, {
      anchorKey: String(anchor.key),
      anchorOffset,
      isAtEnd,
    });
    recordDiagnostic("viewport-memory:saved", {
      memoryKey: viewportMemoryKey,
      anchorKey: String(anchor.key),
      anchorOffset,
      isAtEnd,
    });
  }, [isAtRenderedTail, recordDiagnostic, viewportMemoryKey, virtualizer]);
  const captureViewportRef = useRef(captureViewport);
  captureViewportRef.current = captureViewport;
  useLayoutEffect(() => {
    // React detaches host refs before passive cleanup. Capture while the DOM
    // and the virtualizer's measured range are both still available.
    return () => captureViewportRef.current();
  }, []);
  useEffect(() => {
    return () => {
      if (initialEndTimerRef.current !== null) {
        window.clearTimeout(initialEndTimerRef.current);
        initialEndTimerRef.current = null;
      }
      if (initialAnchorRestoreTimerRef.current !== null) {
        window.clearTimeout(initialAnchorRestoreTimerRef.current);
        initialAnchorRestoreTimerRef.current = null;
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
          initialPlacementResolved: initialPlacementResolvedRef.current,
          memoryKey: viewportMemoryKey ?? null,
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
      getState: () => ({
        // While the list still owns initial end-follow, transient virtual
        // estimates must not advertise a reader-authored scroll-away to the
        // parent. Explicit reader input revokes this ownership synchronously.
        isAtEnd: initialEndFollowEligibleRef.current || isAtRenderedTail(),
      }),
    }),
    [
      isAtRenderedTail,
      recordDiagnostic,
      scheduleDiagnosticCheckpoints,
      viewportMemoryKey,
      virtualizer,
    ],
  );

  const didInitialScrollRef = useRef(false);
  const cancelInitialPlacement = useCallback(
    (source: string) => {
      if (!initialEndFollowEligibleRef.current && !initialAnchorRestoreActiveRef.current) {
        return;
      }
      initialEndFollowEligibleRef.current = false;
      initialEndFollowRef.current = false;
      initialAnchorRestoreActiveRef.current = false;
      if (initialEndTimerRef.current !== null) {
        window.clearTimeout(initialEndTimerRef.current);
        initialEndTimerRef.current = null;
      }
      if (initialAnchorRestoreTimerRef.current !== null) {
        window.clearTimeout(initialAnchorRestoreTimerRef.current);
        initialAnchorRestoreTimerRef.current = null;
      }
      recordDiagnostic("initial-placement:cancelled", { source });
      resolveInitialPlacement(`cancelled:${source}`);
    },
    [recordDiagnostic, resolveInitialPlacement],
  );
  const scheduleInitialEndCorrection = useCallback(
    (source: string) => {
      if (!initialEndFollowRef.current || initialEndTimerRef.current !== null) return;
      // requestAnimationFrame can be suspended while Electron transitions an
      // occluded/background renderer. End placement is correctness state, not
      // animation, so keep its cancellable convergence clock independent.
      initialEndTimerRef.current = window.setTimeout(() => {
        initialEndTimerRef.current = null;
        if (!initialEndFollowRef.current) return;

        const element = scrollElementRef.current;
        if (!element) {
          cancelInitialPlacement("scroll-element-missing");
          return;
        }

        initialEndFrameCountRef.current += 1;
        element.scrollTop = element.scrollHeight;
        if (
          virtualizer.scrollOffset !== null &&
          Math.abs(virtualizer.scrollOffset - element.scrollTop) > 0.5
        ) {
          // When another owner already placed the DOM at this exact offset,
          // Chromium emits no native scroll event for the same-value write.
          // Notify the virtualizer's registered observer so it ingests the
          // real offset and renders the corresponding range. Avoiding
          // virtualizer.scrollToEnd here is deliberate: that API starts its
          // own reconcile loop, which can outlive our reader-input cancel.
          element.dispatchEvent(new Event("scroll"));
        }

        const renderedTailIndex = virtualizer.getVirtualItems().at(-1)?.index ?? null;
        const distanceFromEnd = Math.max(
          0,
          element.scrollHeight - element.clientHeight - element.scrollTop,
        );
        const isSettledAtEnd = isAtRenderedTail(Math.max(1, paddingEnd));
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
          resolveInitialPlacement("initial-end-follow-settled");
          scheduleDiagnosticCheckpoints("initial-end-follow-settled");
          return;
        }

        // This is a safety valve, not the settling strategy. Ordinary static
        // transcripts finish once the measured tail is stable for two frames.
        if (initialEndFrameCountRef.current >= 240) {
          cancelInitialPlacement("frame-limit");
          return;
        }
        scheduleInitialEndCorrectionRef.current?.("converging");
      }, INITIAL_END_CORRECTION_DELAY_MS);
    },
    [
      cancelInitialPlacement,
      data.length,
      isAtRenderedTail,
      paddingEnd,
      recordDiagnostic,
      resolveInitialPlacement,
      scheduleDiagnosticCheckpoints,
      virtualizer,
    ],
  );
  scheduleInitialEndCorrectionRef.current = scheduleInitialEndCorrection;

  const scheduleInitialAnchorRestore = useCallback(() => {
    if (!initialAnchorRestoreActiveRef.current || initialAnchorRestoreTimerRef.current !== null) {
      return;
    }
    initialAnchorRestoreTimerRef.current = window.setTimeout(() => {
      initialAnchorRestoreTimerRef.current = null;
      if (!initialAnchorRestoreActiveRef.current) return;

      const snapshot = initialViewportSnapshotRef.current;
      const element = scrollElementRef.current;
      if (!snapshot || !element) {
        cancelInitialPlacement("restore-target-missing");
        return;
      }
      const targetIndex = data.findIndex((item) => keyExtractor(item) === snapshot.anchorKey);
      if (targetIndex < 0) {
        // A deleted/rolled-back anchor falls back to normal initial-tail placement.
        initialAnchorRestoreActiveRef.current = false;
        initialEndFollowEligibleRef.current = true;
        initialEndFollowRef.current = true;
        scheduleInitialEndCorrectionRef.current?.("restore-anchor-unavailable");
        recordDiagnostic("viewport-memory:anchor-unavailable", {
          anchorKey: snapshot.anchorKey,
        });
        return;
      }

      initialAnchorRestoreAttemptRef.current += 1;
      const virtualItem = virtualizer.getVirtualItems().find((item) => item.index === targetIndex);
      if (!virtualItem) {
        virtualizer.scrollToIndex(targetIndex, { align: "start", behavior: "auto" });
        initialAnchorRestoreStableTicksRef.current = 0;
        initialAnchorRestoreLastTargetOffsetRef.current = null;
      } else {
        const anchorElement = element.querySelector<HTMLElement>(`[data-index="${targetIndex}"]`);
        const currentAnchorOffset = anchorElement
          ? anchorElement.getBoundingClientRect().top - element.getBoundingClientRect().top
          : virtualItem.start - element.scrollTop;
        const targetOffset = Math.max(
          0,
          element.scrollTop + currentAnchorOffset - snapshot.anchorOffset,
        );
        element.scrollTop = targetOffset;
        if (
          virtualizer.scrollOffset !== null &&
          Math.abs(virtualizer.scrollOffset - element.scrollTop) > 0.5
        ) {
          element.dispatchEvent(new Event("scroll"));
        }
        const previousTargetOffset = initialAnchorRestoreLastTargetOffsetRef.current;
        const settled =
          Math.abs(element.scrollTop - targetOffset) <= 0.5 &&
          previousTargetOffset !== null &&
          Math.abs(previousTargetOffset - targetOffset) <= 0.5;
        initialAnchorRestoreLastTargetOffsetRef.current = targetOffset;
        initialAnchorRestoreStableTicksRef.current = settled
          ? initialAnchorRestoreStableTicksRef.current + 1
          : 0;
        recordDiagnostic("viewport-memory:restore-correction", {
          anchorKey: snapshot.anchorKey,
          targetIndex,
          targetOffset,
          attempt: initialAnchorRestoreAttemptRef.current,
          stableTicks: initialAnchorRestoreStableTicksRef.current,
        });
        if (initialAnchorRestoreStableTicksRef.current >= 2) {
          initialAnchorRestoreActiveRef.current = false;
          recordDiagnostic("viewport-memory:restored", {
            anchorKey: snapshot.anchorKey,
            targetIndex,
          });
          resolveInitialPlacement("viewport-memory-restored");
          return;
        }
      }

      if (initialAnchorRestoreAttemptRef.current >= 120) {
        cancelInitialPlacement("restore-attempt-limit");
        return;
      }
      scheduleInitialAnchorRestoreRef.current?.();
    }, INITIAL_END_CORRECTION_DELAY_MS);
  }, [
    cancelInitialPlacement,
    data,
    keyExtractor,
    recordDiagnostic,
    resolveInitialPlacement,
    virtualizer,
  ]);
  scheduleInitialAnchorRestoreRef.current = scheduleInitialAnchorRestore;

  useLayoutEffect(() => {
    recordDiagnostic("initial-placement:mounted", {
      memoryKey: viewportMemoryKey ?? null,
      mode: initialAnchorRestoreActiveRef.current ? "restore-anchor" : "tail",
    });
  }, [recordDiagnostic, viewportMemoryKey]);

  useLayoutEffect(() => {
    recordDiagnostic("data-committed", {
      hasSemanticAppend,
      shouldEndAnchor,
      wasAtEnd: wasAtEndRef.current,
      memoryKey: viewportMemoryKey ?? null,
    });
  }, [hasSemanticAppend, recordDiagnostic, shouldEndAnchor, viewportMemoryKey]);

  useLayoutEffect(() => {
    if (!initialAnchorRestoreActiveRef.current || data.length === 0) return;
    recordDiagnostic("viewport-memory:restore-started", {
      anchorKey: initialViewportSnapshotRef.current?.anchorKey ?? null,
    });
    scheduleInitialAnchorRestore();
  }, [data.length, recordDiagnostic, scheduleInitialAnchorRestore]);

  useLayoutEffect(() => {
    if (data.length === 0 || !initialEndFollowEligibleRef.current) return;
    // End placement owns the brief dynamic-measurement phase rather than
    // jumping once against estimates. Unlike TanStack's absolute scroll state,
    // this raw-DOM convergence is cancellable the instant a reader interacts.
    const source = didInitialScrollRef.current ? "transcript-revision" : "initial-layout";
    didInitialScrollRef.current = true;
    initialEndFollowRef.current = true;
    initialEndFrameCountRef.current = 0;
    initialEndStableFramesRef.current = 0;
    recordDiagnostic("initial-end-follow:started", { source });
    scheduleInitialEndCorrection(source);
  }, [anchorRevision, data.length, recordDiagnostic, scheduleInitialEndCorrection]);

  const virtualItems = virtualizer.getVirtualItems();
  const containerStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    // Dynamic rows must remain measurable while initial end/anchor placement
    // converges, but intermediate virtual ranges should never be painted. A
    // settled transcript therefore appears in its final position instead of
    // visibly travelling through estimated offsets.
    visibility: initialPlacementResolvedRef.current ? "visible" : "hidden",
  };
  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const distanceFromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
      // ResizeObserver and virtualizer corrections also emit scroll events.
      // They are not reader intent and may temporarily move geometry away from
      // the end while dynamic tail rows settle. Explicit input handlers below
      // revoke ownership before their resulting scroll event reaches here.
      wasAtEndRef.current = initialEndFollowEligibleRef.current || isAtRenderedTail();
      recordDiagnostic("dom-scroll", {
        wasAtEnd: wasAtEndRef.current,
        distanceFromEnd,
      });
      onScroll?.(event);
    },
    [isAtRenderedTail, onScroll, recordDiagnostic],
  );

  return (
    <div
      {...scrollProps}
      ref={scrollElementRef}
      aria-busy={data.length > 0 && !initialPlacementResolvedRef.current ? true : undefined}
      data-initial-placement={initialPlacementResolvedRef.current ? "resolved" : "pending"}
      onKeyDown={(event) => {
        cancelInitialPlacement("keyboard");
        onKeyDown?.(event);
      }}
      onPointerDown={(event) => {
        cancelInitialPlacement("pointer");
        onPointerDown?.(event);
      }}
      onScroll={handleScroll}
      onTouchStart={(event) => {
        cancelInitialPlacement("touch");
        onTouchStart?.(event);
      }}
      onWheel={(event) => {
        cancelInitialPlacement("wheel");
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
