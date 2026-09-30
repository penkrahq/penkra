import { describe, expect, it } from "vitest";

import { ThreadHomeWindow } from "./threadHomeWindow";

describe("ThreadHomeWindow", () => {
  it("routes to a Deck window, preferring the last used home", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "thread-a", "deck-a", true);
    home.view(2, "thread-b", "deck-b", true);
    expect(home.presentingWindow("thread-a", "deck-a", [1, 2])).toBe(1);
    home.view(2, "thread-a", "deck-a", false);
    home.focus(2);
    expect(home.presentingWindow("thread-a", "deck-a", [1, 2])).toBe(2);
    home.close(2);
    expect(home.presentingWindow("thread-a", "deck-a", [1])).toBe(1);
  });

  it("keeps an unshown Deck in the background and activates its tab once opened", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "thread-a", "deck-a", true);
    expect(home.presentingWindow("thread-a", "deck-b", [1])).toBeNull();
    home.defer("deck-b", "tab-b");
    expect(home.consume("deck-a", ["tab-b"])).toBeNull();
    expect(home.consume("deck-b", ["tab-b"])).toBe("tab-b");
    expect(home.consume("deck-b", ["tab-b"])).toBeNull();
  });

  it("inherits home for agent-created children and drops a closed home", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "parent", "deck", true);
    home.inherit("parent", "child");
    expect(home.presentingWindow("child", "deck", [1])).toBe(1);
    home.close(1);
    expect(home.homeWindow("child", [])).toBeNull();
  });

  it("takes the home from an explicit user send even without a turn origin", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "thread", "deck", true);
    home.view(2, "thread", "deck", false);
    home.send(2, "thread");
    expect(home.presentingWindow("thread", "deck", [1, 2])).toBe(2);
  });

  it("recognizes every Deck visible in a split window", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "thread-left", "deck-left", false, false);
    home.view(1, "thread-right", "deck-right", true);
    expect(home.presentingWindow("thread-left", "deck-left", [1])).toBe(1);
    expect(home.presentingWindow("thread-right", "deck-right", [1])).toBe(1);
  });

  it("keeps agent navigation attribution until the later view and retains the inherited home", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "parent", "deck", true);
    home.inherit("parent", "child");
    home.agentNavigation(2, "child");
    home.leave(2); // The prior route unmounts before the child route reports its view.
    home.replaceViews(2, [{ threadId: "child", deckId: "deck" }], "child", true);
    expect(home.homeWindow("child", [1, 2])).toBe(1);
    home.replaceViews(2, [{ threadId: "child", deckId: "deck" }], "child", true);
    expect(home.homeWindow("child", [1, 2])).toBe(2);
  });

  it("atomically replaces visible Decks when split layout changes", () => {
    const home = new ThreadHomeWindow();
    home.replaceViews(
      1,
      [
        { threadId: "left", deckId: "deck-left" },
        { threadId: "right", deckId: "deck-right" },
      ],
      "left",
      true,
    );
    home.replaceViews(1, [{ threadId: "right", deckId: "deck-right" }], "right", true);
    expect(home.presentingWindow("left", "deck-left", [1])).toBeNull();
    expect(home.presentingWindow("right", "deck-right", [1])).toBe(1);
  });

  it("keeps a Deck's background tab after its former home window closes", () => {
    const home = new ThreadHomeWindow();
    home.view(1, "thread", "deck", true);
    home.defer("deck", "tab");
    home.close(1);
    home.view(2, "thread", "deck", true);
    expect(home.consume("deck", ["tab"])).toBe("tab");
    home.defer("deck", "closed-tab");
    home.forgetTab("closed-tab");
    expect(home.consume("deck", ["closed-tab"])).toBeNull();
  });

  it("retains the home across a renderer reload in the same BrowserWindow", () => {
    const home = new ThreadHomeWindow();
    home.view(77, "thread", "deck", true);
    home.leave(77);
    expect(home.homeWindow("thread", [77])).toBe(77);
    home.replaceViews(77, [{ threadId: "thread", deckId: "deck" }], "thread", false);
    expect(home.presentingWindow("thread", "deck", [77])).toBe(77);
  });

  it("issues a main-owned sync revision only after replacing window views", () => {
    const home = new ThreadHomeWindow();
    expect(
      home.replaceViews(77, [{ threadId: "thread", deckId: "deck" }], "thread", false),
    ).toEqual({
      windowId: 77,
      revision: 1,
    });
    expect(home.presentingWindow("thread", "deck", [77])).toBe(77);
    expect(
      home.replaceViews(77, [{ threadId: "thread", deckId: "deck" }], "thread", false),
    ).toEqual({
      windowId: 77,
      revision: 2,
    });
    home.close(77);
    expect(
      home.replaceViews(77, [{ threadId: "thread", deckId: "deck" }], "thread", false),
    ).toEqual({
      windowId: 77,
      revision: 1,
    });
  });

  it("defers a headless Thread selection until its Deck is viewed", () => {
    const home = new ThreadHomeWindow();
    expect(home.select("parent", "child", "deck", [])).toBeNull();
    expect(home.consumeThreadSelection("other-deck")).toBeNull();
    expect(home.consumeThreadSelection("deck")).toBe("child");
    expect(home.consumeThreadSelection("deck")).toBeNull();
  });
});
