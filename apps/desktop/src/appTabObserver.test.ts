import type { WebContents } from "electron";
import type { DesktopAppTabDescriptor } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import { AppTabObserver, resolveAppTabObservationTarget } from "./appTabObserver";

const descriptor: DesktopAppTabDescriptor = {
  id: "tab-1",
  appId: "com.acme.canvas",
  slug: "canvas",
  name: "Canvas",
  iconDataUrl: null,
  spaceId: "personal",
  threadId: "thread-1",
  route: "/",
  status: "ready",
};

function makeContents() {
  const listeners = new Map<string, () => void>();
  const sendCommand = vi.fn(async (method: string) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            backendDOMNodeId: 7,
            role: { value: "button" },
            name: { value: "Save" },
            properties: [{ name: "focusable", value: { value: true } }],
          },
          {
            backendDOMNodeId: 8,
            role: { value: "textbox" },
            name: { value: "Password" },
            value: { value: "••••••" },
            properties: [{ name: "protected", value: { value: true } }],
          },
        ],
      };
    }
    if (method === "DOM.getBoxModel") {
      return { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } };
    }
    return {};
  });
  const contents = {
    id: 12,
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand,
    },
    isDestroyed: () => false,
    getURL: () => "penkra-app://com.acme.canvas/app.html",
    getTitle: () => "Canvas",
    executeJavaScript: vi.fn(async () => ({
      title: "Canvas",
      url: "penkra-app://canvas",
      text: "Hello",
    })),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("png") })),
    once: (event: string, listener: () => void) => listeners.set(event, listener),
    on: (event: string, listener: () => void) => listeners.set(event, listener),
  } as unknown as WebContents;
  return { contents, listeners, sendCommand };
}

describe("resolveAppTabObservationTarget", () => {
  it("targets Browser's hosted page by its App-tab-scoped session id", async () => {
    const appContents = makeContents().contents;
    const hostedContents = makeContents().contents;
    const browserWebContents = vi.fn(async () => hostedContents);
    const browserDescriptor = {
      ...descriptor,
      appId: "com.penkra.browser",
      slug: "browser",
    };

    await expect(
      resolveAppTabObservationTarget({
        descriptor: browserDescriptor,
        browserAppId: "com.penkra.browser",
        appWebContents: () => appContents,
        browserWebContents,
      }),
    ).resolves.toEqual({ descriptor: browserDescriptor, webContents: hostedContents });
    expect(browserWebContents).toHaveBeenCalledExactlyOnceWith("tab-1");
  });

  it("never substitutes a Browser page for an ordinary App", async () => {
    const appContents = makeContents().contents;
    const browserWebContents = vi.fn(async () => makeContents().contents);
    const appWebContents = vi.fn(() => appContents);

    await expect(
      resolveAppTabObservationTarget({
        descriptor,
        browserAppId: "com.penkra.browser",
        appWebContents,
        browserWebContents,
      }),
    ).resolves.toEqual({ descriptor, webContents: appContents });
    expect(appWebContents).toHaveBeenCalledExactlyOnceWith("tab-1");
    expect(browserWebContents).not.toHaveBeenCalled();
  });
});

describe("AppTabObserver", () => {
  it("returns bounded semantic refs and redacts protected values", async () => {
    const { contents } = makeContents();
    const observer = new AppTabObserver({ resolve: () => ({ descriptor, webContents: contents }) });

    await expect(observer.snapshot("tab-1")).resolves.toMatchObject({
      tabId: "tab-1",
      app: "canvas",
      nodes: [
        { ref: "a1", role: "button", name: "Save" },
        { ref: "a2", role: "textbox", name: "Password", value: "[redacted]" },
      ],
    });
  });

  it("uses the latest snapshot reference and invalidates it on navigation", async () => {
    const { contents, listeners, sendCommand } = makeContents();
    const observer = new AppTabObserver({ resolve: () => ({ descriptor, webContents: contents }) });
    await observer.snapshot("tab-1");

    await expect(observer.click("tab-1", "a1")).resolves.toMatchObject({ clicked: true });
    expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      x: 50,
      y: 20,
    });

    listeners.get("did-start-navigation")?.();
    await expect(observer.click("tab-1", "a1")).rejects.toMatchObject({
      code: "SNAPSHOT_REQUIRED",
    });
  });

  it("returns screenshots as MCP-ready PNG data", async () => {
    const { contents } = makeContents();
    const observer = new AppTabObserver({ resolve: () => ({ descriptor, webContents: contents }) });

    await expect(observer.screenshot("tab-1")).resolves.toEqual({
      kind: "image",
      mimeType: "image/png",
      data: Buffer.from("png").toString("base64"),
    });
  });
});
