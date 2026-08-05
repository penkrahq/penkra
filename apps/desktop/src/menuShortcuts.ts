// FILE: menuShortcuts.ts
// Purpose: Keeps native desktop menu accelerators consistent across operating systems.
// Layer: Desktop main-process helper
// Exports: menu accelerator resolvers

import type { MenuItemConstructorOptions } from "electron";

export interface DesktopKeyboardInput {
  type: string;
  key: string;
  code?: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export type DesktopWindowZoomAction = "reset" | "zoomIn" | "zoomOut" | null;

export function resolveDesktopWindowZoomAction(
  platform: NodeJS.Platform,
  input: DesktopKeyboardInput,
): DesktopWindowZoomAction {
  const usesMeta = platform === "darwin";
  const hasPrimaryModifier = usesMeta ? input.meta && !input.control : input.control && !input.meta;
  if (input.type !== "keyDown" || !hasPrimaryModifier || input.alt) {
    return null;
  }

  const isMinusKey = input.key === "-" || input.code === "Minus" || input.code === "NumpadSubtract";
  if (isMinusKey && !input.shift) return "zoomOut";
  const isPlusKey =
    input.key === "+" || input.key === "=" || input.code === "Equal" || input.code === "NumpadAdd";
  if (isPlusKey) return "zoomIn";
  const isZeroKey = input.key === "0" || input.code === "Digit0" || input.code === "Numpad0";
  return isZeroKey && !input.shift ? "reset" : null;
}

export function resolveDesktopMenuAccelerator(
  platform: NodeJS.Platform,
  accelerator: MenuItemConstructorOptions["accelerator"],
): MenuItemConstructorOptions["accelerator"] | undefined {
  // Several Linux desktops surface Electron menu accelerators as noisy native
  // keybinding notifications; the web app handles these shortcuts itself.
  return platform === "linux" ? undefined : accelerator;
}

export function resolveKeyboardShortcutsMenuAccelerator(
  platform: NodeJS.Platform,
): MenuItemConstructorOptions["accelerator"] | undefined {
  // Windows Electron can treat Ctrl+- as Ctrl+/ on some keyboard layouts,
  // which steals the native zoom-out accelerator before the page receives it.
  return platform === "darwin" ? "Cmd+/" : undefined;
}
