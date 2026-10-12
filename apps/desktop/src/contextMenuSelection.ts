// FILE: contextMenuSelection.ts
// Purpose: Settle selection before Electron's post-selection popup close callback.
// Electron macOS posts popupCloseCallback after itemSelected:
// https://github.com/electron/electron/blob/v44.4.1/shell/browser/ui/cocoa/electron_menu_controller.mm#L643-L650
// Chromium executes the command before its menu-closed delegate:
// https://github.com/chromium/chromium/blob/152.0.7977.78/ui/views/controls/menu/menu_runner_impl.cc#L233-L243

export interface ContextMenuSelection<T extends string> {
  readonly result: Promise<T | null>;
  readonly select: (id: T) => void;
  readonly dismiss: () => void;
}

export function createContextMenuSelection<T extends string>(): ContextMenuSelection<T> {
  let settled = false;
  let resolveResult: (value: T | null) => void = () => undefined;
  const result = new Promise<T | null>((resolve) => {
    resolveResult = resolve;
  });
  const settle = (value: T | null) => {
    if (settled) return;
    settled = true;
    resolveResult(value);
  };
  return {
    result,
    select: (id) => {
      settle(id);
    },
    dismiss: () => {
      settle(null);
    },
  };
}
