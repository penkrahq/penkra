// FILE: chatPaneScope.ts
// Purpose: Single source for chat pane scope ids — the `data-chat-pane-scope`
//          attribute contract shared by ChatView (which stamps the attribute on
//          the composer form), the chat route (which assigns scopes to panes),
//          and panelResize's composer probe (which queries by scope).
// Layer: Web chat-surface contracts (no runtime logic beyond string building).

/** The full-width single chat pane (also ChatView's default scope). */
export const SINGLE_CHAT_PANE_SCOPE_ID = "single";

/** A chat pane inside a split view. */
export function splitViewPaneScopeId(splitViewId: string, paneId: string): string {
  return `${splitViewId}:${paneId}`;
}
