// FILE: TranscriptVirtualList.tsx
// Purpose: Own dynamic transcript virtualization and end-anchored chat scrolling.
// Layer: Web chat infrastructure

import { useVirtualizer } from "@tanstack/react-virtual";
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
    onScroll,
    ...scrollProps
  }: TranscriptVirtualListProps<TItem>,
  ref: React.ForwardedRef<TranscriptVirtualListRef>,
) {
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const getItemKey = useCallback(
    (index: number) => keyExtractor(data[index]!),
    [data, keyExtractor],
  );
  const previousAnchorRevisionRef = useRef(anchorRevision);
  const hasSemanticAppend = previousAnchorRevisionRef.current !== anchorRevision;
  const wasAtEndRef = useRef(true);
  const shouldEndAnchor = hasSemanticAppend && wasAtEndRef.current;
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
    // Streaming measurements can arrive while React is committing an
    // adjacent transcript update. TanStack supports ordinary scheduled
    // rerenders here; avoiding flushSync keeps that valid timing warning-free.
    useFlushSync: false,
    // Streaming Markdown can resize the measured tail again from inside the
    // observer delivery cycle. Frame-batching prevents Chromium's undelivered
    // ResizeObserver loop without adding a second scroll correction owner.
    useAnimationFrameWithResizeObserver: true,
  });

  useLayoutEffect(() => {
    previousAnchorRevisionRef.current = anchorRevision;
  }, [anchorRevision]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: (options) => {
        virtualizer.scrollToEnd({ behavior: options?.animated ? "smooth" : "auto" });
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
    [virtualizer],
  );

  const didInitialScrollRef = useRef(false);
  useLayoutEffect(() => {
    if (didInitialScrollRef.current || data.length === 0) return;
    didInitialScrollRef.current = true;
    // TanStack's direct DOM mode may synchronously notify React while a layout
    // effect is committing. Move the initial imperative scroll to the next frame.
    const frameId = window.requestAnimationFrame(() => virtualizer.scrollToEnd());
    return () => window.cancelAnimationFrame(frameId);
  }, [data.length, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const containerStyle: CSSProperties = {
    position: "relative",
    width: "100%",
  };
  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      wasAtEndRef.current =
        element.scrollHeight - element.clientHeight - element.scrollTop <= END_THRESHOLD_PX;
      onScroll?.(event);
    },
    [onScroll],
  );

  return (
    <div {...scrollProps} ref={scrollElementRef} onScroll={handleScroll}>
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
