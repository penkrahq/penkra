import {
  type KeybindingCommand,
  type ResolvedKeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
  SPACE_JUMP_KEYBINDING_COMMANDS,
  type SpaceJumpKeybindingCommand,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type ThreadJumpKeybindingCommand,
} from "@penkra/contracts";
import { isKeyboardShortcutsHelpChord } from "@penkra/shared/browserShortcuts";
import { isMacPlatform, isWindowsPlatform } from "./lib/utils";

export interface ShortcutEventLike {
  type?: string;
  code?: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

export interface ShortcutMatchContext {
  [key: string]: boolean;
}

interface ShortcutMatchOptions {
  platform?: string;
  context?: Partial<ShortcutMatchContext>;
}

interface ResolvedShortcutLabelOptions extends ShortcutMatchOptions {
  platform?: string;
}

function commandShortcut(
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

export const DEFAULT_SHORTCUT_FALLBACKS: ResolvedKeybindingsConfig = [
  {
    command: "sidebar.addProject",
    shortcut: commandShortcut("o", { shiftKey: true }),
  },
  {
    command: "chat.new",
    shortcut: commandShortcut("n"),
  },
  {
    command: "chat.newLatestProject",
    shortcut: commandShortcut("n", { shiftKey: true }),
  },
  {
    command: "chat.newClaude",
    shortcut: commandShortcut("c", { altKey: true }),
  },
  {
    command: "chat.newChat",
    shortcut: commandShortcut("n", { altKey: true }),
  },
  {
    command: "chat.newCodex",
    shortcut: commandShortcut("x", { altKey: true }),
  },
  {
    command: "chat.newOpenCode",
    shortcut: commandShortcut("r", { altKey: true }),
  },
  {
    command: "view.recent.next",
    shortcut: commandShortcut("tab", { ctrlKey: true, modKey: false }),
  },
  {
    command: "view.recent.previous",
    shortcut: commandShortcut("tab", { ctrlKey: true, shiftKey: true, modKey: false }),
  },
  {
    command: "modelPicker.toggle",
    shortcut: commandShortcut("m", { shiftKey: true }),
  },
  {
    command: "model.next",
    shortcut: commandShortcut("]", { altKey: true, modKey: false }),
  },
  {
    command: "model.previous",
    shortcut: commandShortcut("[", { altKey: true, modKey: false }),
  },
  {
    command: "traitsPicker.toggle",
    shortcut: commandShortcut("e", { shiftKey: true }),
  },
  {
    command: "composer.focus.toggle",
    shortcut: commandShortcut("l", { metaKey: true, modKey: false }),
  },
  {
    command: "settings.usage",
    shortcut: commandShortcut("u", { shiftKey: true }),
  },
  ...SPACE_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    command,
    shortcut: commandShortcut(String(index + 1), { altKey: true }),
  })),
  {
    command: "thread.jump.1",
    shortcut: commandShortcut("1"),
  },
  {
    command: "thread.jump.2",
    shortcut: commandShortcut("2"),
  },
  {
    command: "thread.jump.3",
    shortcut: commandShortcut("3"),
  },
  {
    command: "thread.jump.4",
    shortcut: commandShortcut("4"),
  },
  {
    command: "thread.jump.5",
    shortcut: commandShortcut("5"),
  },
  {
    command: "thread.jump.6",
    shortcut: commandShortcut("6"),
  },
  {
    command: "thread.jump.7",
    shortcut: commandShortcut("7"),
  },
  {
    command: "thread.jump.8",
    shortcut: commandShortcut("8"),
  },
  {
    command: "thread.jump.9",
    shortcut: commandShortcut("9"),
  },
];
const EVENT_CODE_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  BracketLeft: ["["],
  BracketRight: ["]"],
  Digit0: ["0"],
  Digit1: ["1"],
  Digit2: ["2"],
  Digit3: ["3"],
  Digit4: ["4"],
  Digit5: ["5"],
  Digit6: ["6"],
  Digit7: ["7"],
  Digit8: ["8"],
  Digit9: ["9"],
  KeyA: ["a"],
  KeyB: ["b"],
  KeyC: ["c"],
  KeyD: ["d"],
  KeyE: ["e"],
  KeyF: ["f"],
  KeyG: ["g"],
  KeyH: ["h"],
  KeyI: ["i"],
  KeyJ: ["j"],
  KeyK: ["k"],
  KeyL: ["l"],
  KeyM: ["m"],
  KeyN: ["n"],
  KeyO: ["o"],
  KeyP: ["p"],
  KeyQ: ["q"],
  KeyR: ["r"],
  KeyS: ["s"],
  KeyT: ["t"],
  KeyU: ["u"],
  KeyV: ["v"],
  KeyW: ["w"],
  KeyX: ["x"],
  KeyY: ["y"],
  KeyZ: ["z"],
};

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  if (normalized === "{") return "[";
  if (normalized === "}") return "]";
  return normalized;
}

function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const keys = new Set([normalizeEventKey(event.key)]);
  const aliases = event.code ? EVENT_CODE_KEY_ALIASES[event.code] : undefined;
  if (!aliases) return keys;

  for (const alias of aliases) {
    keys.add(alias);
  }
  return keys;
}

function matchesShortcutModifiers(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  if (!matchesShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}

function resolvePlatform(options: ShortcutMatchOptions | undefined): string {
  return options?.platform ?? navigator.platform;
}

function resolveContext(options: ShortcutMatchOptions | undefined): ShortcutMatchContext {
  // `isMac` is derived from the resolved platform so `when` clauses can gate on it
  // (e.g. `whenCreationAllowed`) without every dispatch site having to thread the flag
  // through `context`. An explicit `context.isMac` still wins via the spread below.
  return {
    isMac: isMacPlatform(resolvePlatform(options)),
    ...options?.context,
  };
}

function evaluateWhenNode(node: KeybindingWhenNode, context: ShortcutMatchContext): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
}

function matchesWhenClause(
  whenAst: KeybindingWhenNode | undefined,
  context: ShortcutMatchContext,
): boolean {
  if (!whenAst) return true;
  return evaluateWhenNode(whenAst, context);
}

function shortcutConflictKey(shortcut: KeybindingShortcut, platform = navigator.platform): string {
  const useMetaForMod = isMacPlatform(platform);
  const metaKey = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const ctrlKey = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);

  return [
    shortcut.key,
    metaKey ? "meta" : "",
    ctrlKey ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}

function findEffectiveShortcutForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): KeybindingShortcut | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const claimedShortcuts = new Set<string>();

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;

    const conflictKey = shortcutConflictKey(binding.shortcut, platform);
    if (claimedShortcuts.has(conflictKey)) {
      continue;
    }

    claimedShortcuts.add(conflictKey);
    if (binding.command === command) {
      return binding.shortcut;
    }
  }

  return null;
}

function matchesCommandShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): boolean {
  return resolveShortcutCommand(event, keybindings, options) === command;
}

function resolveShortcutCommandFromBindings(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    if (!matchesShortcut(event, binding.shortcut, platform)) continue;
    return binding.command;
  }

  return null;
}

function getFallbackBindings(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<ResolvedKeybindingRule> {
  const configuredCommands = new Set(keybindings.map((binding) => binding.command));
  return DEFAULT_SHORTCUT_FALLBACKS.filter((binding) => !configuredCommands.has(binding.command));
}

export function resolveShortcutCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): string | null {
  const explicitCommand = resolveShortcutCommandFromBindings(event, keybindings, options);
  if (explicitCommand !== null) {
    return explicitCommand;
  }

  const fallbackBindings = getFallbackBindings(keybindings);
  if (fallbackBindings.length === 0) {
    return null;
  }

  return resolveShortcutCommandFromBindings(event, fallbackBindings, options);
}

function formatShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "Up";
  if (key === "arrowdown") return "Down";
  if (key === "arrowleft") return "Left";
  if (key === "arrowright") return "Right";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const useMetaForMod = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  const showAlt = shortcut.altKey;
  const showShift = shortcut.shiftKey;

  if (useMetaForMod) {
    return `${showCtrl ? "\u2303" : ""}${showAlt ? "\u2325" : ""}${showShift ? "\u21e7" : ""}${showMeta ? "\u2318" : ""}${keyLabel}`;
  }

  const parts: string[] = [];
  if (showCtrl) parts.push("Ctrl");
  if (showAlt) parts.push("Alt");
  if (showShift) parts.push("Shift");
  if (showMeta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

const MODIFIER_SYMBOLS = new Set(["⌘", "⌥", "⌃", "⇧"]);

export function splitShortcutLabel(shortcutLabel: string): string[] {
  if (shortcutLabel.includes("+")) {
    return shortcutLabel
      .split("+")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  if ([...shortcutLabel].some((char) => MODIFIER_SYMBOLS.has(char))) {
    const parts = [...shortcutLabel];
    const key = parts
      .filter((char) => !MODIFIER_SYMBOLS.has(char))
      .join("")
      .trim();
    const modifiers = parts.filter((char) => MODIFIER_SYMBOLS.has(char));
    return key.length > 0 ? [...modifiers, key] : modifiers;
  }

  return [shortcutLabel];
}

export function shortcutLabelForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: string | ResolvedShortcutLabelOptions,
): string | null {
  const resolvedOptions =
    typeof options === "string"
      ? ({ platform: options } satisfies ResolvedShortcutLabelOptions)
      : options;
  const platform = resolvePlatform(resolvedOptions);
  const contextProvided = resolvedOptions?.context !== undefined;

  if (!contextProvided) {
    // Honor platform-gated `when` clauses (e.g. `isMac` / `!isMac`) using default
    // focus flags so labels stay correct without a full UI context.
    const platformAware = findEffectiveShortcutForCommand(keybindings, command, { platform });
    if (platformAware) {
      return formatShortcutLabel(platformAware, platform);
    }
    for (let index = keybindings.length - 1; index >= 0; index -= 1) {
      const binding = keybindings[index];
      if (!binding || binding.command !== command) continue;
      return formatShortcutLabel(binding.shortcut, platform);
    }
    for (const binding of getFallbackBindings(keybindings)) {
      if (binding.command !== command) continue;
      return formatShortcutLabel(binding.shortcut, platform);
    }
    return null;
  }

  const shortcut = findEffectiveShortcutForCommand(keybindings, command, resolvedOptions);
  if (shortcut) {
    return formatShortcutLabel(shortcut, platform);
  }

  const fallbackShortcut = findEffectiveShortcutForCommand(
    getFallbackBindings(keybindings),
    command,
    resolvedOptions,
  );
  return fallbackShortcut ? formatShortcutLabel(fallbackShortcut, platform) : null;
}

export function threadJumpCommandForIndex(index: number): ThreadJumpKeybindingCommand | null {
  return THREAD_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function threadJumpIndexFromCommand(command: string): number | null {
  const index = THREAD_JUMP_KEYBINDING_COMMANDS.indexOf(command as ThreadJumpKeybindingCommand);
  return index === -1 ? null : index;
}

export function spaceJumpCommandForIndex(index: number): SpaceJumpKeybindingCommand | null {
  return SPACE_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function spaceJumpIndexFromCommand(command: string): number | null {
  const index = SPACE_JUMP_KEYBINDING_COMMANDS.indexOf(command as SpaceJumpKeybindingCommand);
  return index === -1 ? null : index;
}

export function shouldShowThreadJumpHints(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  const platform = resolvePlatform(options);
  const fallbackBindings = getFallbackBindings(keybindings);

  for (const command of THREAD_JUMP_KEYBINDING_COMMANDS) {
    const shortcut =
      findEffectiveShortcutForCommand(keybindings, command, options) ??
      findEffectiveShortcutForCommand(fallbackBindings, command, options);
    if (!shortcut) continue;
    if (matchesShortcutModifiers(event, shortcut, platform)) {
      return true;
    }
  }

  return false;
}

export function isSidebarToggleShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "sidebar.toggle", options);
}

export function isChatNewShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "chat.new", options);
}

export function isChatNewChatShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return (
    matchesCommandShortcut(event, keybindings, "chat.newChat", options) ||
    matchesCommandShortcut(event, keybindings, "chat.newLocal", options)
  );
}

export function isOpenFavoriteEditorShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "editor.openFavorite", options);
}

export function isKeyboardShortcutsHelpShortcut(
  event: ShortcutEventLike,
  platform = navigator.platform,
): boolean {
  return isKeyboardShortcutsHelpChord(
    {
      key: event.key,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      ...(event.type !== undefined ? { type: event.type } : {}),
      ...(event.code !== undefined ? { code: event.code } : {}),
      ...(event.repeat !== undefined ? { repeat: event.repeat } : {}),
    },
    {
      isMac: isMacPlatform(platform),
      isWindows: isWindowsPlatform(platform),
    },
  );
}
