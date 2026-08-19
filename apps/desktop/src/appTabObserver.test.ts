import type { WebContents } from "electron";
import type { DesktopAppTabDescriptor } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import { AppTabObserver, resolveAppTabObservationTarget } from "./appTabObserver";

const descriptor: DesktopAppTabDescriptor = {
  id: "tab-1",
  rendererId: 12,
  appId: "com.acme.canvas",
  slug: "canvas",
  name: "Canvas",
  iconDataUrl: null,
  documentUrl: "penkra-app://canvas/app.html",
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
        appTarget: () => ({ descriptor: browserDescriptor, webContents: appContents }),
        browserWebContents,
      }),
    ).resolves.toEqual({ descriptor: browserDescriptor, webContents: hostedContents });
    expect(browserWebContents).toHaveBeenCalledExactlyOnceWith("tab-1");
  });

  it("never substitutes a Browser page for an ordinary App", async () => {
    const appContents = makeContents().contents;
    const browserWebContents = vi.fn(async () => makeContents().contents);
    const appTarget = vi.fn(() => ({ descriptor, webContents: appContents }));

    await expect(
      resolveAppTabObservationTarget({
        descriptor,
        browserAppId: "com.penkra.browser",
        appTarget,
        browserWebContents,
      }),
    ).resolves.toEqual({ descriptor, webContents: appContents });
    expect(appTarget).toHaveBeenCalledExactlyOnceWith("tab-1");
    expect(browserWebContents).not.toHaveBeenCalled();
  });

  it("targets the hosted page for an ordinary App granted browser-session", async () => {
    const hostedContents = makeContents().contents;
    const browserWebContents = vi.fn(async () => hostedContents);
    await expect(
      resolveAppTabObservationTarget({
        descriptor,
        browserAppId: "com.penkra.browser",
        allowHostedPage: true,
        appTarget: vi.fn(),
        browserWebContents,
      }),
    ).resolves.toEqual({ descriptor, webContents: hostedContents });
  });

  it("composes App and hosted-page targets for a partial reserved rectangle", async () => {
    const appContents = makeContents().contents;
    const hostedContents = makeContents().contents;
    const insets = { top: 42, right: 0, bottom: 0, left: 0 };
    await expect(
      resolveAppTabObservationTarget({
        descriptor,
        browserAppId: "com.penkra.browser",
        allowHostedPage: true,
        hostedInsets: insets,
        appTarget: () => ({ descriptor, webContents: appContents }),
        browserWebContents: async () => hostedContents,
      }),
    ).resolves.toEqual({
      descriptor,
      webContents: appContents,
      embedded: { target: { descriptor, webContents: hostedContents }, insets },
    });
  });

  it("prefers a trusted hosted surface when the App tab has one", async () => {
    const appContents = makeContents().contents;
    const hostedContents = makeContents().contents;
    const appTarget = vi.fn(() => ({ descriptor, webContents: appContents }));
    const browserWebContents = vi.fn(async () => null);

    await expect(
      resolveAppTabObservationTarget({
        descriptor,
        browserAppId: "com.penkra.browser",
        appTarget,
        browserWebContents,
        hostedWebContents: () => hostedContents,
      }),
    ).resolves.toEqual({ descriptor, webContents: hostedContents });
    expect(appTarget).not.toHaveBeenCalled();
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

  it("can return a fresh observation with an action", async () => {
    const { contents } = makeContents();
    const observer = new AppTabObserver({ resolve: () => ({ descriptor, webContents: contents }) });
    await observer.snapshot("tab-1");
    const result = (await observer.click("tab-1", "a1", true)) as {
      clicked: boolean;
      observation: { nodes: Array<{ name?: string }> };
    };
    expect(result.clicked).toBe(true);
    expect(result.observation.nodes[0]).toMatchObject({ name: "Save" });
  });

  it("splices a partial hosted page into the App tree with frame-owned refs", async () => {
    const app = makeContents().contents;
    const page = makeContents().contents;
    const observer = new AppTabObserver({
      resolve: () => ({
        descriptor,
        webContents: app,
        embedded: {
          target: { descriptor, webContents: page },
          insets: { top: 40, right: 0, bottom: 0, left: 0 },
        },
      }),
    });
    await expect(observer.snapshot("tab-1")).resolves.toMatchObject({
      nodes: [
        { ref: "a1" },
        { ref: "a2" },
        { role: "iframe", children: [{ ref: "p3" }, { ref: "p4" }] },
      ],
    });
  });

  it("validates App-storage paths before assigning a file input", async () => {
    const { contents, sendCommand } = makeContents();
    const validateUploadPaths = vi.fn(async () => ["/validated/report.pdf"]);
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
      validateUploadPaths,
    });
    await observer.snapshot("tab-1");
    await expect(observer.upload("tab-1", "a1", ["report.pdf"])).resolves.toMatchObject({
      uploaded: 1,
    });
    expect(sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/validated/report.pdf"],
      backendNodeId: 7,
    });
  });
});
