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
}

export function SpaceViewportShared({
  activePageIndex,
  children,
  className,
  onActivePageIndexChange,
  ...props
}: SpaceViewportSharedProps) {
  const { viewportRef } = useSpacePager({ activePageIndex, onActivePageIndexChange });

  return (
    <div
      aria-label="Spaces"
      aria-roledescription="carousel"
      className={cn(
        "flex min-h-0 w-60 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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
