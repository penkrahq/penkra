// FILE: menuShortcuts.test.ts
// Purpose: Verifies desktop menu accelerator choices that affect native keyboard behavior.

import { describe, expect, it } from "vitest";

import {
  resolveDesktopMenuAccelerator,
  resolveDesktopWindowZoomAction,
  resolveKeyboardShortcutsMenuAccelerator,
} from "./menuShortcuts";

describe("resolveDesktopWindowZoomAction", () => {
  const windowsCtrlInput = {
    type: "keyDown",
    key: "",
    control: true,
    meta: false,
    shift: false,
    alt: false,
  };

  it("handles both physical minus keys as zoom-out on Windows", () => {
    expect(resolveDesktopWindowZoomAction("win32", { ...windowsCtrlInput, code: "Minus" })).toBe(
      "zoomOut",
    );
    expect(
      resolveDesktopWindowZoomAction("win32", {
        ...windowsCtrlInput,
        code: "NumpadSubtract",
      }),
    ).toBe("zoomOut");
  });

  it("uses the translated minus value for Windows layouts whose physical code is Slash", () => {
    expect(
      resolveDesktopWindowZoomAction("win32", {
        ...windowsCtrlInput,
        key: "-",
        code: "Slash",
      }),
    ).toBe("zoomOut");
  });

  it("does not intercept slash or modified minus chords", () => {
    expect(
      resolveDesktopWindowZoomAction("win32", { ...windowsCtrlInput, code: "Slash" }),
    ).toBeNull();
    expect(
      resolveDesktopWindowZoomAction("win32", {
        ...windowsCtrlInput,
        code: "Minus",
        shift: true,
      }),
    ).toBeNull();
    expect(
      resolveDesktopWindowZoomAction("win32", {
        ...windowsCtrlInput,
        code: "Minus",
        alt: true,
      }),
    ).toBeNull();
    expect(
      resolveDesktopWindowZoomAction("win32", {
        ...windowsCtrlInput,
        code: "Minus",
        meta: true,
      }),
    ).toBeNull();
  });

  it("only handles Windows Ctrl key-down events", () => {
    expect(
      resolveDesktopWindowZoomAction("win32", {
        ...windowsCtrlInput,
        type: "keyUp",
        code: "Minus",
      }),
    ).toBeNull();
    expect(
      resolveDesktopWindowZoomAction("win32", {
        ...windowsCtrlInput,
        control: false,
        code: "Minus",
      }),
    ).toBeNull();
    expect(
      resolveDesktopWindowZoomAction("darwin", { ...windowsCtrlInput, code: "Minus" }),
    ).toBeNull();
    expect(resolveDesktopWindowZoomAction("linux", { ...windowsCtrlInput, code: "Minus" })).toBe(
      "zoomOut",
    );
  });

  it("recognizes zoom in and reset across macOS and Windows modifiers", () => {
    expect(
      resolveDesktopWindowZoomAction("darwin", {
        ...windowsCtrlInput,
        control: false,
        meta: true,
        key: "+",
        code: "Equal",
        shift: true,
      }),
    ).toBe("zoomIn");
    expect(
      resolveDesktopWindowZoomAction("win32", {
        ...windowsCtrlInput,
        key: "0",
        code: "Digit0",
      }),
    ).toBe("reset");
  });
});

describe("resolveDesktopMenuAccelerator", () => {
  it("disables custom native menu accelerators on Linux", () => {
    expect(resolveDesktopMenuAccelerator("linux", "CmdOrCtrl+B")).toBeUndefined();
  });

  it("keeps custom native menu accelerators on macOS and Windows", () => {
    expect(resolveDesktopMenuAccelerator("darwin", "CmdOrCtrl+B")).toBe("CmdOrCtrl+B");
    expect(resolveDesktopMenuAccelerator("win32", "CmdOrCtrl+B")).toBe("CmdOrCtrl+B");
  });
});

describe("resolveKeyboardShortcutsMenuAccelerator", () => {
  it("uses the native shortcuts help accelerator on macOS", () => {
    expect(resolveKeyboardShortcutsMenuAccelerator("darwin")).toBe("Cmd+/");
  });

  it("does not assign a global shortcuts help accelerator outside macOS", () => {
    expect(resolveKeyboardShortcutsMenuAccelerator("win32")).toBeUndefined();
    expect(resolveKeyboardShortcutsMenuAccelerator("linux")).toBeUndefined();
  });
});
