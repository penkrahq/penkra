import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS, KEYBINDINGS, compileResolvedKeybindingRule } from "./keybindings";

describe("fixed product shortcuts", () => {
  it("compiles every binding without persistence or missing commands", () => {
    expect(KEYBINDINGS).toHaveLength(DEFAULT_KEYBINDINGS.length);
    for (const rule of DEFAULT_KEYBINDINGS)
      expect(compileResolvedKeybindingRule(rule)).not.toBeNull();
    expect(KEYBINDINGS.some((rule) => rule.command.startsWith("terminal."))).toBe(false);
  });
  it("preserves Mac-only search and non-Mac Ctrl+K", () => {
    expect(
      KEYBINDINGS.filter((rule) => rule.command === "sidebar.search").map(
        (rule) => rule.whenAst ?? null,
      ),
    ).toEqual([null, { type: "not", node: { type: "identifier", name: "isMac" } }]);
  });
});
