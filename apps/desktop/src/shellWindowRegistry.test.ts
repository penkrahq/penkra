import type { BrowserWindow, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ShellWindowRegistry } from "./shellWindowRegistry";

function windowStub(id: number): BrowserWindow & { destroyForTest(): void } {
  let destroyed = false;
  const webContents = { id, send: vi.fn() } as unknown as WebContents;
  return {
    webContents,
    isDestroyed: () => destroyed,
    destroyForTest: () => {
      destroyed = true;
    },
  } as unknown as BrowserWindow & { destroyForTest(): void };
}

describe("ShellWindowRegistry", () => {
  it("tracks only live registered shell windows", () => {
    const registry = new ShellWindowRegistry();
    const first = windowStub(1);
    const second = windowStub(2);
    registry.add(first);
    registry.add(second);

    expect(registry.list()).toEqual([first, second]);
    second.destroyForTest();
    expect(registry.list()).toEqual([first]);
    expect(registry.hasWebContents(second.webContents)).toBe(false);
  });

  it("resolves a focused shell without accepting an unrelated popup", () => {
    const registry = new ShellWindowRegistry();
    const first = windowStub(1);
    const second = windowStub(2);
    const popup = windowStub(3);
    registry.add(first);
    registry.add(second);

    expect(registry.resolve(second)).toBe(second);
    expect(registry.resolve(popup)).toBe(first);
  });

  it("resolves the exact shell renderer that owns an App surface", () => {
    const registry = new ShellWindowRegistry();
    const first = windowStub(11);
    const appSurface = windowStub(22);
    registry.add(first);
    registry.add(appSurface);

    expect(registry.windowForWebContentsId(22)).toBe(appSurface);
    expect(registry.windowForWebContentsId(999)).toBeNull();
    expect(registry.windowForWebContentsId(null)).toBeNull();
  });

  it("broadcasts shared state to every live shell renderer", () => {
    const registry = new ShellWindowRegistry();
    const first = windowStub(1);
    const second = windowStub(2);
    registry.add(first);
    registry.add(second);

    registry.broadcast("state", { version: 3 });

    expect(first.webContents.send).toHaveBeenCalledWith("state", { version: 3 });
    expect(second.webContents.send).toHaveBeenCalledWith("state", { version: 3 });
  });
});
