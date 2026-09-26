import type { Input } from "electron";
import { isDesktopNewWindowShortcut } from "./menuShortcuts";

export type PanelShortcutCommand = "new-window" | "find" | "close";

/** Host shortcuts in the shell. Hosted App pages retain their own key handling. */
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

export function shouldInterceptShellShortcut(command: PanelShortcutCommand): boolean {
  return command !== "close";
}

export function shouldRouteShellPanelClose(
  platform: NodeJS.Platform,
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat">,
  insidePanel: boolean,
): boolean {
  const primary =
    platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return (
    insidePanel &&
    primary &&
    !event.shiftKey &&
    !event.altKey &&
    !event.repeat &&
    event.key.toLowerCase() === "w"
  );
}
