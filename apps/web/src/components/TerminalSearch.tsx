// FILE: TerminalSearch.tsx
// Purpose: Provides the in-terminal find bar and navigation controls.
// Layer: Terminal presentation component
// Exports: TerminalSearch

import type { SearchAddon, ISearchOptions } from "@xterm/addon-search";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "~/components/ui/icon-button";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

interface TerminalSearchProps {
  searchAddon: SearchAddon | null;
  isOpen: boolean;
  onClose: () => void;
}

const SEARCH_DECORATIONS = {
  matchBackground: "#515c6a",
  matchBorder: "#74879f",
  matchOverviewRuler: "#d186167e",
  activeMatchBackground: "#515c6a",
  activeMatchBorder: "#ffd33d",
  activeMatchColorOverviewRuler: "#ffd33d",
} satisfies NonNullable<ISearchOptions["decorations"]>;

export function TerminalSearch({ searchAddon, isOpen, onClose }: TerminalSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hasResults, setHasResults] = useState<boolean | null>(null);
  const [caseSensitive, setCaseSensitive] = useState(false);

  const searchOptions: ISearchOptions = useMemo(
    () => ({
      caseSensitive,
      regex: false,
      decorations: SEARCH_DECORATIONS,
    }),
    [caseSensitive],
  );

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen && searchAddon) {
      searchAddon.clearDecorations();
    }
  }, [isOpen, searchAddon]);

  useEffect(() => {
    if (!searchAddon) return;
    const subscription = searchAddon.onDidChangeResults(({ resultCount }) => {
      setHasResults(resultCount > 0);
    });
    return () => subscription.dispose();
  }, [searchAddon]);

  const handleSearch = (direction: "next" | "previous") => {
    if (!searchAddon || !query) return;
    if (direction === "next") searchAddon.findNext(query, searchOptions);
    else searchAddon.findPrevious(query, searchOptions);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newQuery = e.target.value;
    setQuery(newQuery);
    if (!searchAddon || !newQuery) {
      searchAddon?.clearDecorations();
      setHasResults(null);
    }
  };

  useEffect(() => {
    if (searchAddon && query) searchAddon.findNext(query, searchOptions);
  }, [searchAddon, query, searchOptions]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleSearch(e.shiftKey ? "previous" : "next");
    }
  };

  const handleClose = () => {
    setQuery("");
    setHasResults(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="absolute right-1 top-1 z-10 flex max-w-[calc(100%-0.5rem)] items-center rounded bg-popover/95 pl-2 pr-0.5 shadow-lg ring-1 ring-border/40 backdrop-blur">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder="Find"
        className="h-6 w-28 min-w-0 flex-shrink bg-transparent text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      {hasResults === false && query && (
        <span className="whitespace-nowrap px-1 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
          No results
        </span>
      )}
      <div className="flex shrink-0 items-center">
        <IconButton
          onClick={() => setCaseSensitive((v) => !v)}
          label="Match case"
          className={cn(
            "size-6 rounded-sm border-transparent bg-transparent shadow-none sm:size-6",
            caseSensitive
              ? "bg-primary/20 text-foreground"
              : "text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground",
          )}
        >
          <span className="text-[length:var(--app-font-size-ui-xs,10px)] font-bold leading-none">
            Aa
          </span>
        </IconButton>
        <IconButton
          onClick={() => handleSearch("previous")}
          className="size-6 rounded-sm border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/20 hover:text-foreground sm:size-6"
          label="Previous match (Shift+Enter)"
        >
          <ChevronUpIcon className="size-3.5" />
        </IconButton>
        <IconButton
          onClick={() => handleSearch("next")}
          className="size-6 rounded-sm border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/20 hover:text-foreground sm:size-6"
          label="Next match (Enter)"
        >
          <ChevronDownIcon className="size-3.5" />
        </IconButton>
        <IconButton
          onClick={handleClose}
          className="size-6 rounded-sm border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/20 hover:text-foreground sm:size-6"
          label="Close search (Esc)"
        >
          <XIcon className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}
