import { describe, expect, it } from "vitest";
import {
  announceAppTabOpened,
  AppTabWindowFocusOrder,
  appTabFolderUnavailable,
  type AppTabRoutingWindow,
} from "./appTabOpenedRouting";
import { PanelFocusState } from "./panelFocus";
import { ThreadHomeWindow } from "./threadHomeWindow";

const descriptor = {
  threadId: "thread-a",
  folderId: "folder-a",
  spaceId: "space-a",
  initiator: "agent" as const,
};
const window = (id: number, patch: Partial<AppTabRoutingWindow> = {}): AppTabRoutingWindow => ({
  id,
  focused: false,
  visible: true,
  minimized: false,
  spaceId: "space-a",
  folderId: "folder-a",
  ...patch,
});
const setup = () => {
  const home = new ThreadHomeWindow();
  home.view(1, "thread-a", "folder-a", true);
  home.view(2, "thread-b", "folder-a", true);
  const panelFocus = new PanelFocusState();
  const route = (windows: AppTabRoutingWindow[]) =>
    announceAppTabOpened({ descriptor, windows, home, panelFocus });
  return { home, panelFocus, route };
};
describe("folder App-tab routing", () => {
  it("chooses the idle home window ahead of focus order", () => {
    const { route } = setup();
    expect(route([window(2), window(1)]).targetWindowId).toBe(1);
  });
  it("chooses idle B without selecting anything in busy A", () => {
    const { panelFocus, route } = setup();
    panelFocus.recordInteraction(1, true);
    expect(route([window(1, { focused: true }), window(2)])).toEqual({
      targetWindowId: 2,
      backgroundWindowId: null,
      folderShown: true,
    });
  });
  it("uses another window when home shows a different folder", () => {
    const { route } = setup();
    expect(route([window(1, { folderId: "elsewhere" }), window(2)]).targetWindowId).toBe(2);
  });
  it("opens in the background while the only showing window is busy", () => {
    const { panelFocus, route } = setup();
    panelFocus.recordInteraction(1, true);
    expect(route([window(1, { focused: true })])).toEqual({
      targetWindowId: null,
      backgroundWindowId: 1,
      folderShown: true,
    });
    expect(appTabFolderUnavailable("Work", true)).toMatchObject({
      code: "TAB_FOLDER_NOT_AVAILABLE",
    });
  });
  it("opens in the background when no visible window shows the folder", () => {
    const { route } = setup();
    for (const windows of [
      [],
      [window(1, { visible: false })],
      [window(1, { minimized: true })],
      [window(1, { spaceId: "elsewhere" })],
      [window(1, { folderId: "elsewhere" })],
    ])
      expect(route(windows)).toEqual({
        targetWindowId: null,
        backgroundWindowId: null,
        folderShown: false,
      });
    expect(appTabFolderUnavailable("Work", false)).toMatchObject({
      code: "TAB_FOLDER_NOT_AVAILABLE",
    });
  });
  it("does not treat an unfocused panel as busy", () => {
    const { panelFocus, route } = setup();
    panelFocus.recordInteraction(1, true);
    expect(route([window(1)]).targetWindowId).toBe(1);
  });
  it("tracks focus and removes closed windows without an unrelated default", () => {
    const order = new AppTabWindowFocusOrder();
    order.focus(1);
    order.focus(2);
    order.focus(1);
    expect(order.order([window(1), window(2), window(3)]).map((w) => w.id)).toEqual([1, 2]);
    order.close(1);
    expect(order.order([window(1), window(2)]).map((w) => w.id)).toEqual([2]);
  });
  it("uses focus order for background opening when every showing window is busy", () => {
    const { panelFocus, route } = setup();
    panelFocus.recordInteraction(1, true);
    panelFocus.recordInteraction(2, true);
    expect(route([window(2, { focused: true }), window(1, { focused: true })])).toEqual({
      targetWindowId: null,
      backgroundWindowId: 2,
      folderShown: true,
    });
    expect(appTabFolderUnavailable("Work", true).message).toBe(
      'You are working in the right panel of every window showing folder "Work".',
    );
  });
  it("keeps explicit user opening available in a busy home window", () => {
    const { home, panelFocus } = setup();
    panelFocus.recordInteraction(1, true);
    expect(
      announceAppTabOpened({
        descriptor: { ...descriptor, initiator: "user" },
        home,
        panelFocus,
        windows: [window(1, { focused: true })],
      }).targetWindowId,
    ).toBe(1);
    expect(appTabFolderUnavailable("Work", false).message).toBe(
      'Folder "Work" is not open in any window.',
    );
  });
});
