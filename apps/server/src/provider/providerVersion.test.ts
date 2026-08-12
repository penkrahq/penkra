import { describe, expect, it } from "vitest";

import { compareSemverVersions, parseGenericCliVersion } from "./providerVersion";

describe("provider version", () => {
  it("parses two- and three-segment CLI versions", () => {
    expect(parseGenericCliVersion("codex-cli 0.130.0\n")).toBe("0.130.0");
    expect(parseGenericCliVersion("claude 2.1\n")).toBe("2.1.0");
    expect(parseGenericCliVersion("no version here")).toBeNull();
  });

  it("compares stable and prerelease versions", () => {
    expect(compareSemverVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareSemverVersions("1.2.3-beta.2", "1.2.3-beta.10")).toBeLessThan(0);
    expect(compareSemverVersions("1.2.3", "1.2.3-beta.10")).toBeGreaterThan(0);
  });
});
