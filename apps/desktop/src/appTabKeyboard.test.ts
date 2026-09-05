import { describe, expect, it } from "vitest";
import { appTabKeyDefinition } from "./appTabKeyboard";

describe("App-tab keyboard encoding", () => {
  it("supplies physical codes and text for editor Enter", () => {
    expect(appTabKeyDefinition("Enter")).toEqual({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 0,
      text: "\r",
    });
    expect(appTabKeyDefinition("Escape")).toMatchObject({
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  });
  it("separates shortcut modifiers from the key", () => {
    expect(appTabKeyDefinition("Meta+Shift+ArrowRight")).toEqual({
      key: "ArrowRight",
      code: "ArrowRight",
      windowsVirtualKeyCode: 39,
      modifiers: 12,
    });
    expect(appTabKeyDefinition("Ctrl+a")).toMatchObject({ code: "KeyA", modifiers: 2 });
    expect(appTabKeyDefinition("Meta+k")).not.toHaveProperty("text");
  });
  it("handles printable keys, plus and named space", () => {
    expect(appTabKeyDefinition("Shift+1")).toMatchObject({ key: "!", code: "Digit1", text: "!" });
    expect(appTabKeyDefinition("Meta++")).toMatchObject({ key: "+", code: "Equal", modifiers: 4 });
    expect(appTabKeyDefinition("Space")).toMatchObject({ key: " ", code: "Space", text: " " });
  });
  it("rejects malformed shortcuts rather than sending a literal fake key", () => {
    for (const input of ["Hyper+A", "Meta+", "NotAKey", "__proto__", "constructor", "toString+A"])
      expect(() => appTabKeyDefinition(input)).toThrow();
  });
});
