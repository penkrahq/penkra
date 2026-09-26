/** User interaction in the right dock, scoped to a shell WebContents ID. */
export class PanelFocusState {
  readonly #byWindow = new Map<number, boolean>();

  get(windowId: number): boolean {
    return this.#byWindow.get(windowId) ?? false;
  }

  recordInteraction(windowId: number, insidePanel: boolean): void {
    this.#byWindow.set(windowId, insidePanel);
  }

  shouldPreserveAgentOpen(windowId: number, windowIsFocused: boolean): boolean {
    return windowIsFocused && this.get(windowId);
  }

  agentSwitchedPanel(windowId: number, windowIsFocused: boolean): void {
    if (!windowIsFocused) this.#byWindow.set(windowId, false);
  }

  delete(windowId: number): void {
    this.#byWindow.delete(windowId);
  }
}

/** Shared main-process instance for shell windows and agent tab presentation. */
export const panelFocusState = new PanelFocusState();
