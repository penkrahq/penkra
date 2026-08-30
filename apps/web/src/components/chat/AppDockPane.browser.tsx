import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { AppDockPane } from "./AppDockPane";

const originalDesktopBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
const originalNavigatorUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
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
  if (originalNavigatorUserAgent) {
    Object.defineProperty(window.navigator, "userAgent", originalNavigatorUserAgent);
  } else {
    Reflect.deleteProperty(window.navigator, "userAgent");
  }
});

function installBridge() {
  const frameReady = vi.fn(async () => undefined);
  const frameMessage = vi.fn(async () => undefined);
  const frameCall = vi.fn(async () => ({ subject: null, space: "space-test" }));
  let hostListener: ((message: unknown) => void) | null = null;
  const setActive = vi.fn(async () => undefined);
  const browserWebviewAttach = vi.fn(async () => undefined);
  const browserWebviewDidFailLoad = vi.fn(async () => undefined);
  const browserWebviewDetach = vi.fn(async () => undefined);
  const browserHostedPageBounds = vi.fn(async () => undefined);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      appTabs: {
        setActive,
        browserWebviewAttach,
        browserWebviewDidFailLoad,
        browserWebviewDetach,
        browserHostedPageBounds,
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
    browserWebviewDidFailLoad,
    browserWebviewDetach,
    browserHostedPageBounds,
    frameCall,
    frameMessage,
    frameReady,
    emitHostMessage(message: unknown) {
      hostListener?.(message);
    },
  };
}

describe("AppDockPane Runtime v2 frame", () => {
  it("remounts the App document when an update assigns a new renderer identity", async () => {
    const bridge = installBridge();
    function Harness() {
      const [rendererId, setRendererId] = useState(101);
      return (
        <>
          <button onClick={() => setRendererId(102)} type="button">
            Update App
          </button>
          <div className="h-40 w-80">
            <AppDockPane
              appName="Studio"
              documentUrl={FRAME_DOCUMENT}
              rendererId={rendererId}
              status="ready"
              tabId="stable-tab"
              visible={true}
            />
          </div>
        </>
      );
    }

    await render(<Harness />);
    await vi.waitFor(() => expect(bridge.frameReady).toHaveBeenCalledTimes(1));
    await page.getByRole("button", { name: "Update App" }).click();
    await vi.waitFor(() => expect(bridge.frameReady).toHaveBeenCalledTimes(2));
  });

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

  it("replaces the App document when the renderer generation changes at a stable URL", async () => {
    const bridge = installBridge();
    function Harness() {
      const [rendererId, setRendererId] = useState(101);
      return (
        <>
          <button onClick={() => setRendererId(102)} type="button">
            Replace generation
          </button>
          <div className="h-40 w-80">
            <AppDockPane
              appName="Generation test"
              documentUrl={FRAME_DOCUMENT}
              rendererId={rendererId}
              status="ready"
              tabId="stable-tab"
              visible={true}
            />
          </div>
        </>
      );
    }

    await render(<Harness />);
    await vi.waitFor(() => expect(bridge.frameReady).toHaveBeenCalledOnce());
    const firstFrame = await page.getByTitle("Generation test").element();

    await page.getByRole("button", { name: "Replace generation" }).click();
    await vi.waitFor(async () => {
      const replacementFrame = await page.getByTitle("Generation test").element();
      expect(replacementFrame).not.toBe(firstFrame);
      expect(bridge.frameReady).toHaveBeenCalledWith({
        tabId: "stable-tab",
        rendererId: 102,
      });
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
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Penkra/0.11.3 Chrome/144.0.7559.236 Electron/40.10.6 " +
        "Safari/537.36",
    });
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
    expect(webview.hasAttribute("allowpopups")).toBe(true);
    expect(webview.getAttribute("useragent")).not.toMatch(/Electron/iu);
    expect(webview.getAttribute("useragent")).toContain("Penkra/0.11.3");
    expect(webview.getAttribute("useragent")).toContain("Chrome/144.0.7559.236");
    expect(webview.style.top).toBe("44px");
    expect(webview.style.right).toBe("8px");
    expect(webview.style.bottom).toBe("16px");
    expect(webview.style.left).toBe("8px");
    expect(webview.style.width).toBe("");
    expect(webview.style.height).toBe("");
    expect(webview.style.visibility).toBe("visible");

    webview.dispatchEvent(
      Object.assign(new Event("did-fail-load"), {
        errorCode: -102,
        errorDescription: "ERR_CONNECTION_REFUSED",
        validatedURL: "https://example.com",
        isMainFrame: true,
      }),
    );
    await vi.waitFor(() =>
      expect(bridge.browserWebviewDidFailLoad).toHaveBeenCalledWith({
        tabId: "browser-tab",
        rendererId: -1,
        pageId: "page-1",
        errorCode: -102,
        errorDescription: "ERR_CONNECTION_REFUSED",
        validatedUrl: "https://example.com",
        isMainFrame: true,
      }),
    );

    bridge.emitHostMessage({
      tabId: "browser-tab",
      rendererId: -1,
      delivery: {
        kind: "event",
        name: "browser.state",
        payload: {
          sessionId: "browser-tab",
          activePageId: "page-1",
          pages: [{ id: "page-1", url: "https://example.com/next", title: "Next" }],
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
          insets: { top: 45, right: 8, bottom: 16, left: 8 },
        },
      },
    });
    await vi.waitFor(() => expect(webview.style.top).toBe("45px"));
    expect(document.querySelector("webview")).toBe(webview);
    // Guest navigation updates the Browser address/title state but must not be written back to
    // the live webview's src. Electron treats every src write as a new top-level navigation.
    expect(webview.getAttribute("src")).toBe("https://example.com");
    expect(bridge.browserWebviewAttach).toHaveBeenCalledOnce();
    expect(bridge.browserWebviewDetach).not.toHaveBeenCalled();

    bridge.emitHostMessage({
      tabId: "browser-tab",
      rendererId: -1,
      delivery: {
        kind: "event",
        name: "browser.state",
        payload: {
          sessionId: "browser-tab",
          activePageId: "page-1",
          pages: [
            {
              id: "page-1",
              url: "https://example.com/next",
              title: "Next",
              lastError: "Couldn't open this page.",
            },
          ],
        },
      },
    });
    await vi.waitFor(() => expect(webview.style.visibility).toBe("hidden"));
    expect(document.querySelector("webview")).toBe(webview);
    expect(bridge.browserWebviewDetach).not.toHaveBeenCalled();

    bridge.emitHostMessage({
      tabId: "browser-tab",
      rendererId: -1,
      delivery: {
        kind: "event",
        name: "browser.state",
        payload: {
          sessionId: "browser-tab",
          activePageId: "page-1",
          pages: [
            {
              id: "page-1",
              url: "https://example.com/next",
              title: "Next",
              lastError: null,
            },
          ],
        },
      },
    });
    await vi.waitFor(() => expect(webview.style.visibility).toBe("visible"));
    expect(document.querySelector("webview")).toBe(webview);
    expect(bridge.browserWebviewAttach).toHaveBeenCalledOnce();
    expect(bridge.browserWebviewDetach).not.toHaveBeenCalled();
  });

  it("presents an OAuth auxiliary context as a host-managed Browser page", async () => {
    const bridge = installBridge();
    await render(
      <div className="h-80 w-[640px]">
        <AppDockPane
          appName="Browser"
          documentUrl={FRAME_DOCUMENT}
          rendererId={-2}
          status="ready"
          tabId="oauth-browser-tab"
          visible={true}
        />
      </div>,
    );
    await vi.waitFor(() => expect(bridge.frameReady).toHaveBeenCalledOnce());
    const opener = {
      id: "page-opener",
      url: "https://account.example/login",
      title: "Account",
      presentation: "renderer",
    };
    bridge.emitHostMessage({
      tabId: "oauth-browser-tab",
      rendererId: -2,
      delivery: {
        kind: "event",
        name: "browser.state",
        payload: {
          activePageId: "page-oauth",
          pages: [
            opener,
            {
              id: "page-oauth",
              url: "https://accounts.google.com/o/oauth2/auth",
              title: "Sign in",
              presentation: "host",
            },
          ],
        },
      },
    });
    bridge.emitHostMessage({
      tabId: "oauth-browser-tab",
      rendererId: -2,
      delivery: {
        kind: "event",
        name: "browser.surface",
        payload: {
          partition: "persist:oauth-browser",
          insets: { top: 44, right: 8, bottom: 16, left: 8 },
        },
      },
    });

    await vi.waitFor(() =>
      expect(bridge.browserHostedPageBounds).toHaveBeenCalledWith({
        tabId: "oauth-browser-tab",
        rendererId: -2,
        pageId: "page-oauth",
        bounds: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
        rendererSurfaceActive: true,
      }),
    );
    expect(document.querySelector('[data-hosted-browser-page-id="page-oauth"]')).not.toBeNull();
    expect(document.querySelectorAll("webview")).toHaveLength(1);

    bridge.emitHostMessage({
      tabId: "oauth-browser-tab",
      rendererId: -2,
      delivery: {
        kind: "event",
        name: "browser.state",
        payload: { activePageId: opener.id, pages: [opener] },
      },
    });
    await vi.waitFor(() =>
      expect(bridge.browserHostedPageBounds).toHaveBeenCalledWith({
        tabId: "oauth-browser-tab",
        rendererId: -2,
        pageId: "page-oauth",
        bounds: null,
        rendererSurfaceActive: true,
      }),
    );
    expect(document.querySelector('[data-hosted-browser-page-id="page-oauth"]')).toBeNull();
    expect((document.querySelector("webview") as HTMLElement).style.visibility).toBe("visible");
  });

  it("retains every Browser page while presentation switches between pages and Apps", async () => {
    const bridge = installBridge();
    function Harness() {
      const [visible, setVisible] = useState(true);
      return (
        <>
          <button onClick={() => setVisible((current) => !current)} type="button">
            Toggle Browser
          </button>
          <div className="h-80 w-[640px]">
            <AppDockPane
              appName="Browser"
              documentUrl={FRAME_DOCUMENT}
              rendererId={-3}
              status="ready"
              tabId="retained-browser-tab"
              visible={visible}
            />
          </div>
        </>
      );
    }

    await render(<Harness />);
    await vi.waitFor(() => expect(bridge.frameReady).toHaveBeenCalledOnce());
    const pages = [
      { id: "page-login", url: "https://identity.example/login", title: "Sign in" },
      { id: "page-console", url: "https://console.example/dashboard", title: "Console" },
    ];
    bridge.emitHostMessage({
      tabId: "retained-browser-tab",
      rendererId: -3,
      delivery: {
        kind: "event",
        name: "browser.state",
        payload: { activePageId: "page-login", pages },
      },
    });
    bridge.emitHostMessage({
      tabId: "retained-browser-tab",
      rendererId: -3,
      delivery: {
        kind: "event",
        name: "browser.surface",
        payload: {
          partition: "persist:retained-browser",
          insets: { top: 44, right: 8, bottom: 16, left: 8 },
        },
      },
    });

    await vi.waitFor(() => expect(document.querySelectorAll("webview")).toHaveLength(2));
    const webviews = Array.from(document.querySelectorAll("webview")) as Array<
      HTMLElement & { getWebContentsId(): number }
    >;
    const loginWebview = webviews[0]!;
    const consoleWebview = webviews[1]!;
    loginWebview.getWebContentsId = () => 81;
    consoleWebview.getWebContentsId = () => 82;
    loginWebview.dispatchEvent(new Event("dom-ready"));
    consoleWebview.dispatchEvent(new Event("dom-ready"));
    await vi.waitFor(() => expect(bridge.browserWebviewAttach).toHaveBeenCalledTimes(2));
    expect(loginWebview.style.visibility).toBe("visible");
    expect(consoleWebview.style.visibility).toBe("hidden");

    bridge.emitHostMessage({
      tabId: "retained-browser-tab",
      rendererId: -3,
      delivery: {
        kind: "event",
        name: "browser.state",
        payload: { activePageId: "page-console", pages },
      },
    });
    await vi.waitFor(() => expect(consoleWebview.style.visibility).toBe("visible"));
    expect(loginWebview.style.visibility).toBe("hidden");
    expect(Array.from(document.querySelectorAll("webview"))).toEqual([
      loginWebview,
      consoleWebview,
    ]);
    expect(bridge.browserWebviewDetach).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Toggle Browser" }).click();
    await vi.waitFor(() =>
      expect(bridge.setActive).toHaveBeenLastCalledWith({
        tabId: "retained-browser-tab",
        rendererId: -3,
        active: false,
      }),
    );
    expect(loginWebview.style.visibility).toBe("hidden");
    expect(consoleWebview.style.visibility).toBe("hidden");
    bridge.emitHostMessage({
      tabId: "retained-browser-tab",
      rendererId: -3,
      delivery: { kind: "event", name: "browser.surface", payload: null },
    });
    expect(Array.from(document.querySelectorAll("webview"))).toEqual([
      loginWebview,
      consoleWebview,
    ]);
    expect(bridge.browserWebviewDetach).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Toggle Browser" }).click();
    bridge.emitHostMessage({
      tabId: "retained-browser-tab",
      rendererId: -3,
      delivery: {
        kind: "event",
        name: "browser.surface",
        payload: {
          partition: "persist:retained-browser",
          insets: { top: 44, right: 8, bottom: 16, left: 8 },
        },
      },
    });
    await vi.waitFor(() => expect(consoleWebview.style.visibility).toBe("visible"));
    expect(Array.from(document.querySelectorAll("webview"))).toEqual([
      loginWebview,
      consoleWebview,
    ]);
    expect(bridge.browserWebviewAttach).toHaveBeenCalledTimes(2);
    expect(bridge.browserWebviewDetach).not.toHaveBeenCalled();
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
