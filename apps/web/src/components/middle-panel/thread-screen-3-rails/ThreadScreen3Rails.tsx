import type { HTMLAttributes, ReactNode } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import { ComposerDefault } from "../composer-default/ComposerDefault";
import { TopBarThread } from "../top-bar-thread/TopBarThread";

export interface ThreadScreen3RailsProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  composer?: ReactNode;
  /**
   * The production transcript and composer own their scrolling, focus, streaming,
   * and overlay behavior. Stories use the self-contained Pencil preview.
   */
  layoutMode?: "application" | "preview";
  title?: string;
}

export function ThreadScreen3Rails({
  children,
  className,
  composer = <ComposerDefault />,
  layoutMode = "preview",
  title,
  ...props
}: ThreadScreen3RailsProps) {
  if (layoutMode === "application") {
    return (
      <section
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface-under)]",
          className,
        )}
        data-pencil-component="y0DmC"
        {...props}
      >
        {children}
      </section>
    );
  }

  return (
    <section
      className={cn(
        "flex h-[900px] w-[780px] flex-col overflow-hidden bg-[var(--color-background-surface-under)]",
        className,
      )}
      data-pencil-component="y0DmC"
      {...props}
    >
      <TopBarThread {...(title === undefined ? {} : { title })} />
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
