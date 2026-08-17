import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { AppDockPane } from "./AppDockPane";

const originalDesktopBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
const FRAME_DOCUMENT = `data:text/html,${encodeURIComponent(`
  <!doctype html><body>Runtime v2 App<script>
    addEventListener("message", (event) => {
      const port = event.ports[0];
      if (!port) return;
      port.start();
      port.postMessage({ type: "ready" });
      port.postMessage({ type: "call", id: "identity-1", method: "identity.get" });
      port.postMessage({ type: "renderer-message", message: { type: "result", id: "rpc-1", result: true } });
    });
  </script></body>
`)}`;

afterEach(() => {
  document.body.innerHTML = "";
  if (originalDesktopBridge) Object.defineProperty(window, "desktopBridge", originalDesktopBridge);
  else Reflect.deleteProperty(window, "desktopBridge");
});

function installBridge() {
  const frameReady = vi.fn(async () => undefined);
  const frameMessage = vi.fn(async () => undefined);
  const frameCall = vi.fn(async () => ({ subject: null, space: "space-test" }));
  let hostListener: ((message: unknown) => void) | null = null;
  const setActive = vi.fn(async () => undefined);
  const browserWebviewAttach = vi.fn(async () => undefined);
  const browserWebviewDetach = vi.fn(async () => undefined);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      appTabs: {
        setActive,
        browserWebviewAttach,
        browserWebviewDetach,
        frameCall,
        frameMessage,
        frameReady,
        onFrameHostMessage: (listener: (message: unknown) => void) => {
          hostListener = listener;
          return () => {
            hostListener = null;
          };
        },
      },
    },
  });
  return {
    setActive,
    browserWebviewAttach,
    browserWebviewDetach,
    frameCall,
    frameMessage,
    frameReady,
    emitHostMessage(message: unknown) {
      hostListener?.(message);
    },
  };
}

describe("AppDockPane Runtime v2 frame", () => {
  it("connects one MessagePort and forwards readiness, calls, and renderer RPC", async () => {
    const bridge = installBridge();
    await render(
      <div className="h-40 w-80">
        <AppDockPane
          appName="Canvas"
          documentUrl={FRAME_DOCUMENT}
          rendererId={101}
          status="ready"
          tabId="stable-tab"
          visible={true}
        />
      </div>,
    );

    await vi.waitFor(() => expect(bridge.frameReady).toHaveBeenCalledOnce());
    expect(bridge.frameCall).toHaveBeenCalledWith({
      tabId: "stable-tab",
      rendererId: 101,
      method: "identity.get",
    });
    expect(bridge.frameMessage).toHaveBeenCalledWith({
      tabId: "stable-tab",
      rendererId: 101,
      message: { type: "result", id: "rpc-1", result: true },
    });
    expect(bridge.setActive).toHaveBeenCalledWith({
      tabId: "stable-tab",
      rendererId: 101,
      active: true,
    });
  });

  it("resizes continuously as DOM content without native geometry synchronization", async () => {
    const bridge = installBridge();
    function Harness() {
      const [wide, setWide] = useState(false);
      return (
        <>
          <button onClick={() => setWide(true)} type="button">
            Resize
          </button>
          <div className={wide ? "h-40 w-[640px]" : "h-40 w-80"}>
            <AppDockPane
              appName="Explorer"
              documentUrl={FRAME_DOCUMENT}
              rendererId={101}
              status="ready"
              tabId="tab-1"
              visible={true}
            />
          </div>
        </>
      );
    }
    await render(<Harness />);
    const frame = page.getByTitle("Explorer");
    await expect.element(frame).toBeVisible();
    const initialWidth = (await frame.element()).getBoundingClientRect().width;
    await page.getByRole("button", { name: "Resize" }).click();
    await vi.waitFor(async () =>
      expect((await frame.element()).getBoundingClientRect().width).toBeGreaterThan(
        initialWidth + 300,
      ),
    );
    expect(bridge.setActive).toHaveBeenCalled();
  });

  it("keeps shell overlays above the App frame", async () => {
    installBridge();
    await render(
      <div className="relative h-40 w-80">
        <AppDockPane
          appName="Apps"
          documentUrl={FRAME_DOCUMENT}
          rendererId={101}
          status="ready"
          tabId="tab-1"
          visible={true}
        />
        <div className="absolute inset-0 z-50" data-testid="shell-overlay">
          Shell popup
        </div>
      </div>,
    );
    const topmost = document.elementFromPoint(160, 80);
    expect(topmost?.closest("[data-testid='shell-overlay']")).not.toBeNull();
  });

  it("renders hosted Browser content as a DOM webview and binds its page identity", async () => {
    const bridge = installBridge();
    await render(
      <div className="h-80 w-[640px]">
        <AppDockPane
          appName="Browser"
          documentUrl={FRAME_DOCUMENT}
          rendererId={-1}
          status="ready"
          tabId="browser-tab"
          visible={true}
        />
      </div>,
    );
    await vi.waitFor(() => expect(bridge.frameReady).toHaveBeenCalledOnce());
    bridge.emitHostMessage({
      tabId: "browser-tab",
      rendererId: -1,
      delivery: {
        kind: "event",
        name: "browser.state",
        payload: {
          sessionId: "browser-tab",
          activePageId: "page-1",
          pages: [{ id: "page-1", url: "https://example.com", title: "Example" }],
        },
      },
    });
    bridge.emitHostMessage({
      tabId: "browser-tab",
      rendererId: -1,
      delivery: {
        kind: "event",
        name: "browser.surface",
        payload: {
          partition: "persist:app-space-browser",
          insets: { top: 44, right: 8, bottom: 16, left: 8 },
        },
      },
    });
    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBeNull());
    const webview = document.querySelector("webview") as HTMLElement & {
      getWebContentsId(): number;
    };
    webview.getWebContentsId = () => 77;
    webview.dispatchEvent(new Event("dom-ready"));
    await vi.waitFor(() =>
      expect(bridge.browserWebviewAttach).toHaveBeenCalledWith({
        tabId: "browser-tab",
        rendererId: -1,
        pageId: "page-1",
        webContentsId: 77,
      }),
    );
    expect(webview.getAttribute("partition")).toBe("persist:app-space-browser");
    expect(webview.getAttribute("src")).toBe("https://example.com");
    expect(webview.style.top).toBe("44px");
    expect(webview.style.right).toBe("8px");
    expect(webview.style.bottom).toBe("16px");
    expect(webview.style.left).toBe("8px");
    expect(webview.style.width).toBe("");
    expect(webview.style.height).toBe("");
  });

  it("keeps both Browser surface edges locked during rapid host-only resizing", async () => {
    const bridge = installBridge();
    function Harness() {
      const [width, setWidth] = useState(320);
      return (
        <>
          <button
            onClick={() => setWidth((current) => (current === 320 ? 760 : 320))}
            type="button"
          >
            Resize Browser
          </button>
          <div data-testid="browser-host" style={{ height: 320, width }}>
            <AppDockPane
              appName="Browser"
              documentUrl={FRAME_DOCUMENT}
              rendererId={-2}
              status="ready"
              tabId="browser-edge-tab"
              visible={true}
            />
          </div>
        </>
      );
    }
    await render(<Harness />);
    await vi.waitFor(() => expect(bridge.frameReady).toHaveBeenCalledOnce());
    bridge.emitHostMessage({
      tabId: "browser-edge-tab",
      rendererId: -2,
      delivery: {
        kind: "event",
        name: "browser.state",
        payload: {
          sessionId: "browser-edge-tab",
          activePageId: "page-1",
          pages: [{ id: "page-1", url: "https://example.com", title: "Example" }],
        },
      },
    });
    bridge.emitHostMessage({
      tabId: "browser-edge-tab",
      rendererId: -2,
      delivery: {
        kind: "event",
        name: "browser.surface",
        payload: {
          partition: "persist:app-space-browser",
          insets: { top: 40, right: 0, bottom: 0, left: 0 },
        },
      },
    });
    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBeNull());

    const assertLockedEdges = () => {
      const host = document.querySelector('[data-testid="browser-host"]') as HTMLElement;
      const webview = document.querySelector("webview") as HTMLElement;
      const hostRect = host.getBoundingClientRect();
      const webviewRect = webview.getBoundingClientRect();
      expect(webviewRect.left).toBe(hostRect.left);
      expect(webviewRect.right).toBe(hostRect.right);
      expect(webviewRect.bottom).toBe(hostRect.bottom);
    };

    assertLockedEdges();
    for (let iteration = 0; iteration < 5; iteration += 1) {
      await page.getByRole("button", { name: "Resize Browser" }).click();
      await vi.waitFor(assertLockedEdges);
    }
  });
});
