import { describe, expect, it } from "vitest";

import { collectFileHandlerRows, fileTypeLabel } from "./appOpenWith";

describe("flat file-type Open With rows", () => {
  it("groups compatible Apps by normalized extension without duplicate App options", () => {
    const rows = collectFileHandlerRows([
      {
        id: "com.penkra.explorer",
        name: "Explorer",
        handlers: [
          { intent: "open-file", operation: "resources.open", extensions: [".PDF", ".md"] },
          { intent: "open-file", operation: "resources.preview", extensions: [".pdf"] },
        ],
      },
      {
        id: "com.example.pdf",
        name: "PDF",
        handlers: [{ intent: "open-file", operation: "documents.open", extensions: [".pdf"] }],
      },
    ]);

    expect(rows).toEqual([
      {
        extension: ".md",
        apps: [{ id: "com.penkra.explorer", name: "Explorer" }],
      },
      {
        extension: ".pdf",
        apps: [
          { id: "com.penkra.explorer", name: "Explorer" },
          { id: "com.example.pdf", name: "PDF" },
        ],
      },
    ]);
    expect(fileTypeLabel(".pdf")).toBe("PDF");
    expect(fileTypeLabel(".txt")).toBe("Text");
  });
});
