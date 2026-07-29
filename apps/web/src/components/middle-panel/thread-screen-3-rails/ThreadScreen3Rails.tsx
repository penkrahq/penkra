import type { ReactNode } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import { ComposerDefault } from "../composer-default/ComposerDefault";
import { TopBarThread } from "../top-bar-thread/TopBarThread";

export interface ThreadScreen3RailsProps {
  children: ReactNode;
  className?: string;
  composer?: ReactNode;
  title?: string;
}

export function ThreadScreen3Rails({
  children,
  className,
  composer = <ComposerDefault />,
  title,
}: ThreadScreen3RailsProps) {
  return (
    <section
      className={cn(
        "flex h-[900px] w-[780px] flex-col overflow-hidden bg-[var(--color-background-surface-under)]",
        className,
      )}
      data-pencil-component="y0DmC"
    >
      <TopBarThread title={title} />
      <ScrollArea
        aria-label="Conversation"
        className="min-h-0 w-[760px] flex-1 self-center"
        data-pencil-region="PGsVQ"
        hideScrollbars
        scrollFade
      >
        <div className="mx-auto flex w-[560px] flex-col gap-2 py-6">{children}</div>
      </ScrollArea>
      <div className="w-[760px] shrink-0 self-center px-6 pb-6">
        <div className="mx-auto w-[560px]">{composer}</div>
      </div>
    </section>
  );
}
