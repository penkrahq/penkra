// FILE: shortcutsSheet.test.ts
// Purpose: Verify the shortcuts sheet builder reflects current context and dynamic script bindings.
// Layer: UI helper tests

import { describe, expect, it } from "vitest";

import { buildShortcutSheetSections } from "./shortcutsSheet";
import type {} from "./types";

describe("buildShortcutSheetSections", () => {
  it("includes the help shortcut and current thread jumps outside workspace mode", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [],
      platform: "MacIntel",
      context: {},
    });

    expect(sections[0]?.entries.some((entry) => entry.id === "shortcuts.show")).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "thread.jump.1" && entry.shortcutLabel === "⌘1",
      ),
    ).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "composer.focus.toggle" && entry.shortcutLabel === "⌘L",
      ),
    ).toBe(true);
  });

  it("does not surface removed terminal shortcuts from legacy context", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [],
      platform: "Linux",
      context: {},
    });

    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "thread.jump.1" && entry.shortcutLabel === "Ctrl+1",
      ),
    ).toBe(true);
    expect(
      sections
        .flatMap((section) => section.entries)
        .some((entry) => entry.id.startsWith("terminal.")),
    ).toBe(false);
  });

  it("falls back to the legacy new-chat alias when needed", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [
        {
          command: "chat.newLocal",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: true,
          },
        },
      ],
      platform: "MacIntel",
      context: {},
    });

    expect(
      sections[0]?.entries.some(
        (entry) => entry.label === "New chat" && entry.shortcutLabel === "⌥⌘N",
      ),
    ).toBe(true);
  });

  it("lists the sidebar toggle regardless of platform", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [
        {
          command: "sidebar.toggle",
          shortcut: {
            key: "b",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
          },
        },
      ],
      platform: "Linux",
      context: {},
    });

    expect(sections[0]?.entries.some((entry) => entry.id === "sidebar.toggle")).toBe(true);
  });
});
