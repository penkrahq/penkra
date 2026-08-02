import type { ReactNode } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

export interface SidebarProjectsProps {
  children: ReactNode;
  className?: string;
}

export function SidebarProjects({ children, className }: SidebarProjectsProps) {
  return (
    <ScrollArea
      aria-label="Folders and threads"
      className={cn("min-h-0 w-60 flex-1", className)}
      data-pencil-component="mKbbW"
      hideScrollbars
      scrollFade
    >
      <div className="flex min-h-full w-full flex-col gap-3 p-2">{children}</div>
    </ScrollArea>
  );
}
