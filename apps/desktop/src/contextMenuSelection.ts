// FILE: contextMenuSelection.ts
// Purpose: Arbitrates Electron menu click/close callback ordering without dropping selections.

export interface ContextMenuSelection<T extends string> {
  readonly result: Promise<T | null>;
  readonly select: (id: T) => void;
  readonly dismiss: () => void;
}

export function createContextMenuSelection<T extends string>(
  scheduleDismissal: (callback: () => void) => void = (callback) =>
    globalThis.setTimeout(callback, 0),
): ContextMenuSelection<T> {
  let selectedId: T | null = null;
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
      selectedId = id;
      settle(id);
    },
    dismiss: () => {
      // Electron can report popup closure before dispatching the item's click callback.
      // Give that callback one event-loop turn before treating this as a dismissal.
      scheduleDismissal(() => settle(selectedId));
    },
  };
}
