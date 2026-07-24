import { describe, expect, it } from "vitest";

import {
  countTextLines,
  extractToolRawOutputText,
  summarizeToolRawOutput,
} from "./toolOutputSummary";

describe("toolOutputSummary", () => {
  it("summarizes Cursor search totals", () => {
    expect(summarizeToolRawOutput({ totalFiles: 33, truncated: false })).toBe("33 files found");
    expect(summarizeToolRawOutput({ totalFiles: 1, truncated: true })).toBe(
      "1 file found (truncated)",
    );
  });

  it("summarizes text content with a human line count", () => {
    expect(countTextLines("one\ntwo\n")).toBe(2);
    expect(summarizeToolRawOutput({ content: "one\ntwo\n" })).toBe("Read 2 lines");
  });

  it("uses the first stdout line as a fallback", () => {
    expect(summarizeToolRawOutput({ stdout: "done\nextra" })).toBe("done");
    expect(summarizeToolRawOutput({ rawInput: {} })).toBeUndefined();
  });

  it("extracts a concise MCP error from an object output", () => {
    expect(
      summarizeToolRawOutput({
        is_error: true,
        output: {
          Error: 'Invalid creation plan: Unexpected key "reasoningEffort"\n  at ["threads"][1]',
        },
      }),
    ).toBe('Invalid creation plan: Unexpected key "reasoningEffort"');
  });

  it("concatenates ACP array-shaped text output without dropping later parts", () => {
    const rawOutput = [
      { type: "input_text", text: "Script completed\nWall time 0.1s" },
      { type: "input_text", text: "Usage: penkra client [options]" },
    ];
    expect(extractToolRawOutputText(rawOutput)).toBe(
      "Script completed\nWall time 0.1s\nUsage: penkra client [options]",
    );
    expect(summarizeToolRawOutput(rawOutput)).toBe("Script completed");
  });
});
