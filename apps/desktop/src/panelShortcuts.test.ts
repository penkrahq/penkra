import { describe, expect, it, vi } from "vitest";
import type { Input } from "electron";
import {
  isShellPanelCloseShortcut,
  preventBeforeInputShortcut,
  resolvePanelShortcut,
  resolvePanelShortcutEffect,
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
  it("routes the macOS chords and ignores keyUp, repeat, and modified variants", () => {
    expect(resolvePanelShortcut("darwin", input("N", { shift: true }))).toBe("new-window");
    expect(resolvePanelShortcut("darwin", input("f"))).toBe("find");
    expect(resolvePanelShortcut("darwin", input("w"))).toBe("close");
    expect(resolvePanelShortcut("darwin", input("w", { type: "keyUp" }))).toBeNull();
    expect(resolvePanelShortcut("darwin", input("w", { isAutoRepeat: true }))).toBeNull();
    expect(resolvePanelShortcut("darwin", input("f", { alt: true }))).toBeNull();
  });

  it.each(["win32", "linux"] as const)(
    "routes Ctrl+%s chords with the primary modifier",
    (platform) => {
      const primary = { meta: false, control: true };
      expect(resolvePanelShortcut(platform, input("N", { shift: true, ...primary }))).toBe(
        "new-window",
      );
      expect(resolvePanelShortcut(platform, input("f", primary))).toBe("find");
      expect(resolvePanelShortcut(platform, input("w", primary))).toBe("close");
      // Meta without Control is not the platform primary modifier.
      expect(resolvePanelShortcut(platform, input("w"))).toBeNull();
      expect(resolvePanelShortcut(platform, input("w", { type: "keyUp", ...primary }))).toBeNull();
    },
  );
});

describe("resolvePanelShortcutEffect", () => {
  it("closes the selected panel tab only while the panel is focused", () => {
    expect(resolvePanelShortcutEffect("close", true, "deck-1")).toEqual({
      kind: "close-panel-tab",
      deckId: "deck-1",
    });
    expect(resolvePanelShortcutEffect("close", false, "deck-1")).toEqual({ kind: "none" });
    expect(resolvePanelShortcutEffect("close", true, null)).toEqual({ kind: "none" });
    expect(resolvePanelShortcutEffect("close", false, null)).toEqual({ kind: "none" });
  });

  it("passes through the window-level commands", () => {
    expect(resolvePanelShortcutEffect("new-window", false, null)).toEqual({ kind: "new-window" });
    expect(resolvePanelShortcutEffect("find", false, null)).toEqual({ kind: "open-find" });
  });
});

describe("Cmd/Ctrl+W interception", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "leaves an unfocused panel's %s key event unprevented",
    (platform) => {
      const event = { preventDefault: vi.fn() };
      expect(preventBeforeInputShortcut(event, "close", false, false)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(
        isShellPanelCloseShortcut(platform, {
          key: "w",
          metaKey: platform === "darwin",
          ctrlKey: platform !== "darwin",
          shiftKey: false,
          altKey: false,
          repeat: false,
        }),
      ).toBe(true);
      expect(
        shouldRouteShellPanelClose(
          platform,
          {
            key: "w",
            metaKey: platform === "darwin",
            ctrlKey: platform !== "darwin",
            shiftKey: false,
            altKey: false,
            repeat: false,
          },
          false,
        ),
      ).toBe(false);
    },
  );

  it("leaves shell W to DOM capture and prevents an App view's focused-panel W", () => {
    const event = { preventDefault: vi.fn() };
    expect(preventBeforeInputShortcut(event, "close", true, true)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(preventBeforeInputShortcut(event, "close", true, false)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
