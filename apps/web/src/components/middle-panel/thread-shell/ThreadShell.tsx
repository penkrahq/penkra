import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export function ThreadShell({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("relative flex min-h-0 min-w-0 flex-1 overflow-hidden", className)}
      data-pencil-component="X3cN0l"
      {...props}
    />
  );
}
