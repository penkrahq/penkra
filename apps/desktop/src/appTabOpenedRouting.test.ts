import { describe, expect, it } from "vitest";
import {
  announceAppTabOpened,
  AppTabWindowFocusOrder,
  appTabFolderUnavailable,
  canUseAppTabWindow,
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
    announceAppTabOpened({ descriptor, windows, home });
  return { home, panelFocus, route };
};
describe("folder App-tab routing", () => {
  it("activates an agent-opened tab in its home window even after panel interaction", () => {
    const { panelFocus, route } = setup();
    panelFocus.recordInteraction(1, true);
    expect(route([window(1, { focused: true }), window(2)]).targetWindowId).toBe(1);
  });
  it("allows activation in the user's panel, including hidden or minimized windows", () => {
    const { home, panelFocus } = setup();
    panelFocus.recordInteraction(1, true);
    for (const patch of [{}, { visible: false }, { minimized: true }]) {
      const candidate = window(1, { focused: true, ...patch });
      expect(canUseAppTabWindow(candidate, descriptor)).toBe(true);
      expect(announceAppTabOpened({ descriptor, windows: [candidate], home }).targetWindowId).toBe(
        1,
      );
    }
  });
  it("uses the same candidate permission for actions without requiring the home window", () => {
    const { panelFocus } = setup();
    expect(canUseAppTabWindow(window(2), descriptor)).toBe(true);
    for (const patch of [{ folderId: "other" }, { spaceId: "other" }]) {
      expect(canUseAppTabWindow(window(2, patch), descriptor)).toBe(false);
    }
    panelFocus.recordInteraction(2, true);
    expect(canUseAppTabWindow(window(2, { focused: true }), descriptor)).toBe(true);
    expect(canUseAppTabWindow(window(2), descriptor)).toBe(true);
  });
  it("chooses the home window ahead of focus order", () => {
    const { route } = setup();
    expect(route([window(2), window(1)]).targetWindowId).toBe(1);
  });
  it("uses another window when home shows a different folder", () => {
    const { route } = setup();
    expect(route([window(1, { folderId: "elsewhere" }), window(2)]).targetWindowId).toBe(2);
  });
  it("activates in the only showing window even after panel interaction", () => {
    const { panelFocus, route } = setup();
    panelFocus.recordInteraction(1, true);
    expect(route([window(1, { focused: true })])).toEqual({
      targetWindowId: 1,
      folderShown: true,
    });
  });
  it("has no activation target when no window shows the folder", () => {
    const { route } = setup();
    for (const windows of [
      [],
      [window(1, { spaceId: "elsewhere" })],
      [window(1, { folderId: "elsewhere" })],
    ])
      expect(route(windows)).toEqual({
        targetWindowId: null,
        folderShown: false,
      });
    expect(appTabFolderUnavailable("Work")).toMatchObject({
      code: "FOLDER_NOT_OPEN",
    });
  });
  it("can activate in an unfocused window", () => {
    const { panelFocus, route } = setup();
    panelFocus.recordInteraction(1, true);
    expect(route([window(1)]).targetWindowId).toBe(1);
  });
  it("tracks focus without dropping windows outside focus history", () => {
    const order = new AppTabWindowFocusOrder();
    order.focus(1);
    order.focus(2);
    order.focus(1);
    expect(order.order([window(1), window(2), window(3)]).map((w) => w.id)).toEqual([1, 2, 3]);
    order.close(1);
    expect(order.order([window(1), window(2)]).map((w) => w.id)).toEqual([2, 1]);
  });
  it("keeps explicit user opening available in a busy home window", () => {
    const { home, panelFocus } = setup();
    panelFocus.recordInteraction(1, true);
    expect(
      announceAppTabOpened({
        descriptor: { ...descriptor, initiator: "user" },
        home,
        windows: [window(1, { focused: true })],
      }).targetWindowId,
    ).toBe(1);
    expect(appTabFolderUnavailable("Work").message).toBe(
      'Folder "Work" isn\'t open right now, so its tabs can\'t be used. Continue without the tab, or tell the user you need folder "Work" open.',
    );
  });
  it("chooses a never-focused window when it alone shows the folder", () => {
    const { route, home } = setup();
    home.view(3, "thread-c", "folder-a", false);
    const order = new AppTabWindowFocusOrder();
    order.focus(1);
    order.focus(2);
    expect(
      route(
        order.order([
          window(1, { folderId: "elsewhere" }),
          window(2, { folderId: "elsewhere" }),
          window(3),
        ]),
      ).targetWindowId,
    ).toBe(3);
  });
});
