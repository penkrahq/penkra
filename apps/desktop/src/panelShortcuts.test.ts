import { describe, expect, it } from "vitest";
import type { Input } from "electron";
import {
  resolvePanelShortcut,
  shouldInterceptShellShortcut,
  shouldRouteShellPanelClose,
} from "./panelShortcuts";

function input(key: string, options: Partial<Input> = {}): Input {
  return {
    type: "keyDown",
    key,
    code: `Key${key.toUpperCase()}`,
    meta: true,
    control: false,
    shift: false,
    alt: false,
    isAutoRepeat: false,
    ...options,
  } as Input;
}

describe("resolvePanelShortcut", () => {
  it("routes the three macOS chords and ignores keyUp, repeat, and modified variants", () => {
    expect(resolvePanelShortcut("darwin", input("N", { shift: true }))).toBe("new-window");
    expect(resolvePanelShortcut("darwin", input("f"))).toBe("find");
    expect(resolvePanelShortcut("darwin", input("w"))).toBe("close");
    expect(resolvePanelShortcut("darwin", input("w", { type: "keyUp" }))).toBeNull();
    expect(resolvePanelShortcut("darwin", input("w", { isAutoRepeat: true }))).toBeNull();
    expect(resolvePanelShortcut("darwin", input("f", { alt: true }))).toBeNull();
  });
});

describe("shell shortcut ownership", () => {
  it("leaves close to the shell DOM target, while main handles find and new-window", () => {
    expect(shouldInterceptShellShortcut("close")).toBe(false);
    expect(shouldInterceptShellShortcut("find")).toBe(true);
    expect(shouldInterceptShellShortcut("new-window")).toBe(true);
  });

  it("captures close only from the focused panel on macOS and Windows", () => {
    const mac = {
      key: "w",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
    };
    expect(shouldRouteShellPanelClose("darwin", mac, true)).toBe(true);
    expect(shouldRouteShellPanelClose("darwin", mac, false)).toBe(false);
    expect(shouldRouteShellPanelClose("darwin", { ...mac, shiftKey: true }, true)).toBe(false);
    expect(
      shouldRouteShellPanelClose("win32", { ...mac, metaKey: false, ctrlKey: true }, true),
    ).toBe(true);
    expect(resolvePanelShortcut("win32", input("w", { meta: false, control: true }))).toBe("close");
  });
});
