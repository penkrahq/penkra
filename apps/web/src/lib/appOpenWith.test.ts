import { describe, expect, it } from "vitest";

import { collectFileHandlerRows, fileTypeLabel } from "./appOpenWith";

describe("App Open With presentation", () => {
  it("groups file handlers by normalized extension", () => {
    expect(
      collectFileHandlerRows([
        {
          id: "explorer",
          name: "Explorer",
          handlers: [
            { intent: "open-file", operation: "resources.open", extensions: [".MD", ".txt"] },
          ],
        },
        {
          id: "notes",
          name: "Notes",
          handlers: [{ intent: "open-file", operation: "notes.open", extensions: [".md"] }],
        },
      ]),
    ).toEqual([
      {
        extension: ".md",
        apps: [
          { id: "explorer", name: "Explorer" },
          { id: "notes", name: "Notes" },
        ],
      },
      { extension: ".txt", apps: [{ id: "explorer", name: "Explorer" }] },
    ]);
    expect(fileTypeLabel(".md")).toBe("Markdown");
  });
});
