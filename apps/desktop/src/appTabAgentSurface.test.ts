import { describe, expect, it } from "vitest";

import { boundPageContent, compactSnapshot, diffSnapshots } from "./appTabAgentSurface";

describe("App tab agent surface helpers", () => {
  it("wraps untrusted page text in an unpredictable matching boundary", () => {
    const output = boundPageContent("page text", "https://example.test/");
    const nonce = /nonce=([a-f0-9]{32})/.exec(output)?.[1];
    expect(nonce).toHaveLength(32);
    expect(output).toContain(`origin=https://example.test/ ---\npage text`);
    expect(output).toContain(`END_AGENT_BROWSER_PAGE_CONTENT nonce=${nonce} ---`);
  });

  it("compacts snapshots to referenced/value lines and their ancestors", () => {
    expect(
      compactSnapshot(
        '- document "Root"\n  - generic "Wrapper"\n    - button "Save" [ref=d1:e1]\n  - generic "Noise"',
        false,
      ),
    ).toBe('- document "Root"\n  - generic "Wrapper"\n    - button "Save" [ref=d1:e1]');
  });

  it("produces a Myers-style unified line diff with counts", () => {
    expect(diffSnapshots("one\ntwo\nthree", "one\nchanged\nthree")).toMatchObject({
      additions: 1,
      removals: 1,
      unchanged: 2,
      changed: true,
      diff: expect.stringContaining("-two\n+changed"),
    });
  });
});
