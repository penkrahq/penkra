import type { HTMLAttributes, ReactNode } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

export interface AppGridProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function AppGrid({ children, className, ...props }: AppGridProps) {
  return (
    <div
      className={cn("h-[300px] w-[488px] min-h-0", className)}
      data-pencil-component="lHJt3"
      {...props}
    >
      <ScrollArea aria-label="Available apps" hideScrollbars scrollFade>
        <div className="flex flex-col gap-3 pb-1">{children}</div>
      </ScrollArea>
    </div>
  );
}
