const STATIC_KEYBINDING_COMMANDS = [
  "sidebar.toggle",
  "sidebar.search",
  "sidebar.addProject",
  "sidebar.importThread",
  "space.previous",
  "space.next",
  "space.jump.1",
  "space.jump.2",
  "space.jump.3",
  "space.jump.4",
  "space.jump.5",
  "space.jump.6",
  "space.jump.7",
  "space.jump.8",
  "space.jump.9",
  "composer.focus.toggle",
  "modelPicker.toggle",
  "model.next",
  "model.previous",
  "traitsPicker.toggle",
  "settings.usage",
  "chat.new",
  "chat.newLatestProject",
  "chat.newChat",
  "chat.newLocal",
  "chat.newClaude",
  "chat.newCodex",
  "chat.newOpenCode",
  "view.recent.next",
  "view.recent.previous",
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
  "chat.visible.next",
  "chat.visible.previous",
  "editor.openFavorite",
  "chat.search",
] as const;

// Shared list of numbered thread-jump commands used by the web shortcut UI.
export const THREAD_JUMP_KEYBINDING_COMMANDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const;
export type ThreadJumpKeybindingCommand = (typeof THREAD_JUMP_KEYBINDING_COMMANDS)[number];

// Shared list of numbered Space-jump commands used by the web shortcut UI.
export const SPACE_JUMP_KEYBINDING_COMMANDS = [
  "space.jump.1",
  "space.jump.2",
  "space.jump.3",
  "space.jump.4",
  "space.jump.5",
  "space.jump.6",
  "space.jump.7",
  "space.jump.8",
  "space.jump.9",
] as const;
export type SpaceJumpKeybindingCommand = (typeof SPACE_JUMP_KEYBINDING_COMMANDS)[number];

export type KeybindingCommand = (typeof STATIC_KEYBINDING_COMMANDS)[number];
export interface KeybindingRule {
  readonly key: string;
  readonly command: KeybindingCommand;
  readonly when?: string;
}
export interface KeybindingShortcut {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly modKey: boolean;
}
export type KeybindingWhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: KeybindingWhenNode }
  | { type: "and"; left: KeybindingWhenNode; right: KeybindingWhenNode }
  | { type: "or"; left: KeybindingWhenNode; right: KeybindingWhenNode };
export interface ResolvedKeybindingRule {
  readonly command: KeybindingCommand;
  readonly shortcut: KeybindingShortcut;
  readonly whenAst?: KeybindingWhenNode;
}
export type ResolvedKeybindingsConfig = ReadonlyArray<ResolvedKeybindingRule>;
