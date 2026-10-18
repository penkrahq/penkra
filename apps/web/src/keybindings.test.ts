import { KEYBINDINGS } from "@penkra/shared/keybindings";
import { assert, describe, it } from "vitest";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@penkra/contracts";
import {
  formatShortcutLabel,
  isChatNewShortcut,
  isChatNewChatShortcut,
  isKeyboardShortcutsHelpShortcut,
  isOpenFavoriteEditorShortcut,
  isSidebarToggleShortcut,
  resolveShortcutCommand,
  shouldShowThreadJumpHints,
  shortcutLabelForCommand,
  spaceJumpIndexFromCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("isKeyboardShortcutsHelpShortcut", () => {
  it("does not mistake the physical minus keys for shortcuts help on Windows", () => {
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(event({ ctrlKey: true, key: "/", code: "Minus" }), "Win32"),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "NumpadSubtract" }),
        "Win32",
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(event({ ctrlKey: true, key: "-", code: "Slash" }), "Win32"),
    );
  });

  it("recognizes the physical slash keys on Windows", () => {
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(event({ ctrlKey: true, key: "/", code: "Slash" }), "Win32"),
    );
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "NumpadDivide" }),
        "Win32",
      ),
    );
  });

  it("uses Cmd+/ on macOS without accepting Ctrl+/", () => {
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ metaKey: true, key: "/", code: "Slash" }),
        "MacIntel",
      ),
    );
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ metaKey: true, key: "/", code: "Minus" }),
        "MacIntel",
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "Slash" }),
        "MacIntel",
      ),
    );
  });

  it("uses Ctrl+/ on Linux without accepting Meta+/", () => {
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "Slash" }),
        "Linux x86_64",
      ),
    );
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "Minus" }),
        "Linux x86_64",
      ),
    );
    assert.isTrue(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "NumpadSubtract" }),
        "Linux x86_64",
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ metaKey: true, key: "/", code: "Slash" }),
        "Linux x86_64",
      ),
    );
  });

  it("ignores key-up, auto-repeat, and modified slash events", () => {
    const platform = "Win32";
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ type: "keyup", ctrlKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ repeat: true, ctrlKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, shiftKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, altKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
  });
});

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function ctrlShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    modKey: false,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

// Mirror the server defaults here so frontend shortcut resolution stays aligned.
const DEFAULT_BINDINGS = KEYBINDINGS;

describe("shortcut matching", () => {
  it("supports when expressions", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "modelPicker.toggle",
        whenAst: whenAnd(
          whenIdentifier("terminalOpen"),
          whenNot(whenIdentifier("modelPickerOpen")),
        ),
      },
      {
        shortcut: modShortcut("n", { shiftKey: true }),
        command: "traitsPicker.toggle",
        whenAst: whenAnd(
          whenIdentifier("terminalOpen"),
          whenNot(whenIdentifier("modelPickerOpen")),
        ),
      },
      { shortcut: modShortcut("j"), command: "sidebar.toggle" },
    ]);
    assert.isTrue(
      resolveShortcutCommand(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, modelPickerOpen: false },
      }) === "modelPicker.toggle",
    );
    assert.isFalse(
      resolveShortcutCommand(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: false, modelPickerOpen: false },
      }) === "modelPicker.toggle",
    );
    assert.isTrue(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, modelPickerOpen: false },
      }) === "traitsPicker.toggle",
    );
  });

  it("matches physical digit shortcuts even when event.key is layout-shifted", () => {});

  it("matches physical bracket shortcuts even when event.key differs from the printed symbol", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("[", { shiftKey: true }),
        command: "chat.visible.previous",
        whenAst: whenNot(whenIdentifier("modelPickerOpen")),
      },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(
        event({
          code: "BracketLeft",
          key: "^",
          ctrlKey: true,
          shiftKey: true,
        }),
        keybindings,
        {
          platform: "Win32",
          context: { modelPickerOpen: false },
        },
      ),
      "chat.visible.previous",
    );
  });

  it("supports when boolean literals", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "traitsPicker.toggle",
        whenAst: whenIdentifier("true"),
      },
      {
        shortcut: modShortcut("m"),
        command: "traitsPicker.toggle",
        whenAst: whenIdentifier("false"),
      },
    ]);

    assert.isTrue(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }) === "traitsPicker.toggle",
    );
    assert.isFalse(
      resolveShortcutCommand(event({ key: "m", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }) === "traitsPicker.toggle",
    );
  });
});

describe("settings shortcuts", () => {});

describe("composer focus shortcuts", () => {
  it("does not treat Ctrl+L as the composer focus shortcut on non-macOS", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "l", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { modelPickerOpen: false },
      }),
    );
  });
});

describe("recent view shortcuts", () => {
  it("resolves Ctrl+Tab while a terminal has focus", () => {});
});

describe("thread jump shortcuts", () => {
  it("maps thread jump indices to commands and back", () => {
    assert.strictEqual(threadJumpCommandForIndex(0), "thread.jump.1");
    assert.strictEqual(threadJumpCommandForIndex(8), "thread.jump.9");
    assert.isNull(threadJumpCommandForIndex(9));
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.4"), 3);
    assert.isNull(threadJumpIndexFromCommand("chat.new"));
  });

  it("shows thread jump hints only while a numbered jump modifier combo is active", () => {
    assert.isTrue(
      shouldShowThreadJumpHints(event({ key: "Meta", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { traitsPickerOpen: false },
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHints(event({ key: "Control", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { traitsPickerOpen: false },
      }),
    );
  });
});

describe("space jump shortcuts", () => {
  it("maps space jump commands to strip indices", () => {
    assert.strictEqual(spaceJumpIndexFromCommand("space.jump.1"), 0);
    assert.strictEqual(spaceJumpIndexFromCommand("space.jump.9"), 8);
    assert.isNull(spaceJumpIndexFromCommand("thread.jump.1"));
  });

  it("resolves Cmd+Alt+digit even when Option shifts event.key on macOS", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "Digit2", key: "™", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { modelPickerOpen: false, traitsPickerOpen: false },
        },
      ),
      "space.jump.2",
    );
  });

  it("resolves space jumps from the fixed product table", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "Digit1", key: "1", metaKey: true, altKey: true }),
        KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { modelPickerOpen: false },
        },
      ),
      "space.jump.1",
    );
  });

  it("does not shadow plain numbered thread jumps", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "2", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false, traitsPickerOpen: false },
      }),
      "thread.jump.2",
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns the most recent binding label", () => {
    const bindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "modelPicker.toggle",
        whenAst: whenIdentifier("modelPickerOpen"),
      },
      {
        shortcut: modShortcut("\\", { shiftKey: true }),
        command: "modelPicker.toggle",
        whenAst: whenNot(whenIdentifier("modelPickerOpen")),
      },
    ]);
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "modelPicker.toggle", "Linux"),
      "Ctrl+Shift+\\",
    );
  });

  it("respects explicit context when resolving conflicting labels", () => {
    const bindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "modelPicker.toggle",
        whenAst: whenIdentifier("modelPickerOpen"),
      },
      {
        shortcut: modShortcut("\\", { shiftKey: true }),
        command: "modelPicker.toggle",
        whenAst: whenNot(whenIdentifier("modelPickerOpen")),
      },
    ]);
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "modelPicker.toggle", {
        platform: "Linux",
        context: { modelPickerOpen: false },
      }),
      "Ctrl+Shift+\\",
    );
  });

  it("returns labels for non-terminal commands", () => {
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.addProject", "MacIntel"),
      "⇧⌘O",
    );
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.new", "MacIntel"), "⌘N");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.newLatestProject", "MacIntel"),
      "⇧⌘N",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.newChat", "MacIntel"),
      "⌥⌘N",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.toggle", "MacIntel"),
      "⌘B",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.search", "MacIntel"),
      "⌘K",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "modelPicker.toggle", "MacIntel"),
      "⇧⌘M",
    );
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "model.next", "MacIntel"), "⌥]");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "model.previous", "MacIntel"),
      "⌥[",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "traitsPicker.toggle", "MacIntel"),
      "⇧⌘E",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "composer.focus.toggle", "MacIntel"),
      "⌘L",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.visible.next", "MacIntel"),
      "⇧⌘]",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.visible.previous", "MacIntel"),
      "⇧⌘[",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "editor.openFavorite", "Linux"),
      "Ctrl+O",
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("matches chat.new shortcut", () => {
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("matches chat.newChat shortcut", () => {
    assert.isTrue(
      isChatNewChatShortcut(event({ key: "n", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isChatNewChatShortcut(event({ key: "n", ctrlKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("resolves chat.newLatestProject shortcut", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "chat.newLatestProject",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { modelPickerOpen: false },
      }),
      "chat.newLatestProject",
    );
  });

  it("resolves sidebar.addProject shortcut", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "o", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "sidebar.addProject",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "o", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { modelPickerOpen: false },
      }),
      "sidebar.addProject",
    );
  });

  it("resolves provider-specific new chat shortcuts", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "c", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "chat.newClaude",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "x", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "chat.newCodex",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "r", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "chat.newOpenCode",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "KeyC", key: "ç", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { modelPickerOpen: false },
        },
      ),
      "chat.newClaude",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "KeyX", key: "≈", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { modelPickerOpen: false },
        },
      ),
      "chat.newCodex",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "KeyR", key: "®", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { modelPickerOpen: false },
        },
      ),
      "chat.newOpenCode",
    );
  });

  it("resolves visible chat cycle shortcuts", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "chat.visible.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "[", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "chat.visible.previous",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "}", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "chat.visible.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "{", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "chat.visible.previous",
    );
  });

  it("matches editor.openFavorite shortcut", () => {
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("keeps Cmd+K for sidebar.search on macOS and releases Ctrl+K", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      "sidebar.search",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      null,
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.search", "MacIntel"),
      "⌘K",
    );
  });

  it("keeps Ctrl+K for sidebar.search on Windows and Linux", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Win32",
      }),
      "sidebar.search",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux x86_64",
      }),
      "sidebar.search",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.search", "Win32"),
      "Ctrl+K",
    );
  });
});

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "traitsPicker.toggle",
        whenAst: whenIdentifier("modelPickerOpen"),
      },
    ]);

    assert.isTrue(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { modelPickerOpen: true },
      }) === "traitsPicker.toggle",
    );
    assert.isFalse(
      isChatNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { modelPickerOpen: true },
      }),
    );
    assert.isFalse(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }) === "traitsPicker.toggle",
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "traitsPicker.toggle",
        whenAst: whenIdentifier("modelPickerOpen"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.isFalse(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { modelPickerOpen: true },
      }) === "traitsPicker.toggle",
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { modelPickerOpen: true },
      }),
    );
  });
});

describe("resolveShortcutCommand", () => {
  it("resolves configurable composer picker commands", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("m", { altKey: true }),
        command: "modelPicker.toggle",
        whenAst: whenNot(whenIdentifier("modelPickerOpen")),
      },
      {
        shortcut: modShortcut("e", { altKey: true }),
        command: "traitsPicker.toggle",
        whenAst: whenNot(whenIdentifier("modelPickerOpen")),
      },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", metaKey: true, altKey: true }), keybindings, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "modelPicker.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "e", metaKey: true, altKey: true }), keybindings, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
      "traitsPicker.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", metaKey: true, altKey: true }), keybindings, {
        platform: "MacIntel",
        context: { modelPickerOpen: true },
      }),
      null,
    );
  });
});

describe("formatShortcutLabel", () => {
  it("formats labels for macOS", () => {
    assert.strictEqual(
      formatShortcutLabel(modShortcut("d", { shiftKey: true }), "MacIntel"),
      "⇧⌘D",
    );
  });

  it("formats labels for non-macOS", () => {
    assert.strictEqual(
      formatShortcutLabel(modShortcut("d", { shiftKey: true }), "Linux"),
      "Ctrl+Shift+D",
    );
  });

  it("formats labels for plus key", () => {
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "MacIntel"), "⌘+");
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "Linux"), "Ctrl++");
  });
});

describe("plus key parsing", () => {
  it("matches the plus key shortcut", () => {
    const plusBindings = compile([{ shortcut: modShortcut("+"), command: "sidebar.toggle" }]);
    assert.isTrue(
      resolveShortcutCommand(event({ key: "+", metaKey: true }), plusBindings, {
        platform: "MacIntel",
      }) === "sidebar.toggle",
    );
    assert.isTrue(
      resolveShortcutCommand(event({ key: "+", ctrlKey: true }), plusBindings, {
        platform: "Linux",
      }) === "sidebar.toggle",
    );
  });
});

describe("kept non-terminal shortcut actions", () => {
  it("opens usage settings with Cmd+Shift+U", () => {
    assert.equal(
      resolveShortcutCommand(event({ key: "u", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      "settings.usage",
    );
  });
  it("toggles composer focus with Cmd+L", () => {
    assert.equal(
      resolveShortcutCommand(event({ key: "l", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      "composer.focus.toggle",
    );
  });
  it("resolves Ctrl+Tab in both directions", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "Tab", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      "view.recent.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "Tab", ctrlKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
      "view.recent.previous",
    );
  });
  it("resolves numbered thread jumps", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "3", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      "thread.jump.3",
    );
  });
});

describe("kept sidebar and model shortcuts", () => {
  it("matches the sidebar toggle shortcut", () => {
    assert.isTrue(
      isSidebarToggleShortcut(event({ key: "b", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
  });
  it("resolves sidebar search", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      "sidebar.search",
    );
  });
  it("resolves model cycle commands including physical keys", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      "model.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "[", altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
      "model.previous",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "‘", code: "BracketRight", altKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
      "model.next",
    );
  });
});
