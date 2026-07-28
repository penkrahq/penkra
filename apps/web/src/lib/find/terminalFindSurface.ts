// FILE: terminalFindSurface.ts
// Purpose: Adapts xterm's authoritative buffer search and result count to application find.
// Layer: Web application infrastructure
// Exports: createTerminalFindSurface

import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import type { FindSurface } from "./findCoordinator";

const SEARCH_OPTIONS: ISearchOptions = {
  caseSensitive: false,
  regex: false,
  decorations: {
    matchBackground: "#515c6a",
    matchBorder: "#74879f",
    matchOverviewRuler: "#d186167e",
    activeMatchBackground: "#515c6a",
    activeMatchBorder: "#ffd33d",
    activeMatchColorOverviewRuler: "#ffd33d",
  },
};

export function createTerminalFindSurface(input: {
  id: string;
  order: number;
  searchAddon: SearchAddon;
  isVisible: () => boolean;
}): FindSurface {
  let query = "";
  let count = 0;
  let activeIndex = -1;
  const resultSubscription = input.searchAddon.onDidChangeResults((event) => {
    count = event.resultCount;
    activeIndex = event.resultIndex;
  });

  return {
    id: input.id,
    order: input.order,
    isVisible: input.isVisible,
    search: (nextQuery) => {
      query = nextQuery;
      count = 0;
      activeIndex = -1;
      input.searchAddon.findNext(query, SEARCH_OPTIONS);
      return { count };
    },
    activate: (matchIndex) => {
      if (!query || count === 0 || matchIndex === activeIndex) return;
      const forwardDistance = (matchIndex - activeIndex + count) % count;
      const backwardDistance = (activeIndex - matchIndex + count) % count;
      const moveForward = forwardDistance <= backwardDistance;
      const steps = moveForward ? forwardDistance : backwardDistance;
      for (let index = 0; index < steps; index += 1) {
        if (moveForward) input.searchAddon.findNext(query, SEARCH_OPTIONS);
        else input.searchAddon.findPrevious(query, SEARCH_OPTIONS);
      }
    },
    clear: () => {
      query = "";
      count = 0;
      activeIndex = -1;
      input.searchAddon.clearDecorations();
    },
    subscribeInvalidation: () => () => resultSubscription.dispose(),
  };
}
