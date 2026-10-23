// FILE: ComposerSavedPrompts.tsx
// Purpose: The composer's Saved button: a bookmark with a count badge that opens the thread's
//          saved prompts. Clicking a prompt asks the caller to restore it; ✕ deletes it.
// Layer: Chat composer presentation (design-owned; callers only supply data and callbacks)
// Depends on: shared button, popover, tooltip and shortcut primitives.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { BookmarkIcon, PaperclipIcon, XIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ShortcutKbd } from "../ui/shortcut-kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Structurally matches the thread's saved prompt entries; only these fields are displayed. */
export interface ComposerSavedPrompt {
  readonly messageId: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<{ readonly name: string }>;
  readonly savedAt: string;
}

const ROW_SELECTOR = "[data-saved-prompt-row]";

export function savedPromptBadgeLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/** First non-empty line of the text, else the first attachment's name. */
export function savedPromptPreview(prompt: ComposerSavedPrompt): string {
  const line = prompt.text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? prompt.attachments[0]?.name ?? "";
}

export function ComposerSavedPrompts(props: {
  /** Newest first. */
  readonly prompts: ReadonlyArray<ComposerSavedPrompt>;
  /** Display label of the save shortcut (e.g. "⌘S"), or null when unbound. */
  readonly shortcutLabel: string | null;
  /**
   * Restore one prompt into the composer. Return false when it was refused synchronously
   * (for example the composer has text); the list then stays open.
   */
  readonly onRestore: (messageId: string) => boolean;
  readonly onDelete: (messageId: string) => void;
}) {
  const { prompts } = props;
  const count = prompts.length;
  const [open, setOpen] = useState(false);
  const badgeRef = useRef<HTMLSpanElement | null>(null);
  const firstRowRef = useRef<HTMLDivElement | null>(null);
  const previousCount = useRef(count);

  // A save is confirmed only by the badge: one short pop whenever the count grows.
  useEffect(() => {
    const grew = count > previousCount.current;
    previousCount.current = count;
    const badge = badgeRef.current;
    if (!grew || !badge || typeof badge.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    badge.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.2)" }, { transform: "scale(1)" }],
      { duration: 160, easing: "ease-out" },
    );
  }, [count]);

  const restore = (messageId: string) => {
    if (props.onRestore(messageId)) setOpen(false);
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR));
    const index = rows.findIndex((row) => row === document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = index === -1 ? 0 : (index + step + rows.length) % rows.length;
      rows[next]!.focus();
      return;
    }
    if (index === -1) return;
    const messageId = rows[index]!.dataset.savedPromptRow!;
    if (event.key === "Enter") {
      event.preventDefault();
      restore(messageId);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      // Keep focus in the list on the row that takes this one's place.
      (rows[index + 1] ?? rows[index - 1])?.focus();
      props.onDelete(messageId);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="relative !size-[26px] shrink-0 rounded-full p-0 sm:!size-[26px]"
                  aria-label={count > 0 ? `Saved prompts, ${count}` : "Saved prompts"}
                  data-testid="composer-saved-prompts"
                />
              }
            />
          }
        >
          <BookmarkIcon aria-hidden="true" className="size-4" />
          {count > 0 ? (
            <span
              ref={badgeRef}
              aria-hidden="true"
              data-testid="composer-saved-prompts-badge"
              className="-top-0.5 -right-0.5 pointer-events-none absolute flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-1 font-medium text-[10px] text-background tabular-nums leading-none ring-2 ring-background"
            >
              {savedPromptBadgeLabel(count)}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">
          <span className="flex items-center gap-2">
            Saved
            {props.shortcutLabel ? <ShortcutKbd shortcutLabel={props.shortcutLabel} /> : null}
          </span>
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        nativeAppOverlay={false}
        tooltipStyle
        side="top"
        align="start"
        sideOffset={6}
        className="w-80 max-w-none"
        initialFocus={count > 0 ? firstRowRef : undefined}
        data-testid="composer-saved-prompts-list"
      >
        <div className="px-1 pt-1 pb-1 text-muted-foreground">Saved</div>
        {count === 0 ? (
          <p className="px-1 pb-1.5 text-muted-foreground">
            Nothing saved. Press {props.shortcutLabel ?? "⌘S"} to save what you're writing.
          </p>
        ) : (
          <div
            role="listbox"
            aria-label="Saved prompts"
            className="-mx-1 max-h-80 overflow-y-auto pb-1"
            onKeyDown={handleListKeyDown}
          >
            {prompts.map((prompt, index) => (
              <div
                key={prompt.messageId}
                ref={index === 0 ? firstRowRef : undefined}
                role="option"
                aria-selected={false}
                tabIndex={0}
                data-saved-prompt-row={prompt.messageId}
                className={cn(
                  "group/saved flex h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none",
                  "hover:bg-accent focus-visible:bg-accent",
                )}
                onClick={() => restore(prompt.messageId)}
              >
                {prompt.attachments.length > 0 ? (
                  <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground tabular-nums">
                    <PaperclipIcon aria-hidden="true" className="size-3.5" />
                    {prompt.attachments.length}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {savedPromptPreview(prompt)}
                </span>
                <span className="relative flex h-5 w-7 shrink-0 items-center justify-end">
                  <span className="text-muted-foreground tabular-nums group-focus-visible/saved:invisible group-hover/saved:invisible">
                    {formatRelativeTime(prompt.savedAt)}
                  </span>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Delete saved prompt"
                    title="Delete"
                    className="absolute inset-y-0 right-0 flex w-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-background/60 hover:text-foreground group-focus-visible/saved:opacity-100 group-hover/saved:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onDelete(prompt.messageId);
                    }}
                  >
                    <XIcon aria-hidden="true" className="size-3.5" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
