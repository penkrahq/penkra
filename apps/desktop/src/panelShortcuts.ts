import type { Input } from "electron";
import { isDesktopNewWindowShortcut } from "./menuShortcuts";

export type PanelShortcutCommand = "new-window" | "find" | "close";

/** Host-controlled shortcut chords; shell W is gated at DOM capture time. */
export function resolvePanelShortcut(
  platform: NodeJS.Platform,
  input: Input,
): PanelShortcutCommand | null {
  if (input.type !== "keyDown" || input.isAutoRepeat || input.alt) return null;
  if (isDesktopNewWindowShortcut(platform, input)) return "new-window";
  const primary =
    platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (!primary || input.shift) return null;
  const key = input.key.toLowerCase();
  if (key === "f") return "find";
  if (key === "w") return "close";
  return null;
}

export type PanelShortcutEffect =
  | { readonly kind: "new-window" }
  | { readonly kind: "open-find" }
  | { readonly kind: "close-panel-tab"; readonly deckId: string }
  | { readonly kind: "none" };

/**
 * Turns a resolved chord into the effect it should have in the window that
 * received it. `close` targets the selected panel tab only while the panel is
 * focused; otherwise existing shortcut handlers keep the key. The panel
 * focus check lives here so every platform shares one tested decision.
 */
export function resolvePanelShortcutEffect(
  command: PanelShortcutCommand,
  panelFocused: boolean,
  deckId: string | null,
): PanelShortcutEffect {
  if (command === "new-window") return { kind: "new-window" };
  if (command === "find") return { kind: "open-find" };
  if (!panelFocused) return { kind: "none" };
  return deckId === null || deckId.length === 0
    ? { kind: "none" }
    : { kind: "close-panel-tab", deckId };
}

/** The shell handles W at DOM capture time, after identifying the actual key target. */
export function isShellPanelCloseShortcut(
  platform: NodeJS.Platform,
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat">,
): boolean {
  const primary =
    platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return (
    primary && !event.shiftKey && !event.altKey && !event.repeat && event.key.toLowerCase() === "w"
  );
}

export function shouldRouteShellPanelClose(
  platform: NodeJS.Platform,
  event: Parameters<typeof isShellPanelCloseShortcut>[1],
  insidePanel: boolean,
): boolean {
  return insidePanel && isShellPanelCloseShortcut(platform, event);
}

/** Leave an unfocused panel's W with its existing renderer, terminal, or menu handler. */
export function preventBeforeInputShortcut(
  event: Pick<Electron.Event, "preventDefault">,
  command: PanelShortcutCommand,
  panelFocused: boolean,
  fromShell: boolean,
): boolean {
  if (command === "close" && (!panelFocused || fromShell)) return false;
  event.preventDefault();
  return true;
}
