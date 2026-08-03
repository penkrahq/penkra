import { IconChevronRight } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { MessageActions } from "../message-actions/MessageActions";

export interface MessageAssistantProps {
  children: ReactNode;
  className?: string;
  layoutMode?: "application" | "preview";
  onCopy?: () => void;
  onRetry?: () => void;
  time?: string;
  workedFor?: string | null;
}

export function MessageAssistant({
  children,
  className,
  layoutMode = "preview",
  onCopy,
  onRetry,
  time,
  workedFor = "Worked for 1m 14s",
}: MessageAssistantProps) {
  if (layoutMode === "application") {
    return (
      <article
        className={cn("group/message flex w-full min-w-0 flex-col items-stretch", className)}
        data-pencil-component="kUqNe"
      >
        {children}
      </article>
    );
  }

  return (
    <article
      className={cn("group/message flex w-full flex-col items-start", className)}
      data-pencil-component="kUqNe"
    >
      {workedFor ? (
        <button
          className="mb-0.5 inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-sans text-[length:var(--app-font-size-ui-lg,13px)] text-[var(--color-text-foreground-tertiary)] outline-none hover:text-[var(--color-text-foreground-secondary)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
          type="button"
        >
          {workedFor}
          <IconChevronRight className="size-3" />
        </button>
      ) : null}
      <div className="max-w-full font-sans text-[length:calc(var(--app-font-size-base,12px)*1.1667)] leading-normal text-[var(--color-text-foreground)]">
        {children}
      </div>
      <MessageActions
        assistant
        {...(onCopy === undefined ? {} : { onCopy })}
        {...(onRetry === undefined ? {} : { onRetry })}
        {...(time === undefined ? {} : { time })}
      />
    </article>
  );
}
