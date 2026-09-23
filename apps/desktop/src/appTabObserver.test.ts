import type { WebContents } from "electron";
import type { DesktopAppTabDescriptor } from "@penkra/contracts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AppTabObserver } from "./appTabObserver";

const descriptor: DesktopAppTabDescriptor = {
  id: "tab-1",
  rendererId: 12,
  appId: "com.acme.canvas",
  slug: "canvas",
  name: "Canvas",
  iconDataUrl: null,
  spaceId: "personal",
  deckId: "deck-1",
  threadId: "thread-1",
  route: "/",
  status: "ready",
};

function makeContents(contentsId = 12) {
  let destroyed = false;
  let loaderId = "loader-1";
  const listeners = new Map<string, () => void>();
  const listenerSets = new Map<string, Set<() => void>>();
  const debuggerListeners = new Map<string, (...args: unknown[]) => void>();
  const sendCommand = vi.fn(
    async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: `frame-${contentsId}`, loaderId } } };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument")
        return { identifier: `cursor-script-${contentsId}` };
      if (method === "Page.createIsolatedWorld") return { executionContextId: contentsId * 10 };
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
    },
  );
  const debuggerApi = {
    isAttached: () => true,
    attach: vi.fn(),
    sendCommand,
    on: (event: string, listener: (...args: unknown[]) => void) =>
      debuggerListeners.set(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      if (debuggerListeners.get(event) === listener) debuggerListeners.delete(event);
    },
  };
  const contents = {
    get id() {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return contentsId;
    },
    get debugger() {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return debuggerApi;
    },
    isDestroyed: () => destroyed,
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
    setLoaderId: (value: string) => {
      loaderId = value;
    },
    emitDebugger: (method: string, params: Record<string, unknown>, sessionId?: string) =>
      debuggerListeners.get("message")?.({}, method, params, sessionId),
    emitDebuggerDetach: () => debuggerListeners.get("detach")?.({}, "target closed"),
    emitDestroyed: () => {
      destroyed = true;
      for (const listener of [...(listenerSets.get("destroyed") ?? [])]) listener();
    },
  };
}

describe("AppTabObserver", () => {
  it("dispatches structured shortcuts to the exact retained tab", async () => {
    const { contents, sendCommand } = makeContents();
    const resolve = vi.fn(() => ({ descriptor, webContents: contents }));
    const observer = new AppTabObserver({ resolve });
    await observer.press("tab-1", "Meta+Shift+ArrowRight");
    expect(resolve).toHaveBeenCalledWith("tab-1", "d1");
    const events = sendCommand.mock.calls.filter(([method]) => method === "Input.dispatchKeyEvent");
    expect(events).toEqual([
      [
        "Input.dispatchKeyEvent",
        {
          type: "keyDown",
          key: "ArrowRight",
          code: "ArrowRight",
          modifiers: 12,
          windowsVirtualKeyCode: 39,
        },
      ],
      [
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: "ArrowRight",
          code: "ArrowRight",
          modifiers: 12,
          windowsVirtualKeyCode: 39,
        },
      ],
    ]);
  });

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

    await expect(observer.snapshot("tab-1")).rejects.toThrow(
      "A browser JavaScript confirm dialog is open",
    );
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
      snapshot: expect.stringContaining(
        '- button "Save" [ref=d1:e1]\n- textbox "Password" value="[redacted]" [ref=d1:e2]',
      ),
      refs: {
        "d1:e1": { role: "button", name: "Save" },
        "d1:e2": { role: "textbox", name: "Password" },
      },
      removedRefs: [],
    });
  });

  it("supports interactive compact snapshots and reports refs removed since the prior snapshot", async () => {
    const { contents, sendCommand } = makeContents();
    let includeSave = true;
    sendCommand.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { loaderId: "loader-1" } } };
      if (method === "Accessibility.getFullAXTree")
        return {
          nodes: [
            {
              nodeId: "root",
              childIds: includeSave ? ["save", "text"] : ["text"],
              role: { value: "RootWebArea" },
              name: { value: "Canvas" },
            },
            ...(includeSave
              ? [
                  {
                    nodeId: "save",
                    parentId: "root",
                    backendDOMNodeId: 7,
                    role: { value: "button" },
                    name: { value: "Save" },
                  },
                ]
              : []),
            {
              nodeId: "text",
              parentId: "root",
              role: { value: "StaticText" },
              name: { value: "Noise" },
            },
          ],
        };
      return {};
    });
    const observer = new AppTabObserver({ resolve: () => ({ descriptor, webContents: contents }) });

    await expect(
      observer.snapshot("tab-1", { interactive: true, compact: true }),
    ).resolves.toMatchObject({
      snapshot: expect.stringContaining('- button "Save" [ref=d1:e1]'),
      removedRefs: [],
    });
    includeSave = false;
    await expect(
      observer.snapshot("tab-1", { interactive: true, compact: true }),
    ).resolves.toMatchObject({
      snapshot: expect.stringContaining("(no interactive elements)"),
      removedRefs: ["d1:e1"],
    });
  });

  it("resolves snapshot boxes in parallel", async () => {
    const { contents, sendCommand } = makeContents();
    let active = 0;
    let maximum = 0;
    sendCommand.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { loaderId: "loader-1" } } };
      if (method === "Accessibility.getFullAXTree")
        return {
          nodes: [1, 2, 3].map((id) => ({
            backendDOMNodeId: id,
            role: { value: "button" },
            name: { value: `Button ${id}` },
          })),
        };
      if (method === "DOM.getBoxModel") {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } };
      }
      return {};
    });
    const observer = new AppTabObserver({ resolve: () => ({ descriptor, webContents: contents }) });
    await observer.snapshot("tab-1", { boxes: true });
    expect(maximum).toBe(3);
  });

  it("installs the cursor overlay, glides, ripples, and highlights through CDP", async () => {
    const { contents, sendCommand } = makeContents();
    sendCommand.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame-12", loaderId: "loader-1" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument")
        return { identifier: "cursor-script-12" };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 120 };
      if (method === "Accessibility.getFullAXTree")
        return {
          nodes: [{ backendDOMNodeId: 7, role: { value: "button" }, name: { value: "Save" } }],
        };
      if (method === "DOM.getBoxModel")
        return { model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } };
      if (method === "DOM.resolveNode") return { object: { objectId: "button-1" } };
      return {};
    });
    const observer = new AppTabObserver({ resolve: () => ({ descriptor, webContents: contents }) });
    await observer.snapshot("tab-1");
    await observer.act(
      "tab-1",
      [
        { action: "hover", ref: "d1:e1" },
        { action: "click", ref: "d1:e1" },
        { action: "highlight", ref: "d1:e1" },
      ],
      true,
    );

    expect(
      sendCommand.mock.calls.some(([method]) => method === "Page.addScriptToEvaluateOnNewDocument"),
    ).toBe(true);
    expect(
      sendCommand.mock.calls.filter(([method]) => method === "Input.dispatchMouseEvent").length,
    ).toBeGreaterThan(25);
    expect(
      sendCommand.mock.calls.some(
        (call) => call[0] === "Runtime.callFunctionOn" && JSON.stringify(call).includes("outline"),
      ),
    ).toBe(true);
  });

  it("keeps only the active document cursor visible until the owning turn completes", async () => {
    const d1 = makeContents(21);
    const d2 = makeContents(22);
    const observer = new AppTabObserver({
      resolve: (_tabId, document) => ({
        descriptor,
        document,
        webContents: document === "d1" ? d1.contents : d2.contents,
      }),
    });

    await observer.snapshot("tab-1", { document: "d1" });
    await observer.snapshot("tab-1", { document: "d2" });
    observer.setActiveTurnThreadIds(["thread-1"]);
    await observer.act(
      "tab-1",
      [
        { action: "hover", ref: "d1:e1" },
        { action: "hover", ref: "d2:e1" },
      ],
      true,
      "thread-1",
    );

    const evaluatedExpressions = (sendCommand: typeof d1.sendCommand) =>
      sendCommand.mock.calls
        .filter(([method]) => method === "Runtime.evaluate")
        .map(([, params]) => (params as { expression?: string } | undefined)?.expression);
    expect(evaluatedExpressions(d1.sendCommand)).toContain(
      "globalThis.__agentBrowserRecordingCursorHide?.()",
    );
    expect(evaluatedExpressions(d1.sendCommand)).not.toContain(
      "globalThis.__agentBrowserRecordingCursorCleanup?.()",
    );
    expect(evaluatedExpressions(d2.sendCommand)).not.toContain(
      "globalThis.__agentBrowserRecordingCursorCleanup?.()",
    );
    observer.setActiveTurnThreadIds([]);
    await vi.waitFor(() => {
      expect(evaluatedExpressions(d1.sendCommand)).toContain(
        "globalThis.__agentBrowserRecordingCursorCleanup?.()",
      );
      expect(evaluatedExpressions(d2.sendCommand)).toContain(
        "globalThis.__agentBrowserRecordingCursorCleanup?.()",
      );
    });
    expect(
      d1.sendCommand.mock.calls.some(
        ([method, params]) =>
          method === "Page.removeScriptToEvaluateOnNewDocument" &&
          (params as { identifier?: unknown } | undefined)?.identifier === "cursor-script-21",
      ),
    ).toBe(true);
    expect(
      d2.sendCommand.mock.calls.some(
        ([method, params]) =>
          method === "Page.removeScriptToEvaluateOnNewDocument" &&
          (params as { identifier?: unknown } | undefined)?.identifier === "cursor-script-22",
      ),
    ).toBe(true);
    expect(
      d1.sendCommand.mock.calls.some(
        ([method, params]) =>
          method === "Page.addScriptToEvaluateOnNewDocument" &&
          typeof (params as { worldName?: unknown } | undefined)?.worldName === "string",
      ),
    ).toBe(true);
  });

  it("serializes concurrent snapshots for one tab so reference generations cannot interleave", async () => {
    const { contents, sendCommand } = makeContents();
    let activeTrees = 0;
    let maximumConcurrentTrees = 0;
    sendCommand.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { loaderId: "loader-1" } } };
      if (method !== "Accessibility.getFullAXTree") return {};
      activeTrees += 1;
      maximumConcurrentTrees = Math.max(maximumConcurrentTrees, activeTrees);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeTrees -= 1;
      return {
        nodes: [{ backendDOMNodeId: 7, role: { value: "button" }, name: { value: "Save" } }],
      };
    });
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    const [first, second] = await Promise.all([
      observer.snapshot("tab-1"),
      observer.snapshot("tab-1"),
    ]);

    expect(maximumConcurrentTrees).toBe(1);
    expect(first).toMatchObject({
      snapshot: expect.stringContaining('- button "Save" [ref=d1:e1]'),
    });
    expect(second).toMatchObject({
      snapshot: expect.stringContaining('- button "Save" [ref=d1:e1]'),
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
      await expect(readFile(path, "utf8")).resolves.toContain('- button "Save" [ref=d1:e1]');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves accessibility hierarchy and scopes by depth and fresh element reference", async () => {
    const { contents, sendCommand } = makeContents();
    sendCommand.mockImplementation((async (method: string) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { loaderId: "loader-1" } } };
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
      snapshot: expect.stringContaining(
        '- document "Canvas"\n  - button "Save" [ref=d1:e1] [box=10,20,100,40]',
      ),
    });
    await expect(observer.snapshot("tab-1", { target: "d1:e1" })).resolves.toMatchObject({
      snapshot: expect.stringContaining('- button "Save" [ref=d1:e1]'),
    });
  });

  it("omits a box when Chromium cannot compute layout for an accessibility node", async () => {
    const { contents, sendCommand } = makeContents();
    sendCommand.mockImplementation((async (method: string, params?: { backendNodeId?: number }) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { loaderId: "loader-1" } } };
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              backendDOMNodeId: 7,
              role: { value: "button" },
              name: { value: "Visible" },
            },
            {
              backendDOMNodeId: 8,
              role: { value: "option" },
              name: { value: "Collapsed option" },
            },
          ],
        };
      }
      if (method === "DOM.getBoxModel") {
        if (params?.backendNodeId === 8) throw new Error("Could not compute box model.");
        return { model: { border: [0, 0, 80, 0, 80, 30, 0, 30] } };
      }
      return {};
    }) as never);
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    await expect(observer.snapshot("tab-1", { boxes: true })).resolves.toMatchObject({
      snapshot: expect.stringContaining(
        '- button "Visible" [ref=d1:e1] [box=0,0,80,30]\n- option "Collapsed option" [ref=d1:e2]',
      ),
    });
  });

  it("finds snapshot context without returning a second full-document representation", async () => {
    const { contents } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    await expect(observer.find("tab-1", "/save/i")).resolves.toMatchObject({
      query: "/save/i",
      matches: [expect.stringContaining('- button "Save" [ref=d1:e1]')],
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

    await expect(observer.click("tab-1", "d1:e1")).resolves.toMatchObject({
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
    await expect(observer.click("tab-1", "d1:e1")).rejects.toMatchObject({
      code: "STALE_REFERENCE",
    });
  });

  it("scrolls an offscreen element into view before reporting a click", async () => {
    const { contents, sendCommand } = makeContents();
    let scrolled = false;
    sendCommand.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame-1", loaderId: "loader-1" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument")
        return { identifier: "cursor-script" };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 120 };
      if (method === "Accessibility.getFullAXTree")
        return {
          nodes: [{ backendDOMNodeId: 7, role: { value: "button" }, name: { value: "Download" } }],
        };
      if (method === "DOM.scrollIntoViewIfNeeded") {
        scrolled = true;
        return {};
      }
      if (method === "DOM.getBoxModel")
        return {
          model: {
            content: scrolled
              ? [10, 50, 30, 50, 30, 70, 10, 70]
              : [10, -400, 30, -400, 30, -380, 10, -380],
          },
        };
      return {};
    });
    const observer = new AppTabObserver({ resolve: () => ({ descriptor, webContents: contents }) });
    await observer.snapshot("tab-1");
    await observer.click("tab-1", "d1:e1");

    const scrollIndex = sendCommand.mock.calls.findIndex(
      ([method]) => method === "DOM.scrollIntoViewIfNeeded",
    );
    const pressIndex = sendCommand.mock.calls.findIndex(
      ([method, params]) =>
        method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
    );
    expect(scrollIndex).toBeGreaterThanOrEqual(0);
    expect(pressIndex).toBeGreaterThan(scrollIndex);
    expect(sendCommand.mock.calls[pressIndex]?.[1]).toMatchObject({ x: 20, y: 60 });
  });

  it("keeps d1 references stable for one loader and rejects them after the loader changes", async () => {
    const { contents, setLoaderId } = makeContents();
    const observer = new AppTabObserver({
      resolve: (_tabId, document) => ({ descriptor, document, webContents: contents }),
    });

    const first = (await observer.snapshot("tab-1", { document: "d1" })) as { snapshot: string };
    const second = (await observer.snapshot("tab-1", { document: "d1" })) as { snapshot: string };
    expect(first.snapshot).toContain("ref=d1:e1");
    expect(second.snapshot).toContain("ref=d1:e1");

    setLoaderId("loader-2");
    await expect(observer.click("tab-1", "d1:e1")).rejects.toMatchObject({
      code: "STALE_REFERENCE",
    });
  });

  it("addresses the hosted page as d2 and mints d2 references", async () => {
    const { contents } = makeContents();
    const resolve = vi.fn((_tabId: string, document: "d1" | "d2") => ({
      descriptor,
      document,
      webContents: contents,
    }));
    const observer = new AppTabObserver({ resolve });

    await expect(observer.snapshot("tab-1", { document: "d2" })).resolves.toMatchObject({
      document: "d2",
      snapshot: expect.stringContaining("ref=d2:e1"),
    });
    expect(resolve).toHaveBeenCalledWith("tab-1", "d2");
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

  it("cleans observer state without touching WebContents after destruction", async () => {
    const { contents, emitDestroyed } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    await observer.snapshot("tab-1");

    expect(emitDestroyed).not.toThrow();
    expect(observer.getPerformanceSnapshot()).toMatchObject({
      dialogListenerCount: 0,
      protocolSessionCount: 0,
      snapshotStateCount: 0,
    });
  });

  it("returns screenshots as MCP-ready PNG data", async () => {
    const { contents } = makeContents();
    const captureBounds = { x: 20, y: 30, width: 100, height: 40 };
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents, captureBounds: () => captureBounds }),
    });

    await expect(observer.screenshot("tab-1")).resolves.toEqual({
      tabId: "tab-1",
      document: "d1",
      kind: "image",
      mimeType: "image/png",
      data: Buffer.from("png").toString("base64"),
    });
    expect(contents.capturePage).toHaveBeenCalledWith(captureBounds);
  });

  it("reports an exact never-painted screenshot error", async () => {
    const { contents } = makeContents();
    vi.mocked(contents.capturePage).mockResolvedValueOnce({
      getSize: () => ({ width: 0, height: 0 }),
      toPNG: () => Buffer.alloc(0),
    } as never);
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, document: "d1", webContents: contents }),
    });

    await expect(observer.screenshot("tab-1", "d1")).rejects.toMatchObject({
      code: "SCREENSHOT_NEVER_PAINTED",
    });
  });

  it("captures root-document HAR traffic when Electron supplies a debugger session id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "penkra-tab-har-"));
    try {
      const path = join(directory, "page.har");
      const { contents, emitDebugger } = makeContents();
      const observer = new AppTabObserver({
        resolve: () => ({ descriptor, document: "d2", webContents: contents }),
      });

      const capture = observer.har("tab-1", "d2", 20, path);
      await new Promise((resolve) => setTimeout(resolve, 1));
      emitDebugger(
        "Network.requestWillBeSent",
        {
          requestId: "request-1",
          request: { url: "https://example.test/data", method: "GET", headers: {} },
        },
        "root-session",
      );
      emitDebugger(
        "Network.responseReceived",
        {
          requestId: "request-1",
          response: { status: 200, statusText: "OK", headers: {}, mimeType: "text/plain" },
        },
        "root-session",
      );

      await expect(capture).resolves.toMatchObject({ entries: 1, filename: path });
      await expect(readFile(path, "utf8")).resolves.toContain("https://example.test/data");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("attributes semantic observation separately from page capture", async () => {
    const { contents } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });

    await observer.snapshot("tab-1");
    await observer.screenshot("tab-1");

    expect(observer.getPerformanceSnapshot()).toMatchObject({
      snapshotCalls: 1,
      screenshotCalls: 1,
      capturePageCalls: 1,
      capturePageBytes: 3,
      cdpCalls: 4,
      snapshotStateCount: 1,
      dialogListenerCount: 1,
      protocolSessionCount: 0,
    });
    expect(observer.getPerformanceSnapshot().snapshotTotalMs).toBeGreaterThanOrEqual(0);
    expect(observer.getPerformanceSnapshot().screenshotTotalMs).toBeGreaterThanOrEqual(0);
    expect(observer.getPerformanceSnapshot().capturePageTotalMs).toBeGreaterThanOrEqual(0);
    expect(observer.getPerformanceSnapshot().cdpTotalMs).toBeGreaterThanOrEqual(0);
  });

  it("can return a fresh observation with an action", async () => {
    const { contents } = makeContents();
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
    });
    await observer.snapshot("tab-1");
    const result = (await observer.click("tab-1", "d1:e1", true)) as {
      clicked: boolean;
      observation: { snapshot: string };
    };
    expect(result.clicked).toBe(true);
    expect(result.observation.snapshot).toContain('- button "Save" [ref=d1:e1]');
  });

  it("validates App-storage paths before assigning a file input", async () => {
    const { contents, sendCommand } = makeContents();
    const validateUploadPaths = vi.fn(async () => ["/validated/report.pdf"]);
    const observer = new AppTabObserver({
      resolve: () => ({ descriptor, webContents: contents }),
      validateUploadPaths,
    });
    await observer.snapshot("tab-1");
    await expect(observer.upload("tab-1", "d1:e1", ["report.pdf"])).resolves.toMatchObject({
      uploaded: 1,
    });
    expect(sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/validated/report.pdf"],
      backendNodeId: 7,
    });
  });
});
