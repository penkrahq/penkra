// FILE: initialWindowVisibility.ts
// Purpose: Shows the initial desktop window exactly once after either supported readiness event.

export type InitialWindowReadySource = "ready-to-show" | "did-finish-load";

export function createInitialWindowPresenter(input: {
  window: {
    isDestroyed(): boolean;
    maximize(): void;
    show(): void;
  };
  maximize: boolean;
  onShown?: (source: InitialWindowReadySource) => void;
}): (source: InitialWindowReadySource) => void {
  let shown = false;
  return (source) => {
    if (shown || input.window.isDestroyed()) return;
    shown = true;
    if (input.maximize) input.window.maximize();
    input.window.show();
    input.onShown?.(source);
  };
}
