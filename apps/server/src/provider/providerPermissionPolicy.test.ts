import { describe, expect, it } from "vitest";

import {
  openCodeSessionRulesEnforce,
  providerPermissionDecision,
} from "./providerPermissionPolicy.ts";
import { buildOpenCodePermissionRules } from "./opencodeRuntime.ts";

describe("provider permission policy", () => {
  it("declines restricted execution", () => {
    expect(providerPermissionDecision("approval-required")).toBe("decline");
  });
  it("requires a complete wildcard-led effective tail before an imported session can prompt", () => {
    const ask = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "*", action: "ask" },
    ];
    const allow = { permission: "*", pattern: "*", action: "allow" };
    expect(openCodeSessionRulesEnforce([allow, ...ask], ask)).toBe(true);
    expect(openCodeSessionRulesEnforce([...ask, allow], ask)).toBe(false);
    expect(openCodeSessionRulesEnforce([allow], ask)).toBe(false);
    expect(openCodeSessionRulesEnforce([ask[1]!], [ask[1]!])).toBe(false);
    for (const mode of ["approval-required", "full-access"] as const) {
      expect(buildOpenCodePermissionRules(mode).at(-1)).toEqual({
        permission: "task",
        pattern: "*",
        action: "deny",
      });
    }
  });
});
