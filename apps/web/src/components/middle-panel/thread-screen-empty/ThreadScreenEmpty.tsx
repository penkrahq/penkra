import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export function ThreadScreenEmpty({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-1 items-center justify-center", className)}
      data-pencil-component="T0KEEB"
      {...props}
    />
  );
}
