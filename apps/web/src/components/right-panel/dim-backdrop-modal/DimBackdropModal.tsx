import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export function DimBackdropModal({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("absolute inset-0 bg-black/60", className)}
      data-pencil-component="P8HGk"
      {...props}
    />
  );
}
