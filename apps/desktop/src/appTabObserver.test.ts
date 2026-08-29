import type { WebContents } from "electron";
import type { DesktopAppTabDescriptor } from "@penkra/contracts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AppTabObserver, resolveAppTabObservationTarget } from "./appTabObserver";

const descriptor: DesktopAppTabDescriptor = {
  id: "tab-1",
  rendererId: 12,
  appId: "com.acme.canvas",
  slug: "canvas",
  name: "Canvas",
  iconDataUrl: null,
  spaceId: "personal",
  threadId: "thread-1",
  route: "/",
  status: "ready",
  documentUrl: "penkra-app://test/index.html#penkra-tab=tab-1",
};

function makeContents() {
  const listeners = new Map<string, () => void>();
  const listenerSets = new Map<string, Set<() => void>>();
  const debuggerListeners = new Map<string, (...args: unknown[]) => void>();
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
      on: (event: string, listener: (...args: unknown[]) => void) =>
        debuggerListeners.set(event, listener),
    },
    isDestroyed: () => false,
    getURL: () => "penkra-app://com.acme.canvas/app.html",
    getTitle: () => "Canvas",
    executeJavaScript: vi.fn(async () => ({
      title: "Canvas",
      url: "penkra-app://canvas",
      text: "Hello",
    })),
    capturePage: vi.fn(async () => ({
      getSize: () => ({ width: 100, height: 40 }),
      toPNG: () => Buffer.from("png"),
    })),
    once: (event: string, listener: () => void) => {
      listeners.set(event, listener);
      const eventListeners = listenerSets.get(event) ?? new Set();
      eventListeners.add(listener);
      listenerSets.set(event, eventListeners);
    },
    on: (event: string, listener: () => void) => {
      listeners.set(event, listener);
      const eventListeners = listenerSets.get(event) ?? new Set();
      eventListeners.add(listener);
      listenerSets.set(event, eventListeners);
    },
    removeListener: (event: string, listener: () => void) => {
      const eventListeners = listenerSets.get(event);
      eventListeners?.delete(listener);
      if (listeners.get(event) === listener) {
        listeners.delete(event);
      }
    },
  } as unknown as WebContents;
  return {
    contents,
    listeners,
    listenerCount: (event: string) => listenerSets.get(event)?.size ?? 0,
    sendCommand,
    emitDebugger: (method: string, params: Record<string, unknown>, sessionId?: string) =>
      debuggerListeners.get("message")?.({}, method, params, sessionId),
  };
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
        appTarget: () => ({
          descriptor: browserDescriptor,
          webContents: appContents,
        }),
        browserWebContents,
      }),
    ).resolves.toEqual({
      descriptor: browserDescriptor,
      webContents: hostedContents,
    });
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
  it("reports delayed browser JavaScript dialogs and requires explicit handling", async () => {
    const { contents, emitDebugger, sendCommand } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    await observer.snapshot("tab-1");
    emitDebugger("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Delete this record?",
      url: "penkra-app://com.acme.canvas/app.html",
      defaultPrompt: "",
    });

    await expect(observer.snapshot("tab-1")).rejects.toMatchObject({ code: "DIALOG_OPEN" });
    await expect(observer.handleDialog("tab-1", false)).resolves.toMatchObject({
      accepted: false,
      dialog: { type: "confirm", message: "Delete this record?" },
    });
    expect(sendCommand).toHaveBeenCalledWith("Page.handleJavaScriptDialog", { accept: false });
    await expect(observer.snapshot("tab-1")).resolves.toMatchObject({ tabId: "tab-1" });
  });

  it("returns Playwright-shaped semantic refs and redacts protected values", async () => {
    const { contents } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    await expect(observer.snapshot("tab-1")).resolves.toMatchObject({
      tabId: "tab-1",
      app: "canvas",
      snapshot: '- button "Save" [ref=e1]\n- textbox "Password" value="[redacted]" [ref=e2]',
    });
  });

  it("observes the exact iframe instead of the surrounding Penkra shell", async () => {
    const { contents, sendCommand } = makeContents();
    const frame = {
      url: descriptor.documentUrl,
      executeJavaScript: vi.fn(async () => "Canvas document"),
    };
    sendCommand.mockImplementation((async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "shell", url: "http://localhost:5173" },
            childFrames: [{ frame: { id: "canvas-frame", url: descriptor.documentUrl } }],
          },
        };
      }
      if (method === "Accessibility.getFullAXTree") {
        expect(params).toEqual({ frameId: "canvas-frame" });
        return {
          nodes: [
            {
              backendDOMNodeId: 7,
              role: { value: "button" },
              name: { value: "Save design" },
            },
          ],
        };
      }
      return {};
    }) as never);
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents, frame: frame as never }),
    });

    await expect(observer.snapshot("tab-1")).resolves.toMatchObject({
      url: descriptor.documentUrl,
      title: "Canvas document",
      snapshot: '- button "Save design" [ref=e1]',
    });
  });

  it("writes a complete snapshot to the requested artifact path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "penkra-tab-snapshot-"));
    try {
      const path = join(directory, "nested", "canvas.md");
      const { contents } = makeContents();
      const observer = new AppTabObserver({
        resolve: () => ({ descriptor, webContents: contents }),
      });

      await expect(observer.snapshot("tab-1", { outputPath: path })).resolves.toMatchObject({
        filename: path,
      });
      await expect(readFile(path, "utf8")).resolves.toContain('- button "Save" [ref=e1]');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves accessibility hierarchy and scopes by depth and fresh element reference", async () => {
    const { contents, sendCommand } = makeContents();
    sendCommand.mockImplementation((async (method: string) => {
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              nodeId: "root",
              childIds: ["button"],
              role: { value: "RootWebArea" },
              name: { value: "Canvas" },
            },
            {
              nodeId: "button",
              parentId: "root",
              childIds: ["label"],
              backendDOMNodeId: 7,
              role: { value: "button" },
              name: { value: "Save" },
            },
            {
              nodeId: "label",
              parentId: "button",
              role: { value: "StaticText" },
              name: { value: "Save changes" },
            },
          ],
        };
      }
      if (method === "Accessibility.getPartialAXTree") {
        return {
          nodes: [
            {
              nodeId: "button",
              backendDOMNodeId: 7,
              role: { value: "button" },
              name: { value: "Save" },
            },
          ],
        };
      }
      if (method === "DOM.getBoxModel") {
        return { model: { border: [10, 20, 110, 20, 110, 60, 10, 60] } };
      }
      return {};
    }) as never);
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    await expect(observer.snapshot("tab-1", { depth: 1, boxes: true })).resolves.toMatchObject({
      snapshot: '- document "Canvas"\n  - button "Save" [ref=e1] [box=10,20,100,40]',
    });
    await expect(observer.snapshot("tab-1", { target: "e1" })).resolves.toMatchObject({
      snapshot: '- button "Save" [ref=e1]',
    });
  });

  it("finds snapshot context without returning a second full-document representation", async () => {
    const { contents } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    await expect(observer.find("tab-1", "/save/i")).resolves.toMatchObject({
      query: "/save/i",
      matches: [expect.stringContaining('- button "Save" [ref=e1]')],
    });
    const result = (await observer.find("tab-1", "Save")) as Record<string, unknown>;
    expect(result).not.toHaveProperty("snapshot");
  });

  it("uses the latest snapshot reference and invalidates it on navigation", async () => {
    const { contents, listeners, sendCommand } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });
    await observer.snapshot("tab-1");

    await expect(observer.click("tab-1", "e1")).resolves.toMatchObject({
      clicked: true,
    });
    expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      x: 50,
      y: 20,
    });

    listeners.get("did-start-navigation")?.();
    await expect(observer.click("tab-1", "e1")).rejects.toMatchObject({
      code: "SNAPSHOT_REQUIRED",
    });
  });

  it("releases snapshot lifecycle listeners across repeated navigation cycles", async () => {
    const { contents, listeners, listenerCount } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await observer.snapshot("tab-1");
      expect(listenerCount("did-start-navigation")).toBe(1);
      listeners.get("did-start-navigation")?.();
      expect(listenerCount("did-start-navigation")).toBe(0);
    }

    await observer.snapshot("tab-1");
    observer.invalidate("tab-1");
    expect(listenerCount("did-start-navigation")).toBe(0);
    // The observer's one shared JavaScript-dialog listener remains until WebContents destruction;
    // only per-snapshot lifecycle listeners are owned by invalidate().
    expect(listenerCount("destroyed")).toBe(1);
  });

  it("returns screenshots as MCP-ready PNG data", async () => {
    const { contents } = makeContents();
    const captureBounds = { x: 20, y: 30, width: 100, height: 40 };
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents, captureBounds: () => captureBounds }),
    });

    await expect(observer.screenshot("tab-1")).resolves.toEqual({
      kind: "image",
      mimeType: "image/png",
      data: Buffer.from("png").toString("base64"),
    });
    expect(contents.capturePage).toHaveBeenCalledWith(captureBounds);
  });

  it("rejects screenshots when the exact App pane is not painted", async () => {
    const { contents } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents, captureBounds: () => null }),
    });

    await expect(observer.screenshot("tab-1")).rejects.toMatchObject({
      code: "TAB_NOT_VISIBLE",
      message: expect.stringContaining("currently painted"),
    });
    expect(contents.capturePage).not.toHaveBeenCalled();
  });

  it("maps a renderer without a display surface to TAB_NOT_VISIBLE", async () => {
    const { contents } = makeContents();
    vi.mocked(contents.capturePage).mockRejectedValue(
      new Error("Current display surface not available for capture"),
    );
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    await expect(observer.screenshot("tab-1")).rejects.toMatchObject({
      code: "TAB_NOT_VISIBLE",
      message: expect.stringContaining("Current display surface not available for capture"),
    });
    expect(contents.capturePage).toHaveBeenCalledOnce();
  });

  it("can return a fresh observation with an action", async () => {
    const { contents } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });
    await observer.snapshot("tab-1");
    const result = (await observer.click("tab-1", "e1", true)) as {
      clicked: boolean;
      observation: { snapshot: string };
    };
    expect(result.clicked).toBe(true);
    expect(result.observation.snapshot).toContain('- button "Save" [ref=e1]');
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
      snapshot:
        '- button "Save" [ref=e1]\n- textbox "Password" value="[redacted]" [ref=e2]\n- document "Hosted page"\n  - button "Save" [ref=e3]\n  - textbox "Password" value="[redacted]" [ref=e4]',
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
    await expect(observer.upload("tab-1", "e1", ["report.pdf"])).resolves.toMatchObject({
      uploaded: 1,
    });
    expect(sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/validated/report.pdf"],
      backendNodeId: 7,
    });
  });
});
