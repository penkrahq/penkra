import { describe, expect, it, vi } from "vitest";

import { createInitialWindowPresenter } from "./initialWindowVisibility";

describe("initial desktop window visibility", () => {
  it("uses the first successful readiness event exactly once", () => {
    const window = { isDestroyed: vi.fn(() => false), maximize: vi.fn(), show: vi.fn() };
    const onShown = vi.fn();
    const present = createInitialWindowPresenter({ window, maximize: true, onShown });

    present("did-finish-load");
    present("ready-to-show");

    expect(window.maximize).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(onShown).toHaveBeenCalledWith("did-finish-load");
  });

  it("does not operate on a destroyed window", () => {
    const window = { isDestroyed: vi.fn(() => true), maximize: vi.fn(), show: vi.fn() };
    createInitialWindowPresenter({ window, maximize: false })("ready-to-show");
    expect(window.show).not.toHaveBeenCalled();
  });
});
