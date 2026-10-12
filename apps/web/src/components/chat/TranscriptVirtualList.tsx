// FILE: TranscriptVirtualList.tsx
// Purpose: Own dynamic transcript virtualization and end-anchored chat scrolling.
// Layer: Web chat infrastructure

import {
  defaultRangeExtractor,
  elementScroll,
  measureElement as measureVirtualElement,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import {
  areChatScrollDiagnosticsEnabled,
  markChatScrollWrite,
  nextChatScrollDiagnosticInstanceId,
  readChatScrollWriteAttribution,
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
  /** Requests the next history page when the reader approaches the transcript start. */
  onNearStart?: () => void;
  /** In-memory identity used to restore a detached viewport after switching transcripts. */
  viewportMemoryKey?: string;
  /** Row key whose measured size should be observed (the live tail). */
  observedTailKey?: string | null;
  /** Called when the observed tail row's size changes; the caller decides follow. */
  onObservedTailResize?: () => void;
}

const END_THRESHOLD_PX = 80;
const START_PAGINATION_THRESHOLD_PX = 320;
const OVERSCAN_ROWS = 6;
const GEOMETRY_EPSILON_PX = 0.5;

function alignFromViewPosition(viewPosition: number | undefined): "start" | "center" | "end" {
  if (viewPosition === undefined) return "center";
  if (viewPosition <= 0.25) return "start";
  if (viewPosition >= 0.75) return "end";
  return "center";
}

function readMeasuredTailTarget(
  scrollElement: HTMLDivElement,
  tailKey: string | null,
  paddingEnd: number,
): { targetTop: number } | null {
  if (tailKey === null) return null;
  const tailElement = Array.from(
    scrollElement.querySelectorAll<HTMLElement>("[data-row-key]"),
  ).find((candidate) => candidate.getAttribute("data-row-key") === tailKey);
  if (!tailElement) return null;
  const viewportRect = scrollElement.getBoundingClientRect();
  const tailRect = tailElement.getBoundingClientRect();
  return {
    targetTop: scrollElement.scrollTop + tailRect.bottom - (viewportRect.bottom - paddingEnd),
  };
}

function TranscriptVirtualListInner<TItem>(
  {
    data,
    anchorRevision,
    estimatedItemSize,
    keyExtractor,
    renderItem,
    paddingEnd,
    onNearStart,
    viewportMemoryKey,
    observedTailKey,
    onObservedTailResize,
    onKeyDown,
    onPointerDown,
    onScroll,
    onTouchMove,
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
  if (diagnosticInstanceIdRef.current === null) {
    diagnosticInstanceIdRef.current = nextChatScrollDiagnosticInstanceId();
  }
  const previousDataKeysRef = useRef<readonly string[]>([]);
  const getItemKey = useCallback(
    (index: number) => keyExtractor(data[index]!),
    [data, keyExtractor],
  );
  const previousAnchorRevisionRef = useRef(anchorRevision);
  const hasSemanticAppend = previousAnchorRevisionRef.current !== anchorRevision;
  const wasAtEndRef = useRef(initialViewportSnapshotRef.current?.isAtEnd !== false);
  // Scroll ownership is semantic state, not a geometry heuristic. In
  // particular, a native smooth scroll can be interrupted by a thread switch
  // while its pixels are still far from the tail. Persisting those in-flight
  // pixels as a reader-authored anchor makes the next mount jump backwards.
  // Keep exactly one owner until explicit reader input or arrival at the real
  // tail transfers it.
  const scrollOwnerRef = useRef<"tail" | "reader">(
    initialViewportSnapshotRef.current?.isAtEnd === false ? "reader" : "tail",
  );
  const readerAnchorIndexRef = useRef<number | null>(
    (() => {
      const anchorKey = initialViewportSnapshotRef.current?.anchorKey;
      if (anchorKey === undefined) return null;
      const index = data.findIndex((item) => keyExtractor(item) === anchorKey);
      return index >= 0 ? index : null;
    })(),
  );
  const shouldEndAnchor = hasSemanticAppend && wasAtEndRef.current;
  const previousFirstKey = previousDataKeysRef.current.at(0);
  const hasLeadingPrepend =
    previousFirstKey !== undefined &&
    data.findIndex((item) => keyExtractor(item) === previousFirstKey) > 0;
  const virtualizerAnchorTo = hasLeadingPrepend ? "end" : "start";
  const initialEndFollowEligibleRef = useRef(initialViewportSnapshotRef.current?.isAtEnd !== false);
  const initialEndFollowRef = useRef(false);
  const initialEndFollowOwnedKeysRef = useRef<ReadonlySet<string>>(new Set());
  const initialEndFollowTailKeyRef = useRef<string | null>(null);
  const measuredSizeByKeyRef = useRef(new Map<string, number>());
  const endFollowAnchorRevisionRef = useRef<string | null>(null);
  const endFollowHadDataRef = useRef(false);
  const scheduleInitialEndCorrectionRef = useRef<((source: string) => void) | null>(null);
  const resolveMeasuredInitialPlacementRef = useRef<((source: string) => void) | null>(null);
  const initialAnchorRestoreActiveRef = useRef(
    initialViewportSnapshotRef.current?.isAtEnd === false,
  );
  const scheduleInitialAnchorRestoreRef = useRef<(() => void) | null>(null);
  const placementGenerationRef = useRef(0);
  const placementPendingRef = useRef(false);
  const correctPlacementRef = useRef<((source: string) => void) | null>(null);
  const schedulePlacement = useCallback((source: string) => {
    if (placementPendingRef.current) return;
    placementPendingRef.current = true;
    const generation = placementGenerationRef.current;
    // Measurement notifications precede Core's synchronous spacer/row writes.
    // Correct after those writes, coalescing notifications from the same commit.
    window.queueMicrotask(() => {
      if (generation !== placementGenerationRef.current) return;
      placementPendingRef.current = false;
      correctPlacementRef.current?.(source);
    });
  }, []);
  const virtualizer = useVirtualizer({
    onChange: () => {
      if (!initialPlacementResolvedRef.current) schedulePlacement("virtualizer-change");
    },
    count: data.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => estimatedItemSize,
    getItemKey,
    // While following, keep the causal tail mounted even if a large
    // above-viewport measurement temporarily makes the calculated range point
    // at an older region. The tail costs one extra row and gives the
    // ResizeObserver correction a stable DOM anchor; without it, the range can
    // paint that older region for one frame before end convergence remounts
    // the tail. Reader-owned ranges remain fully standard.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const tailIndex = data.length - 1;
      if (scrollOwnerRef.current === "tail" && tailIndex >= 0 && !indexes.includes(tailIndex)) {
        indexes.push(tailIndex);
      }
      return indexes;
    },
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
    // TanStack end anchoring and Penkra's causal-tail alignment cannot both own
    // an append. When a 90px estimate becomes a 37px working/status row, Core
    // first applies the -53px estimate correction and the causal-tail owner
    // then restores the real tail, exposing an up/down frame. Keep Core's end
    // anchor only for history prepends, where it preserves the existing keyed
    // reader row. Causal-tail alignment exclusively owns all tail appends and
    // measurements.
    anchorTo: virtualizerAnchorTo,
    followOnAppend: false,
    scrollEndThreshold: END_THRESHOLD_PX,
    overscan: OVERSCAN_ROWS,
    paddingEnd,
    directDomUpdates: true,
    // Virtual Core calculates an exact above-viewport measurement delta, but
    // its default element scroller writes scrollTop before the React adapter's
    // synchronous onChange grows the virtual spacer. A large first measure can
    // therefore be clamped against the old scrollHeight even though the core
    // eagerly records the unclamped target. Defer only adjustment writes to a
    // microtask: resizeItem completes its synchronous notify/direct-DOM update
    // first, then the browser receives the same exact offset against the new
    // geometry. Ordinary reader and imperative scrolls remain synchronous.
    scrollToFn: (offset, options, instance) => {
      const apply = () => {
        const element = scrollElementRef.current;
        const before = element?.scrollTop ?? null;
        elementScroll(offset, options, instance);
        markChatScrollWrite(element, {
          owner: "virtualizer:scroll-to-fn",
          requestedTop: offset + (options.adjustments ?? 0),
          beforeTop: before,
          afterTop: element?.scrollTop ?? null,
        });
        recordChatScrollDiagnostic({
          instanceId: diagnosticInstanceIdRef.current!,
          event: "virtual-scroll-write:applied",
          dataCount: data.length,
          anchorRevision,
          element,
          virtualizer: instance,
          detail: {
            offset,
            adjustments: options.adjustments ?? 0,
            behavior: options.behavior ?? null,
            before,
            after: element?.scrollTop ?? null,
          },
        });
      };
      if ((options.adjustments ?? 0) !== 0 && options.behavior === undefined) {
        recordChatScrollDiagnostic({
          instanceId: diagnosticInstanceIdRef.current!,
          event: "virtual-scroll-write:deferred",
          dataCount: data.length,
          anchorRevision,
          element: scrollElementRef.current,
          virtualizer: instance,
          detail: {
            offset,
            adjustments: options.adjustments,
          },
        });
        window.queueMicrotask(apply);
        return;
      }
      apply();
    },
    measureElement: (element, entry, instance) => {
      const measuredIndex = Number(element.getAttribute("data-index"));
      const measuredKey = element.getAttribute("data-row-key") ?? String(measuredIndex);
      const previousMeasuredSize = measuredSizeByKeyRef.current.get(measuredKey);
      const size = measureVirtualElement(element, entry, instance);
      const measuredSizeChanged =
        previousMeasuredSize === undefined ||
        Math.abs(previousMeasuredSize - size) > GEOMETRY_EPSILON_PX;
      measuredSizeByKeyRef.current.set(measuredKey, size);
      if (initialAnchorRestoreActiveRef.current) {
        scheduleInitialAnchorRestoreRef.current?.();
      }
      if (initialEndFollowRef.current) {
        // Tail ownership remains event-driven after the first correct reveal.
        // A real size change schedules exactly one correction; unchanged
        // ResizeObserver deliveries are not content growth. Rows appended
        // without a semantic transcript revision (tool/work chrome) are
        // outside this ownership generation and cannot pull the reader.
        if (
          initialEndFollowOwnedKeysRef.current.has(measuredKey) &&
          (!initialPlacementResolvedRef.current || measuredSizeChanged)
        ) {
          if (
            !initialPlacementResolvedRef.current &&
            entry === undefined &&
            measuredKey === initialEndFollowTailKeyRef.current
          ) {
            // Let the virtualizer finish its synchronous range/position update
            // before reading the tail rectangle. A commit-ref measurement can
            // otherwise observe the old absolute-row placement and produce a
            // clamped negative target.
            window.queueMicrotask(() => {
              resolveMeasuredInitialPlacementRef.current?.("tail-measured");
            });
          }
          if (initialPlacementResolvedRef.current) {
            // ResizeObserver delivery runs before paint. Once the true tail has
            // been revealed, preserve it in this same delivery so a late
            // Markdown/font/image resize cannot expose one intermediate frame.
            window.queueMicrotask(() => {
              if (
                !initialEndFollowRef.current ||
                !initialEndFollowEligibleRef.current ||
                !initialEndFollowOwnedKeysRef.current.has(measuredKey)
              ) {
                return;
              }
              const scrollElement = scrollElementRef.current;
              if (!scrollElement) return;
              // The virtualizer's synchronous resize/direct-DOM update has
              // completed by this microtask. Align against the real final-row
              // rectangle rather than scrollHeight, which may still include
              // estimates for unmeasured rows and can overshoot the causal
              // tail in either direction.
              const tailTarget = readMeasuredTailTarget(
                scrollElement,
                initialEndFollowTailKeyRef.current,
                paddingEnd,
              );
              if (!tailTarget) {
                scheduleInitialEndCorrectionRef.current?.("measured-tail-unmounted");
                return;
              }
              const beforeTop = scrollElement.scrollTop;
              const requestedTop = tailTarget.targetTop;
              scrollElement.scrollTop = requestedTop;
              markChatScrollWrite(scrollElement, {
                owner: "list:measured-tail-alignment",
                requestedTop,
                beforeTop,
                afterTop: scrollElement.scrollTop,
              });
              recordChatScrollDiagnostic({
                instanceId: diagnosticInstanceIdRef.current!,
                event: "scroll-write:measured-tail-alignment",
                dataCount: data.length,
                anchorRevision,
                element: scrollElement,
                virtualizer: instance,
                detail: {
                  measuredKey,
                  beforeTop,
                  requestedTop,
                  afterTop: scrollElement.scrollTop,
                },
              });
              if (
                instance.scrollOffset !== null &&
                Math.abs(instance.scrollOffset - scrollElement.scrollTop) > GEOMETRY_EPSILON_PX
              ) {
                scrollElement.dispatchEvent(new Event("scroll"));
              }
            });
          } else {
            scheduleInitialEndCorrectionRef.current?.("row-measured");
          }
        }
      }
      recordChatScrollDiagnostic({
        instanceId: diagnosticInstanceIdRef.current!,
        event: "row-measured",
        dataCount: data.length,
        anchorRevision,
        element: scrollElementRef.current,
        detail: {
          index: measuredIndex,
          key: measuredKey,
          size,
          previousSize: previousMeasuredSize ?? null,
          sizeChanged: measuredSizeChanged,
          source: entry ? "resize-observer" : "sync",
        },
      });
      return size;
    },
    // TanStack may notify synchronously from `measureElement`, which is itself
    // a React commit ref. Calling `flushSync` from that notification nests a
    // render inside React's lifecycle and is explicitly unsupported. Direct
    // DOM sizing/positioning still lands synchronously; range membership can
    // use React's ordinary queued render.
    useFlushSync: false,
    // Streaming Markdown can resize the measured tail again from inside the
    // observer delivery cycle. Frame-batching prevents Chromium's undelivered
    // ResizeObserver loop without adding a second scroll correction owner.
    useAnimationFrameWithResizeObserver: true,
  });
  // TanStack's default keeps the current top-side item stable when a row above
  // the viewport changes size. That is correct for a detached reader, but it
  // competes with our causal-tail alignment while following a live turn: one
  // writer preserves the old top anchor while another preserves the tail,
  // producing the recorded up/down oscillation. This callback is an instance
  // policy (not a hook option), so assign it synchronously on every render.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) =>
    scrollOwnerRef.current === "reader" &&
    readerAnchorIndexRef.current !== null &&
    item.index < readerAnchorIndexRef.current;
  // Observe the live tail row's measured size. Attaching from the row element
  // means mount/unmount (or the tail key changing) drives the observer, so a
  // tail row that is not yet rendered is still observed once it appears.
  const onObservedTailResizeRef = useRef(onObservedTailResize);
  onObservedTailResizeRef.current = onObservedTailResize;
  const tailResizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedTailSizeRef = useRef<number | null>(null);
  const setObservedTailRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      virtualizer.measureElement(node);
      tailResizeObserverRef.current?.disconnect();
      tailResizeObserverRef.current = null;
      observedTailSizeRef.current = null;
      if (!node) return;
      const observer = new ResizeObserver((entries) => {
        const height = entries[0]?.contentRect.height ?? null;
        if (height === null) return;
        const previous = observedTailSizeRef.current;
        observedTailSizeRef.current = height;
        // The first delivery reports the size at attach time; only a later
        // change is growth that the caller may need to react to.
        if (previous === null || Math.abs(height - previous) < GEOMETRY_EPSILON_PX) return;
        onObservedTailResizeRef.current?.();
      });
      observer.observe(node);
      tailResizeObserverRef.current = observer;
    },
    [virtualizer],
  );
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
  const recordDiagnosticRef = useRef(recordDiagnostic);
  recordDiagnosticRef.current = recordDiagnostic;
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
      if (scrollElement && scrollElement.scrollTop <= START_PAGINATION_THRESHOLD_PX) {
        onNearStart?.();
      }
      recordDiagnostic("initial-placement:revealed", {
        source,
        memoryKey: viewportMemoryKey ?? null,
      });
    },
    [onNearStart, recordDiagnostic, viewportMemoryKey],
  );
  const scheduleFrameDiagnosticCheckpoint = useCallback(
    (source: string) => {
      if (!areChatScrollDiagnosticsEnabled()) return;
      window.requestAnimationFrame(() => {
        recordDiagnostic("scroll-checkpoint", {
          source,
          checkpoint: "next-frame",
        });
      });
    },
    [recordDiagnostic],
  );
  const resolveMeasuredInitialPlacement = useCallback(
    (source: string) => {
      if (initialPlacementResolvedRef.current || !initialEndFollowRef.current) return;
      const element = scrollElementRef.current;
      const tailKey = initialEndFollowTailKeyRef.current;
      if (!element || tailKey === null || !measuredSizeByKeyRef.current.has(tailKey)) return;
      const renderedItems = virtualizer.getVirtualItems();
      if (renderedItems.some((item) => !measuredSizeByKeyRef.current.has(String(item.key)))) {
        return;
      }
      const tailTarget = readMeasuredTailTarget(element, tailKey, paddingEnd);
      if (!tailTarget) return;
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      if (
        tailTarget.targetTop < -GEOMETRY_EPSILON_PX ||
        tailTarget.targetTop > maxScrollTop + GEOMETRY_EPSILON_PX
      ) {
        return;
      }

      const beforeTop = element.scrollTop;
      element.scrollTop = tailTarget.targetTop;
      markChatScrollWrite(element, {
        owner: "list:initial-measured-tail",
        requestedTop: tailTarget.targetTop,
        beforeTop,
        afterTop: element.scrollTop,
      });
      if (
        virtualizer.scrollOffset !== null &&
        Math.abs(virtualizer.scrollOffset - element.scrollTop) > GEOMETRY_EPSILON_PX
      ) {
        element.dispatchEvent(new Event("scroll"));
      }

      const isTailVisible = isAtRenderedTail(Math.max(1, paddingEnd));
      recordDiagnostic("initial-end-follow:measured-tail", {
        source,
        isTailVisible,
        requestedTop: tailTarget.targetTop,
      });
      if (!isTailVisible) return;

      recordDiagnostic("initial-end-follow:tail-visible", {
        source,
      });
      resolveInitialPlacement("initial-end-follow-tail-visible");
      scheduleFrameDiagnosticCheckpoint("initial-end-follow-tail-visible");
    },
    [
      isAtRenderedTail,
      paddingEnd,
      recordDiagnostic,
      resolveInitialPlacement,
      scheduleFrameDiagnosticCheckpoint,
      virtualizer,
    ],
  );
  resolveMeasuredInitialPlacementRef.current = resolveMeasuredInitialPlacement;
  const captureViewport = useCallback(() => {
    if (!viewportMemoryKey) return;
    // React Strict Mode probes layout-effect cleanup before the initial
    // placement has restored its anchor. Persisting that transient
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
    const isAtEnd = scrollOwnerRef.current === "tail";
    const virtualItems = virtualizer.getVirtualItems();
    const anchor =
      virtualItems.find((item) => item.end > element.scrollTop + GEOMETRY_EPSILON_PX) ??
      virtualItems.at(0) ??
      null;
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
  }, [recordDiagnostic, viewportMemoryKey, virtualizer]);
  const captureViewportRef = useRef(captureViewport);
  captureViewportRef.current = captureViewport;
  useLayoutEffect(() => {
    // React detaches host refs before passive cleanup. Capture while the DOM
    // and the virtualizer's measured range are both still available.
    return () => captureViewportRef.current();
  }, []);
  useLayoutEffect(
    () => () => {
      placementGenerationRef.current += 1;
      placementPendingRef.current = false;
    },
    [],
  );

  useLayoutEffect(() => {
    previousAnchorRevisionRef.current = anchorRevision;
  }, [anchorRevision]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: (options) => {
        // Acquire tail ownership before starting the DOM motion. Cleanup may
        // run before a smooth scroll reaches its target, and must preserve the
        // requested destination rather than its transient pixel offset.
        scrollOwnerRef.current = "tail";
        wasAtEndRef.current = true;
        if (initialAnchorRestoreActiveRef.current) {
          initialAnchorRestoreActiveRef.current = false;
          initialEndFollowEligibleRef.current = true;
          initialEndFollowRef.current = true;
        }
        recordDiagnostic("imperative-scroll-to-end:before", {
          animated: options?.animated ?? false,
          initialPlacementResolved: initialPlacementResolvedRef.current,
          memoryKey: viewportMemoryKey ?? null,
        });
        const element = scrollElementRef.current;
        let beforeTop: number | null = null;
        let requestedTop: number | null = null;
        let afterTop: number | null = null;
        if (element) {
          // TanStack's scrollToEnd owns a target-reconciliation loop that can
          // outlive an upward wheel/touch gesture and snap the reader back for
          // up to five seconds. DOM scrolling has the ownership semantics a
          // chat needs: native input cancels smooth motion, and an auto write
          // has no latent target to replay after detachment.
          beforeTop = element.scrollTop;
          const currentTailKey = data.length > 0 ? keyExtractor(data[data.length - 1]!) : null;
          const tailTarget = readMeasuredTailTarget(element, currentTailKey, paddingEnd);
          const targetTop = tailTarget?.targetTop ?? element.scrollHeight;
          requestedTop = targetTop;
          element.scrollTo({
            top: targetTop,
            behavior: options?.animated ? "smooth" : "auto",
          });
          markChatScrollWrite(element, {
            owner: "list:imperative-scroll-to-end",
            requestedTop,
            beforeTop,
            afterTop: element.scrollTop,
          });
          afterTop = element.scrollTop;
          if (
            options?.animated !== true &&
            virtualizer.scrollOffset !== null &&
            Math.abs(virtualizer.scrollOffset - element.scrollTop) > GEOMETRY_EPSILON_PX
          ) {
            element.dispatchEvent(new Event("scroll"));
          }
        }
        recordDiagnostic("imperative-scroll-to-end:after", {
          animated: options?.animated ?? false,
          requestedTop,
          beforeTop,
          afterTop,
        });
        scheduleFrameDiagnosticCheckpoint("imperative-scroll-to-end");
      },
      scrollToIndex: (options) => {
        // Search/jump navigation is an explicit request to leave the tail.
        // Preserve that destination across a thread switch just like a reader
        // scroll, even if its smooth motion is interrupted.
        scrollOwnerRef.current = "reader";
        wasAtEndRef.current = false;
        readerAnchorIndexRef.current = options.index;
        virtualizer.scrollToIndex(options.index, {
          align: alignFromViewPosition(options.viewPosition),
          behavior: options.animated ? "smooth" : "auto",
        });
      },
      getScrollableNode: () => scrollElementRef.current,
      getState: () => ({
        // Transient virtual estimates must not advertise a reader-authored
        // scroll-away to the parent. Explicit reader input transfers this
        // ownership synchronously.
        isAtEnd: scrollOwnerRef.current === "tail",
      }),
    }),
    [
      data,
      keyExtractor,
      paddingEnd,
      recordDiagnostic,
      scheduleFrameDiagnosticCheckpoint,
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
      recordDiagnostic("initial-placement:cancelled", { source });
      resolveInitialPlacement(`cancelled:${source}`);
    },
    [recordDiagnostic, resolveInitialPlacement],
  );
  const correctInitialEnd = useCallback(
    (source: string) => {
      if (!initialEndFollowRef.current) return;
      const element = scrollElementRef.current;
      if (!element) {
        cancelInitialPlacement("scroll-element-missing");
        return;
      }

      const beforeTop = element.scrollTop;
      const tailTarget = readMeasuredTailTarget(
        element,
        initialEndFollowTailKeyRef.current,
        paddingEnd,
      );
      let requestedTop = element.scrollHeight;
      if (tailTarget) {
        // Use the same causal-tail target as ResizeObserver corrections.
        // `scrollHeight` also contains virtual padding and provisional
        // estimates; alternating between those two targets made the live
        // tail move by one row gap on successive paints.
        requestedTop = tailTarget.targetTop;
        element.scrollTop = requestedTop;
      } else {
        // The first estimated range may not contain the tail yet. Move to
        // the provisional end once so the virtualizer mounts it; the next
        // correction aligns the real tail rectangle before reveal.
        element.scrollTop = element.scrollHeight;
      }
      markChatScrollWrite(element, {
        owner: "list:initial-end-correction",
        requestedTop,
        beforeTop,
        afterTop: element.scrollTop,
      });
      if (
        virtualizer.scrollOffset !== null &&
        Math.abs(virtualizer.scrollOffset - element.scrollTop) > GEOMETRY_EPSILON_PX
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
      const isTailVisible = isAtRenderedTail(Math.max(1, paddingEnd));

      recordDiagnostic("initial-end-follow:correction", {
        source,
        isTailVisible,
        renderedTailIndex,
        distanceFromEnd,
        requestedTop,
      });

      if (isTailVisible) {
        // Visibility and follow ownership are separate. Reveal only after
        // the real final row is painted in the viewport, then retain
        // event-driven ownership so late row measurements keep a reader who
        // has not interacted pinned to that same causal tail.
        if (!initialPlacementResolvedRef.current) {
          recordDiagnostic("initial-end-follow:tail-visible", { source });
          resolveInitialPlacement("initial-end-follow-tail-visible");
          scheduleFrameDiagnosticCheckpoint("initial-end-follow-tail-visible");
        } else {
          recordDiagnostic("initial-end-follow:tail-maintained");
        }
        return;
      }
      // A fully measured, unchanged DOM range cannot produce another placement
      // event. Release hidden content rather than waiting for a nonexistent scroll.
      if (
        beforeTop === element.scrollTop &&
        virtualizer.scrollOffset === element.scrollTop &&
        tailTarget !== null &&
        virtualizer
          .getVirtualItems()
          .every((item) => measuredSizeByKeyRef.current.has(String(item.key)))
      ) {
        cancelInitialPlacement("measured-geometry-unchanged");
      }
    },
    [
      cancelInitialPlacement,
      isAtRenderedTail,
      paddingEnd,
      recordDiagnostic,
      resolveInitialPlacement,
      scheduleFrameDiagnosticCheckpoint,
      virtualizer,
    ],
  );
  const scheduleInitialEndCorrection = useCallback(
    (source: string) => {
      if (initialEndFollowRef.current) schedulePlacement(source);
    },
    [schedulePlacement],
  );
  scheduleInitialEndCorrectionRef.current = scheduleInitialEndCorrection;

  const correctInitialAnchor = useCallback(() => {
    if (!initialAnchorRestoreActiveRef.current) return;
    const snapshot = initialViewportSnapshotRef.current;
    const element = scrollElementRef.current;
    if (!snapshot || !element) {
      cancelInitialPlacement("restore-target-missing");
      return;
    }
    const targetIndex = data.findIndex((item) => keyExtractor(item) === snapshot.anchorKey);
    if (targetIndex < 0) {
      // Preserve the existing deleted-anchor behaviour: open at the tail.
      initialAnchorRestoreActiveRef.current = false;
      initialEndFollowEligibleRef.current = true;
      initialEndFollowRef.current = true;
      scheduleInitialEndCorrectionRef.current?.("restore-anchor-unavailable");
      recordDiagnostic("viewport-memory:anchor-unavailable", { anchorKey: snapshot.anchorKey });
      return;
    }
    const anchorElement = element.querySelector<HTMLElement>(`[data-index="${targetIndex}"]`);
    const offset = virtualizer.getOffsetForIndex(targetIndex, "start");
    // A mounted row already has a ResizeObserver delivery pending. Let Core
    // measure it before applying an offset inside it, which could unmount it.
    if (anchorElement && !measuredSizeByKeyRef.current.has(snapshot.anchorKey)) return;

    // Mount a missing anchor at its estimated start first. Applying the saved
    // offset before measuring a giant row could skip right past that row.
    const targetOffset = anchorElement
      ? Math.max(
          0,
          element.scrollTop +
            anchorElement.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            snapshot.anchorOffset,
        )
      : offset
        ? offset[0]
        : targetIndex * estimatedItemSize;
    const beforeTop = element.scrollTop;
    element.scrollTop = targetOffset;
    markChatScrollWrite(element, {
      owner: "list:anchor-restore-offset",
      requestedTop: targetOffset,
      beforeTop,
      afterTop: element.scrollTop,
    });
    if (
      virtualizer.scrollOffset !== null &&
      Math.abs(virtualizer.scrollOffset - element.scrollTop) > GEOMETRY_EPSILON_PX
    ) {
      element.dispatchEvent(new Event("scroll"));
    }
    recordDiagnostic("viewport-memory:restore-correction", {
      anchorKey: snapshot.anchorKey,
      targetIndex,
      targetOffset,
    });
    // Only a mounted, measured row can confirm the remembered DOM-relative
    // anchor. A new range or measurement drives the next correction otherwise.
    if (!anchorElement || !measuredSizeByKeyRef.current.has(snapshot.anchorKey)) return;
    const restoredOffset =
      anchorElement.getBoundingClientRect().top - element.getBoundingClientRect().top;
    if (Math.abs(restoredOffset - snapshot.anchorOffset) > GEOMETRY_EPSILON_PX) {
      if (
        beforeTop === element.scrollTop &&
        virtualizer.scrollOffset === element.scrollTop &&
        virtualizer
          .getVirtualItems()
          .every((item) => measuredSizeByKeyRef.current.has(String(item.key)))
      ) {
        cancelInitialPlacement("restore-geometry-unchanged");
      }
      return;
    }
    initialAnchorRestoreActiveRef.current = false;
    recordDiagnostic("viewport-memory:restored", { anchorKey: snapshot.anchorKey, targetIndex });
    resolveInitialPlacement("viewport-memory-restored");
  }, [
    cancelInitialPlacement,
    data,
    estimatedItemSize,
    keyExtractor,
    recordDiagnostic,
    resolveInitialPlacement,
    virtualizer,
  ]);
  const scheduleInitialAnchorRestore = useCallback(() => {
    if (initialAnchorRestoreActiveRef.current) schedulePlacement("anchor-measured");
  }, [schedulePlacement]);
  correctPlacementRef.current = (source) => {
    if (initialAnchorRestoreActiveRef.current) correctInitialAnchor();
    else correctInitialEnd(source);
  };
  scheduleInitialAnchorRestoreRef.current = scheduleInitialAnchorRestore;

  useLayoutEffect(() => {
    recordDiagnosticRef.current("initial-placement:mounted", {
      memoryKey: viewportMemoryKey ?? null,
      mode: initialAnchorRestoreActiveRef.current ? "restore-anchor" : "tail",
    });
  }, [viewportMemoryKey]);

  useLayoutEffect(() => {
    const previousKeys = previousDataKeysRef.current;
    const currentKeys = data.map((item) => keyExtractor(item));
    const previousFirstKey = previousKeys.at(0) ?? null;
    const preservedFirstIndex =
      previousFirstKey === null ? -1 : currentKeys.indexOf(previousFirstKey);
    recordDiagnostic("data-committed", {
      hasLeadingPrepend,
      shouldEndAnchor,
      wasAtEnd: wasAtEndRef.current,
      memoryKey: viewportMemoryKey ?? null,
      previousDataCount: previousKeys.length,
      currentDataCount: currentKeys.length,
      previousFirstKey,
      currentFirstKey: currentKeys.at(0) ?? null,
      previousLastKey: previousKeys.at(-1) ?? null,
      currentLastKey: currentKeys.at(-1) ?? null,
      preservedFirstIndex,
      prependedRowCount: preservedFirstIndex > 0 ? preservedFirstIndex : 0,
    });
    previousDataKeysRef.current = currentKeys;
  }, [data, hasLeadingPrepend, keyExtractor, recordDiagnostic, shouldEndAnchor, viewportMemoryKey]);

  useLayoutEffect(() => {
    if (!initialAnchorRestoreActiveRef.current || data.length === 0) return;
    recordDiagnostic("viewport-memory:restore-started", {
      anchorKey: initialViewportSnapshotRef.current?.anchorKey ?? null,
    });
    scheduleInitialAnchorRestore();
  }, [data.length, recordDiagnostic, scheduleInitialAnchorRestore]);

  const hasData = data.length > 0;
  useLayoutEffect(() => {
    const dataBecameNonEmpty = hasData && !endFollowHadDataRef.current;
    const semanticRevisionChanged =
      endFollowAnchorRevisionRef.current !== null &&
      endFollowAnchorRevisionRef.current !== anchorRevision;
    endFollowHadDataRef.current = hasData;
    endFollowAnchorRevisionRef.current = anchorRevision;
    if (!dataBecameNonEmpty && !semanticRevisionChanged) return;
    if (!hasData || !initialEndFollowEligibleRef.current) return;
    // End placement owns the brief dynamic-measurement phase rather than
    // jumping once against estimates. Unlike TanStack's absolute scroll state,
    // this raw-DOM convergence is cancellable the instant a reader interacts.
    const source = didInitialScrollRef.current ? "transcript-revision" : "initial-layout";
    didInitialScrollRef.current = true;
    initialEndFollowRef.current = true;
    const ownedKeys = data.map((item) => keyExtractor(item));
    initialEndFollowOwnedKeysRef.current = new Set(ownedKeys);
    initialEndFollowTailKeyRef.current = ownedKeys.at(-1) ?? null;
    recordDiagnostic("initial-end-follow:started", { source });
    scheduleInitialEndCorrection(source);
  }, [anchorRevision, data, hasData, keyExtractor, recordDiagnostic, scheduleInitialEndCorrection]);

  useLayoutEffect(() => {
    if (!initialPlacementResolvedRef.current) schedulePlacement("layout-committed");
  });

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
      if (distanceFromEnd <= END_THRESHOLD_PX) {
        scrollOwnerRef.current = "tail";
        readerAnchorIndexRef.current = null;
      } else if (scrollOwnerRef.current === "reader") {
        const viewportRect = element.getBoundingClientRect();
        const visibleAnchor = Array.from(
          element.querySelectorAll<HTMLElement>("[data-index]"),
        ).find((row) => {
          const rect = row.getBoundingClientRect();
          return (
            rect.bottom > viewportRect.top + GEOMETRY_EPSILON_PX &&
            rect.top < viewportRect.bottom - GEOMETRY_EPSILON_PX
          );
        });
        const index = Number(visibleAnchor?.dataset.index);
        const estimatedAnchorIndex = virtualizer.getVirtualItemForOffset(element.scrollTop)?.index;
        const virtualAnchor = Number.isInteger(index)
          ? virtualizer.getVirtualItems().find((item) => item.index === index)
          : undefined;
        // Core defers first measurements during user scrolling. Preserve the
        // semantic anchor while a mounted row still differs from Core's size.
        const hasUncommittedResize =
          visibleAnchor !== undefined &&
          virtualAnchor !== undefined &&
          Math.abs(visibleAnchor.getBoundingClientRect().height - virtualAnchor.size) >
            GEOMETRY_EPSILON_PX;
        readerAnchorIndexRef.current =
          Number.isInteger(index) && !hasUncommittedResize ? index : (estimatedAnchorIndex ?? null);
        recordDiagnostic("reader-anchor-captured", {
          domAnchorIndex: Number.isInteger(index) ? index : null,
          estimatedAnchorIndex: estimatedAnchorIndex ?? null,
          chosenAnchorIndex: readerAnchorIndexRef.current,
          hasUncommittedResize,
        });
      }
      // ResizeObserver and virtualizer corrections also emit scroll events.
      // They are not reader intent and may temporarily move geometry away from
      // the end while dynamic tail rows settle. Explicit input handlers below
      // revoke ownership before their resulting scroll event reaches here.
      wasAtEndRef.current = scrollOwnerRef.current === "tail";
      recordDiagnostic("dom-scroll", {
        wasAtEnd: wasAtEndRef.current,
        distanceFromEnd,
        isTrusted: event.nativeEvent.isTrusted,
        lastWriter: readChatScrollWriteAttribution(element)?.owner ?? "unattributed",
        readerAnchorIndex: readerAnchorIndexRef.current,
      });
      if (element.scrollTop <= START_PAGINATION_THRESHOLD_PX) {
        onNearStart?.();
      }
      onScroll?.(event);
    },
    [onNearStart, onScroll, recordDiagnostic, virtualizer],
  );

  useLayoutEffect(() => {
    if (!initialPlacementResolvedRef.current) return;
    const element = scrollElementRef.current;
    if (element && element.scrollTop <= START_PAGINATION_THRESHOLD_PX) {
      onNearStart?.();
    }
  }, [data.length, onNearStart]);

  return (
    <div
      {...scrollProps}
      ref={scrollElementRef}
      aria-busy={data.length > 0 && !initialPlacementResolvedRef.current ? true : undefined}
      data-initial-placement={initialPlacementResolvedRef.current ? "resolved" : "pending"}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
          scrollOwnerRef.current = "reader";
          wasAtEndRef.current = false;
        }
        cancelInitialPlacement("keyboard");
        onKeyDown?.(event);
      }}
      onPointerDown={(event) => {
        // A pointer directly on the scroll viewport can be a scrollbar drag.
        // Nested transcript interaction does not imply scroll ownership.
        if (event.target === event.currentTarget) {
          scrollOwnerRef.current = "reader";
          wasAtEndRef.current = false;
        }
        cancelInitialPlacement("pointer");
        onPointerDown?.(event);
      }}
      onScroll={handleScroll}
      onTouchStart={(event) => {
        cancelInitialPlacement("touch");
        onTouchStart?.(event);
      }}
      onTouchMove={(event) => {
        scrollOwnerRef.current = "reader";
        wasAtEndRef.current = false;
        onTouchMove?.(event);
      }}
      onWheel={(event) => {
        recordDiagnostic("reader-wheel", {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
        });
        if (event.deltaY < 0) {
          scrollOwnerRef.current = "reader";
          wasAtEndRef.current = false;
        }
        cancelInitialPlacement("wheel");
        onWheel?.(event);
      }}
    >
      <div ref={virtualizer.containerRef} style={containerStyle}>
        {virtualItems.map((virtualItem) => (
          <div
            key={virtualItem.key}
            ref={
              String(virtualItem.key) === observedTailKey
                ? setObservedTailRowRef
                : virtualizer.measureElement
            }
            data-index={virtualItem.index}
            data-row-key={String(virtualItem.key)}
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
