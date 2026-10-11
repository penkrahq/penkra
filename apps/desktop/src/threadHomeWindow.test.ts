import { describe, expect, it } from "vitest";

import { ThreadHomeWindow } from "./threadHomeWindow";

describe("ThreadHomeWindow", () => {
  it("routes to a Folder window, preferring the last used home", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "thread-a", "folder-a", true);
    home.view(2, "thread-b", "folder-b", true);
    expect(home.presentingWindow("thread-a", "folder-a", [1, 2])).toBe(1);
    home.view(2, "thread-a", "folder-a", false);
    home.focus(2);
    expect(home.presentingWindow("thread-a", "folder-a", [1, 2])).toBe(2);
    home.close(2);
    expect(home.presentingWindow("thread-a", "folder-a", [1])).toBe(1);
  });

  it("does not present a tab in an unshown Folder", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "thread-a", "folder-a", true);
    expect(home.presentingWindow("thread-a", "folder-b", [1])).toBeNull();
  });

  it("inherits home for agent-created children and drops a closed home", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "parent", "folder", true);
    home.inherit("parent", "child");
    expect(home.presentingWindow("child", "folder", [1])).toBe(1);
    home.close(1);
    expect(home.homeWindow("child", [])).toBeNull();
  });

  it("takes the home from an explicit user send even without a turn origin", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "thread", "folder", true);
    home.view(2, "thread", "folder", false);
    home.send(2, "thread");
    expect(home.presentingWindow("thread", "folder", [1, 2])).toBe(2);
  });

  it("recognizes every Folder visible in a split window", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "thread-left", "folder-left", false, false);
    home.view(1, "thread-right", "folder-right", true);
    expect(home.presentingWindow("thread-left", "folder-left", [1])).toBe(1);
    expect(home.presentingWindow("thread-right", "folder-right", [1])).toBe(1);
  });

  it("keeps agent navigation attribution until the later view and retains the inherited home", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "parent", "folder", true);
    home.inherit("parent", "child");
    home.agentNavigation(2, "child");
    home.leave(2); // The prior route unmounts before the child route reports its view.
    home.replaceViews(2, [{ threadId: "child", folderId: "folder" }], "child", true);
    expect(home.homeWindow("child", [1, 2])).toBe(1);
    home.replaceViews(2, [{ threadId: "child", folderId: "folder" }], "child", true);
    expect(home.homeWindow("child", [1, 2])).toBe(2);
  });

  it("atomically replaces visible Folders when split layout changes", () => {
    const home = new ThreadHomeWindow();
    home.replaceViews(
      1,
      [
        { threadId: "left", folderId: "folder-left" },
        { threadId: "right", folderId: "folder-right" },
      ],
      "left",
      true,
    );
    home.replaceViews(1, [{ threadId: "right", folderId: "folder-right" }], "right", true);
    expect(home.presentingWindow("left", "folder-left", [1])).toBeNull();
    expect(home.presentingWindow("right", "folder-right", [1])).toBe(1);
  });

  it("retains the home across a renderer reload in the same BrowserWindow", () => {
    const home = new ThreadHomeWindow();
    home.view(77, "thread", "folder", true);
    home.leave(77);
    expect(home.homeWindow("thread", [77])).toBe(77);
    home.replaceViews(77, [{ threadId: "thread", folderId: "folder" }], "thread", false);
    expect(home.presentingWindow("thread", "folder", [77])).toBe(77);
  });

  it("issues a main-owned sync revision only after replacing window views", () => {
    const home = new ThreadHomeWindow();
    expect(
      home.replaceViews(77, [{ threadId: "thread", folderId: "folder" }], "thread", false),
    ).toEqual({
      windowId: 77,
      revision: 1,
    });
    expect(home.presentingWindow("thread", "folder", [77])).toBe(77);
    expect(
      home.replaceViews(77, [{ threadId: "thread", folderId: "folder" }], "thread", false),
    ).toEqual({
      windowId: 77,
      revision: 2,
    });
    home.close(77);
    expect(
      home.replaceViews(77, [{ threadId: "thread", folderId: "folder" }], "thread", false),
    ).toEqual({
      windowId: 77,
      revision: 1,
    });
  });

  it("defers a headless Thread selection until its Folder is viewed", () => {
    const home = new ThreadHomeWindow();
    expect(home.select("parent", "child", "folder", [])).toBeNull();
    expect(home.consumeThreadSelection("other-folder")).toBeNull();
    expect(home.consumeThreadSelection("folder")).toBe("child");
    expect(home.consumeThreadSelection("folder")).toBeNull();
  });
});
