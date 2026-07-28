import type { FileDiffMetadata } from "@pierre/diffs/react";
import { describe, expect, it } from "vitest";
import { buildDiffFindText, diffFindRenderedLineForOffset } from "./diffFindText";

const file = {
  name: "src/new.ts",
  prevName: "src/old.ts",
  type: "rename-changed",
  hunks: [
    {
      collapsedBefore: 0,
      additionStart: 1,
      additionCount: 3,
      additionLines: 1,
      additionLineIndex: 0,
      deletionStart: 1,
      deletionCount: 3,
      deletionLines: 1,
      deletionLineIndex: 0,
      hunkContent: [
        { type: "context", lines: 1, additionLineIndex: 0, deletionLineIndex: 0 },
        {
          type: "change",
          deletions: 1,
          deletionLineIndex: 1,
          additions: 1,
          additionLineIndex: 1,
        },
        { type: "context", lines: 1, additionLineIndex: 2, deletionLineIndex: 2 },
      ],
      hunkSpecs: "@@ -1,3 +1,3 @@",
      splitLineStart: 20,
      splitLineCount: 3,
      unifiedLineStart: 10,
      unifiedLineCount: 4,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    },
  ],
  splitLineCount: 3,
  unifiedLineCount: 4,
  isPartial: true,
  deletionLines: ["shared", "old needle", "tail"],
  additionLines: ["shared", "new needle", "tail"],
} satisfies FileDiffMetadata;

describe("diff find text", () => {
  it("models unified diff order and exact rendered line anchors", () => {
    const model = buildDiffFindText(file, { collapsed: false, mode: "stacked" });
    expect(model.text).toContain("old needle\nnew needle");
    expect(diffFindRenderedLineForOffset(model, model.text.indexOf("old needle"))).toBe(11);
    expect(diffFindRenderedLineForOffset(model, model.text.indexOf("new needle"))).toBe(12);
  });

  it("models split rows and excludes collapsed file contents", () => {
    const split = buildDiffFindText(file, { collapsed: false, mode: "split" });
    expect(split.text).toContain("old needle\tnew needle");
    expect(diffFindRenderedLineForOffset(split, split.text.indexOf("new needle"))).toBe(21);

    const collapsed = buildDiffFindText(file, { collapsed: true, mode: "stacked" });
    expect(collapsed.text).toBe("src/old.ts\nsrc/new.ts");
    expect(collapsed.text).not.toContain("needle");
  });
});
