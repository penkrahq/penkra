import type { ReactNode } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import { PanelTabs } from "../panel-tabs/PanelTabs";

export interface RightPanelSharedProps {
  children: ReactNode;
  className?: string;
}

export function RightPanelShared({ children, className }: RightPanelSharedProps) {
  return (
    <aside
      aria-label="Right panel"
      className={cn(
        "flex h-[900px] w-[420px] flex-col overflow-hidden bg-[var(--color-background-surface)]",
        className,
      )}
      data-pencil-component="ayA7J"
    >
      <PanelTabs />
      <ScrollArea aria-label="Panel content" className="min-h-0 flex-1" scrollFade>
        <div className="flex min-h-full flex-col items-center justify-center p-5">{children}</div>
      </ScrollArea>
    </aside>
  );
}
