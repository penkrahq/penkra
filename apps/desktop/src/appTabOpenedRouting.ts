// FILE: appTabOpenedRouting.ts
// Purpose: Choose one window on the folder without disturbing a busy right panel.

import type { DesktopAppTabOpened } from "@penkra/contracts";
import type { PanelFocusState } from "./panelFocus";
import type { ThreadHomeWindow } from "./threadHomeWindow";

export interface AppTabRoutingWindow {
  id: number;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  spaceId: string | null;
  folderId: string | null;
}

/** Window focus history is local to this desktop process. */
export class AppTabWindowFocusOrder {
  #ids: number[] = [];
  focus(id: number): void {
    this.#ids = [id, ...this.#ids.filter((entry) => entry !== id)];
  }
  close(id: number): void {
    this.#ids = this.#ids.filter((entry) => entry !== id);
  }
  order(windows: readonly AppTabRoutingWindow[]): AppTabRoutingWindow[] {
    const byId = new Map(windows.map((window) => [window.id, window]));
    const focused = this.#ids.flatMap((id) => {
      const window = byId.get(id);
      return window ? [window] : [];
    });
    const focusedIds = new Set(this.#ids);
    return [...focused, ...windows.filter((window) => !focusedIds.has(window.id))];
  }
}

/** Windows arrive in focus order; the home window has priority when eligible. */
export function announceAppTabOpened(input: {
  descriptor: Pick<DesktopAppTabOpened, "threadId" | "folderId" | "spaceId" | "initiator">;
  windows: readonly AppTabRoutingWindow[];
  home: ThreadHomeWindow;
  panelFocus: PanelFocusState;
}): { targetWindowId: number | null; backgroundWindowId: number | null; folderShown: boolean } {
  const { descriptor, home, panelFocus } = input;
  const showing = input.windows.filter(
    (window) =>
      window.visible &&
      !window.minimized &&
      window.spaceId === descriptor.spaceId &&
      window.folderId === descriptor.folderId,
  );
  const eligible = showing.filter(
    (window) =>
      descriptor.initiator !== "agent" ||
      !panelFocus.shouldPreserveAgentOpen(window.id, window.focused),
  );
  const targetWindowId =
    eligible.length === 0
      ? null
      : home.presentingWindow(
          descriptor.threadId,
          descriptor.folderId,
          eligible.map((window) => window.id),
        );
  return {
    targetWindowId,
    backgroundWindowId: targetWindowId === null ? (showing[0]?.id ?? null) : null,
    folderShown: showing.length > 0,
  };
}

export function appTabFolderUnavailable(
  folderTitle: string,
  folderShown: boolean,
): Error & { code: string; dispatched: boolean } {
  return Object.assign(
    new Error(
      folderShown
        ? `The user is working in folder "${folderTitle}"'s tabs right now. Try again later.`
        : `Folder "${folderTitle}" isn't open right now, so its tabs can't be used. Continue without the tab, or tell the user you need folder "${folderTitle}" open.`,
    ),
    { code: folderShown ? "USER_IN_FOLDER_TABS" : "FOLDER_NOT_OPEN", dispatched: false },
  );
}
