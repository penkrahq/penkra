// FILE: appTabOpenedRouting.ts
// Purpose: Choose the home window among windows showing the tab's folder.

import type { DesktopAppTabOpened } from "@penkra/contracts";
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

export function appTabWindowShowsFolder(
  window: AppTabRoutingWindow,
  descriptor: Pick<DesktopAppTabOpened, "spaceId" | "folderId">,
): boolean {
  return window.spaceId === descriptor.spaceId && window.folderId === descriptor.folderId;
}

export function canUseAppTabWindow(
  window: AppTabRoutingWindow,
  descriptor: Pick<DesktopAppTabOpened, "spaceId" | "folderId" | "initiator">,
): boolean {
  return appTabWindowShowsFolder(window, descriptor);
}

/** Windows arrive in focus order; the home window has priority when eligible. */
export function announceAppTabOpened(input: {
  descriptor: Pick<DesktopAppTabOpened, "threadId" | "folderId" | "spaceId" | "initiator">;
  windows: readonly AppTabRoutingWindow[];
  home: ThreadHomeWindow;
}): { targetWindowId: number | null; folderShown: boolean } {
  const { descriptor, home } = input;
  const showing = input.windows.filter((window) => appTabWindowShowsFolder(window, descriptor));
  const targetWindowId =
    showing.length === 0
      ? null
      : home.presentingWindow(
          descriptor.threadId,
          descriptor.folderId,
          showing.map((window) => window.id),
        );
  return {
    targetWindowId,
    folderShown: showing.length > 0,
  };
}

export function appTabFolderUnavailable(
  folderTitle: string,
): Error & { code: string; dispatched: boolean } {
  return Object.assign(
    new Error(
      `Folder "${folderTitle}" isn't open right now, so its tabs can't be used. Continue without the tab, or tell the user you need folder "${folderTitle}" open.`,
    ),
    { code: "FOLDER_NOT_OPEN", dispatched: false },
  );
}
