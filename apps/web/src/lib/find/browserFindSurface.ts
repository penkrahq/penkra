// FILE: browserFindSurface.ts
// Purpose: Adapts Electron's native Chromium find-in-page stream to application find.
// Layer: Web application infrastructure
// Exports: createBrowserFindSurface

import type { BrowserControlMethods, BrowserTabInput } from "@penkra/contracts";
import type { FindSurface } from "./findCoordinator";

export function createBrowserFindSurface(input: {
  id: string;
  order: number;
  browser: BrowserControlMethods;
  target: BrowserTabInput;
  isVisible: () => boolean;
}): FindSurface {
  let query = "";
  let activeIndex = -1;
  let count = 0;

  return {
    id: input.id,
    order: input.order,
    isVisible: input.isVisible,
    search: async (nextQuery) => {
      query = nextQuery;
      const result = await input.browser.findInPage?.({
        ...input.target,
        text: query,
        action: "search",
      });
      count = result?.matches ?? 0;
      activeIndex = result && result.activeMatchOrdinal > 0 ? result.activeMatchOrdinal - 1 : -1;
      return { count };
    },
    activate: async (matchIndex) => {
      if (!query || count === 0 || matchIndex === activeIndex) return;
      const forwardDistance = (matchIndex - activeIndex + count) % count;
      const backwardDistance = (activeIndex - matchIndex + count) % count;
      const action = forwardDistance <= backwardDistance ? "next" : "previous";
      const steps = Math.min(forwardDistance, backwardDistance);
      for (let index = 0; index < steps; index += 1) {
        const result = await input.browser.findInPage?.({
          ...input.target,
          text: query,
          action,
        });
        activeIndex =
          result && result.activeMatchOrdinal > 0 ? result.activeMatchOrdinal - 1 : activeIndex;
      }
    },
    clear: () => {
      query = "";
      count = 0;
      activeIndex = -1;
      void input.browser.stopFindInPage?.(input.target);
    },
  };
}
