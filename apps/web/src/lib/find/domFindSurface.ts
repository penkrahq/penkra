// FILE: domFindSurface.ts
// Purpose: Exact, non-mutating find support for ordinary rendered application text.
// Layer: Web application infrastructure
// Exports: createDomFindSurface

import type { FindSurface } from "./findCoordinator";

const MATCH_HIGHLIGHT = "penkra-find-match";
const ACTIVE_HIGHLIGHT = "penkra-find-active";

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

interface HighlightConstructor {
  new (...ranges: Range[]): unknown;
}

interface TextSegment {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

function highlightApi(): {
  registry: HighlightRegistry;
  Highlight: HighlightConstructor;
} | null {
  const registry = (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights;
  const Highlight = (globalThis as typeof globalThis & { Highlight?: HighlightConstructor })
    .Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

function isExcluded(node: Text, root: HTMLElement): boolean {
  let element = node.parentElement;
  while (element && element !== root) {
    if (
      element.hidden ||
      element.matches(
        "[data-find-exclude], [data-find-model-owned], [aria-hidden='true'], [inert], details:not([open]) > :not(summary)",
      )
    ) {
      return true;
    }
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return true;
    }
    const parent = element.parentElement;
    if (parent) {
      element = parent;
      continue;
    }
    const treeRoot = element.getRootNode();
    element = treeRoot instanceof ShadowRoot ? (treeRoot.host as HTMLElement) : null;
  }
  return false;
}

function collectText(root: HTMLElement): { text: string; segments: TextSegment[] } {
  const segments: TextSegment[] = [];
  let text = "";
  const visit = (container: Node) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const node = current as Text;
      if (!node.data || isExcluded(node, root)) continue;
      const start = text.length;
      text += node.data;
      segments.push({ node, start, end: text.length });
      const parentDisplay = node.parentElement
        ? getComputedStyle(node.parentElement).display
        : "inline";
      if (
        parentDisplay !== "inline" &&
        parentDisplay !== "inline-block" &&
        parentDisplay !== "inline-flex" &&
        parentDisplay !== "contents"
      ) {
        text += "\n";
      }
    }
    const elements =
      container instanceof Element ? [container, ...container.querySelectorAll("*")] : [];
    for (const element of elements) {
      if (element.shadowRoot) {
        text += "\n";
        visit(element.shadowRoot);
        text += "\n";
      }
    }
  };
  visit(root);
  return { text, segments };
}

function findRanges(root: HTMLElement, query: string): Range[] {
  const { text, segments } = collectText(root);
  if (!text || !query) return [];
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const ranges: Range[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const matchStart = haystack.indexOf(needle, from);
    if (matchStart < 0) break;
    const matchEnd = matchStart + needle.length;
    const startSegment = segments.find(
      (segment) => segment.start <= matchStart && segment.end > matchStart,
    );
    const endSegment = segments.find(
      (segment) => segment.start < matchEnd && segment.end >= matchEnd,
    );
    if (startSegment && endSegment) {
      const range = document.createRange();
      range.setStart(startSegment.node, matchStart - startSegment.start);
      range.setEnd(endSegment.node, matchEnd - endSegment.start);
      ranges.push(range);
    }
    from = matchStart + Math.max(needle.length, 1);
  }
  return ranges;
}

export function createDomFindSurface(input: {
  id: string;
  order: number;
  root: HTMLElement;
  isVisible?: () => boolean;
}): FindSurface {
  let ranges: Range[] = [];
  let activeIndex = -1;
  const invalidationListeners = new Set<() => void>();
  let invalidationFrame: number | null = null;
  const observer = new MutationObserver((records) => {
    const hasSearchableChange = records.some((record) => {
      const element =
        record.target.nodeType === Node.ELEMENT_NODE
          ? (record.target as Element)
          : record.target.parentElement;
      return !element?.closest("[data-find-exclude], [data-find-model-owned]");
    });
    if (!hasSearchableChange) return;
    if (invalidationFrame !== null) return;
    invalidationFrame = requestAnimationFrame(() => {
      invalidationFrame = null;
      for (const listener of invalidationListeners) listener();
    });
  });
  observer.observe(input.root, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  const renderHighlights = () => {
    const api = highlightApi();
    if (!api) return;
    api.registry.delete(MATCH_HIGHLIGHT);
    api.registry.delete(ACTIVE_HIGHLIGHT);
    if (ranges.length > 0) {
      api.registry.set(MATCH_HIGHLIGHT, new api.Highlight(...ranges));
    }
    const active = ranges[activeIndex];
    if (active) api.registry.set(ACTIVE_HIGHLIGHT, new api.Highlight(active));
  };

  return {
    id: input.id,
    order: input.order,
    isVisible:
      input.isVisible ?? (() => input.root.isConnected && input.root.getClientRects().length > 0),
    search: (query) => {
      ranges = findRanges(input.root, query);
      if (activeIndex >= ranges.length) activeIndex = -1;
      renderHighlights();
      return { count: ranges.length };
    },
    activate: (matchIndex) => {
      activeIndex = matchIndex;
      renderHighlights();
      const range = ranges[matchIndex];
      const element =
        range?.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range?.startContainer.parentElement;
      element?.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    },
    clear: () => {
      ranges = [];
      activeIndex = -1;
      const api = highlightApi();
      api?.registry.delete(MATCH_HIGHLIGHT);
      api?.registry.delete(ACTIVE_HIGHLIGHT);
    },
    subscribeInvalidation: (listener) => {
      invalidationListeners.add(listener);
      return () => {
        invalidationListeners.delete(listener);
        if (invalidationListeners.size === 0) {
          observer.disconnect();
          if (invalidationFrame !== null) cancelAnimationFrame(invalidationFrame);
        }
      };
    },
  };
}
