import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

const SCROLL_SETTLE_FALLBACK_MS = 140;

export interface SpaceViewportSharedProps
  extends Omit<ComponentProps<"div">, "children" | "onScroll"> {
  activePageIndex: number;
  children: ReactNode;
  onActivePageIndexChange: (pageIndex: number) => void;
  pageCount: number;
}

export function SpaceViewportShared({
  activePageIndex,
  children,
  className,
  onActivePageIndexChange,
  pageCount,
  ...props
}: SpaceViewportSharedProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const activePageIndexRef = useRef(activePageIndex);
  activePageIndexRef.current = activePageIndex;

  const settleActivePage = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || viewport.clientWidth === 0 || pageCount < 1) return;
    const pageIndex = Math.max(
      0,
      Math.min(pageCount - 1, Math.round(viewport.scrollLeft / viewport.clientWidth)),
    );
    if (pageIndex !== activePageIndexRef.current) {
      onActivePageIndexChange(pageIndex);
    }
  }, [onActivePageIndexChange, pageCount]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onScroll = () => {
      if (fallbackTimerRef.current !== null) {
        window.clearTimeout(fallbackTimerRef.current);
      }
      fallbackTimerRef.current = window.setTimeout(
        settleActivePage,
        SCROLL_SETTLE_FALLBACK_MS,
      );
    };
    const onScrollEnd = () => {
      if (fallbackTimerRef.current !== null) {
        window.clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      settleActivePage();
    };

    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("scrollend", onScrollEnd);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("scrollend", onScrollEnd);
      if (fallbackTimerRef.current !== null) {
        window.clearTimeout(fallbackTimerRef.current);
      }
    };
  }, [settleActivePage]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      viewport.scrollLeft = activePageIndexRef.current * viewport.clientWidth;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      aria-label="Spaces"
      aria-roledescription="carousel"
      className={cn(
        "flex min-h-0 w-60 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      data-pencil-component="yc0hr"
      data-slot="space-viewport"
      ref={viewportRef}
      role="group"
      {...props}
    >
      {children}
    </div>
  );
}
