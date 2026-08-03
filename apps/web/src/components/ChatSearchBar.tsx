// FILE: ChatSearchBar.tsx
// Purpose: Floating search bar triggered by Cmd+F, positioned at top-right of the app.
// Layer: Chat UI
// Exports: ChatSearchBar

import { memo, useEffect, useRef } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useFind } from "./find/FindProvider";

export interface ChatSearchBarProps {
  open: boolean;
  focusRequest?: number;
  onOpenChange: (open: boolean) => void;
}

export const ChatSearchBar = memo(function ChatSearchBar(props: ChatSearchBarProps) {
  const { open, focusRequest = 0, onOpenChange } = props;
  const { state, setQuery, next, previous, clear } = useFind();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const frame = window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [focusRequest, open]);

  useEffect(() => {
    if (!open) clear();
  }, [clear, open]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void (event.shiftKey ? previous() : next());
    }
  };

  if (!open) return null;

  return (
    <div
      data-find-exclude
      role="search"
      aria-label="Find in open views"
      className={cn(
        "fixed right-4 top-4 z-50 overflow-hidden rounded-lg border bg-background shadow-lg",
        "w-[min(28rem,calc(100vw-2rem))]",
      )}
    >
      <div className="flex items-center gap-2">
        <div className="flex items-center pl-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        </div>
        <input
          ref={inputRef}
          type="search"
          aria-label="Find text"
          placeholder="Find in open views..."
          value={state.query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 appearance-none bg-transparent py-2.5 pr-2 text-[length:calc(var(--app-font-size-base,12px)*1.1667)] outline-none placeholder:text-muted-foreground/50 [&::-webkit-search-cancel-button]:hidden"
        />
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="mr-2 rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
          title="Close find"
          aria-label="Close find"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      {state.query ? (
        <div
          className="flex items-center justify-end gap-1 border-t px-2 py-1.5"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="mr-auto px-1 text-[length:var(--app-font-size-ui,12px)] tabular-nums text-muted-foreground">
            {state.pending
              ? "Searching…"
              : state.total === 0
                ? "No results"
                : `${state.current || "–"} / ${state.total} results`}
          </span>
          <button
            type="button"
            onClick={() => void previous()}
            disabled={state.pending || state.total === 0}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-35"
            title="Previous result (Shift+Enter)"
            aria-label="Previous result"
          >
            <ChevronUpIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void next()}
            disabled={state.pending || state.total === 0}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-35"
            title="Next result (Enter)"
            aria-label="Next result"
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
});
