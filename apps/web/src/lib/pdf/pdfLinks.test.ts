import { describe, expect, it, vi } from "vitest";

import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "./pdfEngine";
import { extractPageLinks } from "./pdfLinks";

// Identity viewport: returns the rect unchanged so the test asserts the
// min/width/height math without depending on pdf.js matrix internals.
const viewport = {
  convertToViewportRectangle: (rect: number[]) => rect,
} as unknown as PageViewport;

function makePage(annotations: unknown[], pageNumber = 1): PDFPageProxy {
  return {
    pageNumber,
    getAnnotations: vi.fn().mockResolvedValue(annotations),
  } as unknown as PDFPageProxy;
}

describe("extractPageLinks", () => {

  it("drops unsafe external annotation URLs instead of falling back to unsafeUrl", async () => {
    const doc = {
      getDestination: vi.fn(),
      getPageIndex: vi.fn(),
    } as unknown as PDFDocumentProxy;

    const links = await extractPageLinks({
      doc,
      page: makePage([
        { subtype: "Link", rect: [0, 0, 10, 10], unsafeUrl: "javascript:alert(1)" },
        { subtype: "Link", rect: [0, 20, 10, 30], url: "file:///etc/passwd" },
        { subtype: "Link", rect: [0, 40, 10, 50], url: "https://example.com" },
      ]),
      viewport,
    });

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ url: "https://example.com/" });
  });
});
