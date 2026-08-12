import { describe, expect, it } from "vitest";

import {
  accountEmailConnectionLabel,
  secretSuffixConnectionLabel,
} from "./providerConnectionDisplayIdentity.ts";

describe("provider Connection display identity", () => {
  it("uses the provider-returned account email exactly", () => {
    expect(accountEmailConnectionLabel("person@example.com")).toBe("person@example.com");
    expect(() => accountEmailConnectionLabel(null)).toThrow(/did not return the account email/i);
  });

  it("uses a manifest prefix and the exact final four credential characters", () => {
    expect(secretSuffixConnectionLabel({ prefix: "OpenCode Go", secret: "sk-example-A7F2" })).toBe(
      "OpenCode Go / ••••A7F2",
    );
    expect(() => secretSuffixConnectionLabel({ prefix: "API", secret: "abc" })).toThrow(
      /too short/i,
    );
  });
});
