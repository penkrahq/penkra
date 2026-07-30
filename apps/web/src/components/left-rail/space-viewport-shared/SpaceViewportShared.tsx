import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { useSpacePager } from "./useSpacePager";

export interface SpaceViewportSharedProps extends Omit<
  ComponentProps<"div">,
  "children" | "onScroll"
> {
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
  const { trackRef, viewportRef } = useSpacePager({
    activePageIndex,
    onActivePageIndexChange,
    pageCount,
  });

  return (
    <div
      aria-label="Spaces"
      aria-roledescription="carousel"
      className={cn("min-h-0 w-60 flex-1 touch-pan-y overflow-hidden", className)}
      data-pencil-component="yc0hr"
      data-slot="space-viewport"
      ref={viewportRef}
      role="group"
      {...props}
    >
      <div
        className="flex h-full w-max will-change-transform"
        data-slot="space-track"
        ref={trackRef}
      >
        {children}
      </div>
    </div>
  );
}
