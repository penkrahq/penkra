// FILE: findVisibility.ts
// Purpose: Decides whether a mounted search surface belongs to a currently open view.
// Layer: Web application infrastructure
// Exports: isFindSurfaceVisible

export function isFindSurfaceVisible(element: HTMLElement | null): element is HTMLElement {
  if (
    !element ||
    !element.isConnected ||
    element.getClientRects().length === 0 ||
    element.closest("[aria-hidden='true'], [inert], [hidden]")
  ) {
    return false;
  }

  return element.checkVisibility({
    checkOpacity: true,
    checkVisibilityCSS: true,
  });
}
