import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { MessageActions } from "../message-actions/MessageActions";

export interface MessageUserProps {
  children: ReactNode;
  className?: string;
  layoutMode?: "application" | "preview";
  onCopy?: () => void;
  onEdit?: () => void;
  time?: string;
}

export function MessageUser({
  children,
  className,
  layoutMode = "preview",
  onCopy,
  onEdit,
  time,
}: MessageUserProps) {
  if (layoutMode === "application") {
    return (
      <div className={cn("contents", className)} data-pencil-component="BDWPr">
        {children}
      </div>
    );
  }

  return (
    <article
      className={cn("group/message flex w-full flex-col items-end", className)}
      data-pencil-component="BDWPr"
    >
      <div className="max-w-[80%] rounded-[14px] bg-[var(--color-background-user-message)] px-3.5 py-2.5 font-sans text-sm leading-normal text-[var(--color-text-foreground)]">
        {children}
      </div>
      <MessageActions onCopy={onCopy} onEdit={onEdit} time={time} />
    </article>
  );
}
