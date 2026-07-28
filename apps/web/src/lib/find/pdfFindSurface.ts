// FILE: pdfFindSurface.ts
// Purpose: Searches complete pdf.js text content while keeping page rendering virtualized.
// Layer: Web application infrastructure
// Exports: createPdfFindSurface

import type { PDFDocumentProxy } from "../pdf/pdfEngine";
import type { FindSurface } from "./findCoordinator";
import { isFindSurfaceVisible } from "./findVisibility";

interface PdfMatch {
  readonly pageNumber: number;
  readonly occurrence: number;
}

async function extractPages(document: PDFDocumentProxy): Promise<string[]> {
  const pages = new Array<string>(document.numPages).fill("");
  let nextPage = 1;
  const worker = async () => {
    while (nextPage <= document.numPages) {
      const pageNumber = nextPage++;
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages[pageNumber - 1] = content.items
        .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : ""))
        .join("");
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, document.numPages) }, () => worker()));
  return pages;
}

export function createPdfFindSurface(input: {
  id: string;
  order: number;
  document: PDFDocumentProxy;
  root: HTMLElement;
  jumpToPage: (pageNumber: number) => void;
}): FindSurface {
  let pageTextPromise: Promise<string[]> | null = null;
  let query = "";
  let matches: PdfMatch[] = [];
  const highlightName = "penkra-find-pdf-active";

  return {
    id: input.id,
    order: input.order,
    searchTimeoutMs: 15_000,
    isVisible: () => isFindSurfaceVisible(input.root),
    search: async (nextQuery) => {
      query = nextQuery;
      pageTextPromise ??= extractPages(input.document);
      const pages = await pageTextPromise;
      const needle = query.toLocaleLowerCase();
      matches = [];
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
        const text = pages[pageIndex]!.toLocaleLowerCase();
        let from = 0;
        let occurrence = 0;
        while (from <= text.length - needle.length) {
          const index = text.indexOf(needle, from);
          if (index < 0) break;
          matches.push({ pageNumber: pageIndex + 1, occurrence });
          occurrence += 1;
          from = index + Math.max(needle.length, 1);
        }
      }
      return { count: matches.length };
    },
    activate: async (matchIndex) => {
      const match = matches[matchIndex];
      if (!match) return;
      input.jumpToPage(match.pageNumber);
      // The target page's selectable text layer is painted after it enters the
      // PDF viewport. Retry across a few animation frames without retaining
      // offscreen text-layer DOM for the rest of the document.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const layer = input.root.querySelector<HTMLElement>(
          `[data-page-number="${match.pageNumber}"] .pdf-viewer-page__text-layer`,
        );
        if (!layer?.textContent || !CSS.highlights || !globalThis.Highlight) continue;
        const text = layer.textContent.toLocaleLowerCase();
        let start = 0;
        for (let occurrence = 0; occurrence <= match.occurrence; occurrence += 1) {
          start = text.indexOf(
            query.toLocaleLowerCase(),
            occurrence === 0 ? 0 : start + query.length,
          );
          if (start < 0) break;
        }
        if (start < 0) return;
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        let offset = 0;
        let startNode: Text | null = null;
        let endNode: Text | null = null;
        let startOffset = 0;
        let endOffset = 0;
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const textNode = node as Text;
          const end = offset + textNode.data.length;
          if (!startNode && start >= offset && start < end) {
            startNode = textNode;
            startOffset = start - offset;
          }
          if (start + query.length > offset && start + query.length <= end) {
            endNode = textNode;
            endOffset = start + query.length - offset;
            break;
          }
          offset = end;
        }
        if (!startNode || !endNode) return;
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        CSS.highlights.set(highlightName, new Highlight(range));
        return;
      }
    },
    clear: () => {
      query = "";
      matches = [];
      CSS.highlights?.delete(highlightName);
    },
  };
}
