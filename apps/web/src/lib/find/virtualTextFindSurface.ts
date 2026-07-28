// FILE: virtualTextFindSurface.ts
// Purpose: Searches complete model text for virtualized rows and reveals the owning row on demand.
// Layer: Web application infrastructure
// Exports: createVirtualTextFindSurface, VirtualFindEntry

import type { FindSurface } from "./findCoordinator";

export interface VirtualFindEntry {
  readonly id: string;
  readonly index: number;
  readonly text: string;
}

interface VirtualMatch {
  readonly entry: VirtualFindEntry;
  readonly occurrence: number;
}

function findMatches(entries: readonly VirtualFindEntry[], query: string): VirtualMatch[] {
  const needle = query.toLocaleLowerCase();
  const matches: VirtualMatch[] = [];
  for (const entry of entries) {
    const text = entry.text.toLocaleLowerCase();
    let from = 0;
    let occurrence = 0;
    while (from <= text.length - needle.length) {
      const index = text.indexOf(needle, from);
      if (index < 0) break;
      matches.push({ entry, occurrence });
      occurrence += 1;
      from = index + Math.max(needle.length, 1);
    }
  }
  return matches;
}

export function createVirtualTextFindSurface(input: {
  id: string;
  order: number;
  isVisible: () => boolean;
  getEntries: () => readonly VirtualFindEntry[];
  reveal: (entry: VirtualFindEntry, query: string, occurrence: number) => Promise<void> | void;
  highlight: (entry: VirtualFindEntry, query: string, occurrence: number) => void;
  clearHighlight: () => void;
}): FindSurface {
  let query = "";
  let matches: VirtualMatch[] = [];
  return {
    id: input.id,
    order: input.order,
    isVisible: input.isVisible,
    search: (nextQuery) => {
      query = nextQuery;
      matches = findMatches(input.getEntries(), query);
      return { count: matches.length };
    },
    activate: async (matchIndex) => {
      const match = matches[matchIndex];
      if (!match) return;
      await input.reveal(match.entry, query, match.occurrence);
      input.highlight(match.entry, query, match.occurrence);
    },
    clear: () => {
      query = "";
      matches = [];
      input.clearHighlight();
    },
  };
}
