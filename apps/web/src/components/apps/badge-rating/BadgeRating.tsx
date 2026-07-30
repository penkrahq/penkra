import { IconStarFilled } from "@tabler/icons-react";
import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export interface BadgeRatingProps extends HTMLAttributes<HTMLSpanElement> {
  value?: string;
}

export function BadgeRating({ className, value = "4.9", ...props }: BadgeRatingProps) {
  return (
    <span
      aria-label={`${value} out of 5 stars`}
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] leading-[13px] text-[var(--color-text-foreground-tertiary)]",
        className,
      )}
      data-pencil-component="gqhMw"
      {...props}
    >
      <IconStarFilled className="size-[11px] text-[#f5a623]" />
      {value}
    </span>
  );
}
