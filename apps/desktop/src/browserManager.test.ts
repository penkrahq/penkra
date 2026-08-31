import { EventEmitter } from "node:events";

import { ThreadId } from "@penkra/contracts";
import { nativeImage } from "electron";
import type {
  BrowserView,
  BrowserWindow,
  BrowserWindowConstructorOptions,
  View,
  WebContents,
  WebContentsView,
} from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopBrowserManager } from "./browserManager";

const { loadExtension } = vi.hoisted(() => ({
  loadExtension: vi.fn(async () => ({
    id: "dark-reader-id",
    name: "Dark Reader",
    url: "chrome-extension://dark-reader-id/",
    manifest: {
      browser_action: {
        default_icon: {
          19: "icons/dr_active_19.png",
          38: "icons/dr_active_38.png",
        },
        default_popup: "ui/popup/index.html",
      },
    },
  })),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/tmp/penkra",
    getName: () => "Penkra",
    getPreferredSystemLanguages: () => ["en-US"],
    userAgentFallback:
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Electron/40.0.0 Safari/537.36",
  },
  BrowserWindow: class {},
  clipboard: { writeImage: vi.fn(), writeText: vi.fn() },
  nativeImage: {
    createEmpty: vi.fn(() => ({ isEmpty: () => true, toDataURL: () => "" })),
    createFromBuffer: vi.fn(),
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      toDataURL: () => "data:image/png;base64,dark-reader",
    })),
  },
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getDisplayNearestPoint: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1000, height: 800 },
    })),
  },
  session: {
    fromPartition: () => ({
      extensions: { loadExtension },
      setUserAgent: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn() },
    }),
  },
  webContents: { fromId: vi.fn(() => null) },
  View: class {
    readonly addChildView = vi.fn();
    readonly removeChildView = vi.fn();
    readonly setBounds = vi.fn();
  },
  WebContentsView: class {},
}));

interface WindowOpenDetails {
  url: string;
  frameName: string;
  features: string;
  disposition: string;
  referrer?: { url: string; policy: string };
  postBody?: {
    contentType: string;
    data: Array<{ bytes: Buffer }>;
  };
}

type WindowOpenHandler = (details: WindowOpenDetails) => {
  action: "allow" | "deny";
  overrideBrowserWindowOptions?: object;
  outlivesOpener?: boolean;
  createWindow?: (options: Electron.BrowserWindowConstructorOptions) => WebContents;
};

class FakeWebContents extends EventEmitter {
  readonly id = 1;
  readonly debugger = {
    isAttached: vi.fn(() => false),
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async () => undefined),
  };
  windowOpenHandler: WindowOpenHandler | null = null;
  currentUrl = "https://example.com/";
  currentTitle = "Example";
  loading = false;
  destroyed = false;
  readonly session = { fetch: vi.fn() };

  setUserAgent = vi.fn();
  setZoomFactor = vi.fn();
  isDestroyed = vi.fn(() => this.destroyed);
  close = vi.fn(() => {
    this.destroyed = true;
    this.emit("destroyed");
  });
  findInPage = vi.fn(() => 7);
  executeJavaScript = vi.fn(async (): Promise<unknown[]> => []);
  getURL = vi.fn(() => this.currentUrl);
  getTitle = vi.fn(() => this.currentTitle);
  getProcessId = vi.fn(() => 101);
  isLoading = vi.fn(() => this.loading);
  canGoBack = vi.fn(() => false);
  canGoForward = vi.fn(() => false);
  capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from("png") }));
  loadURL = vi.fn(async (url: string, _options?: Electron.LoadURLOptions) => {
    this.currentUrl = url;
  });

  setWindowOpenHandler(handler: WindowOpenHandler): void {
    this.windowOpenHandler = handler;
  }
}

class FakePopupWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  readonly hide = vi.fn();
  readonly show = vi.fn(() => this.emit("show"));
  readonly destroy = vi.fn(() => this.emit("closed"));
  readonly isDestroyed = vi.fn(() => false);
  readonly setMenuBarVisibility = vi.fn();
  readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 480, height: 640 }));
  readonly setBounds = vi.fn();
}

class FakeNativeView {
  readonly addChildView = vi.fn();
  readonly removeChildView = vi.fn();
  readonly setBounds = vi.fn();
  readonly setVisible = vi.fn();
}

class FakeHostedPageView extends FakeNativeView {
  constructor(readonly webContents: FakeWebContents) {
    super();
  }
}

interface BrowserManagerCharacterizationAccess {
  configureRuntimeWebContents(runtime: {
    key: string;
    threadId: ThreadId;
    tabId: string;
    webContents: WebContents;
    view: null;
    ownsWebContents: false;
    listenerDisposers: Array<() => void>;
  }): void;
  configureOAuthPopupRuntime(runtime: {
    threadId: ThreadId;
    tabId: string;
    window: BrowserWindow;
    listenerDisposers: Array<() => void>;
  }): void;
  syncRuntimeState(threadId: ThreadId, tabId: string): void;
}

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function asCharacterizationAccess(
  manager: DesktopBrowserManager,
): BrowserManagerCharacterizationAccess {
  return manager as unknown as BrowserManagerCharacterizationAccess;
}

describe("DesktopBrowserManager repeated workflow characterization", () => {
  it("detaches browser session authority before publishing its closed state", () => {
    const manager = new DesktopBrowserManager();
    const observed: Array<{ open: boolean; authorityPresent: boolean }> = [];
    manager.setSessionPartition("thread-close" as never, "persist:app-close");
    manager.open({ threadId: "thread-close" as never });
    manager.subscribe((state) => {
      observed.push({
        open: state.open,
        authorityPresent: manager.hasSession("thread-close" as never),
      });
    });

    const state = manager.close({ threadId: "thread-close" as never });

    expect(state.open).toBe(false);
    expect(manager.hasSession("thread-close" as never)).toBe(false);
    expect(observed).toEqual([{ open: false, authorityPresent: false }]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the built-in Dark Reader action into the scoped Browser session", async () => {
    const manager = new DesktopBrowserManager();

    await manager.prepareExtensions(THREAD_ID);

    expect(loadExtension).toHaveBeenCalledTimes(1);
    expect(manager.extensionActions(THREAD_ID)).toEqual([
      {
        id: "dark-reader-id",
        name: "Dark Reader",
        iconDataUrl: "data:image/png;base64,dark-reader",
      },
    ]);
  });

  it("settles native find results and removes its listeners", async () => {
    const manager = new DesktopBrowserManager();
    const webContents = new FakeWebContents();
    const runtimes = (
      manager as unknown as {
        runtimes: Map<string, { webContents: FakeWebContents }>;
      }
    ).runtimes;
    runtimes.set(`${THREAD_ID}:tab-1`, { webContents });

    const resultPromise = manager.findInPage({
      threadId: THREAD_ID,
      tabId: "tab-1",
      text: "needle",
      action: "search",
    });
    webContents.emit(
      "found-in-page",
      {},
      {
        requestId: 7,
        activeMatchOrdinal: 2,
        matches: 3,
        finalUpdate: true,
      },
    );

    await expect(resultPromise).resolves.toEqual({
      activeMatchOrdinal: 2,
      matches: 3,
    });
    expect(webContents.listenerCount("found-in-page")).toBe(0);
    expect(webContents.listenerCount("destroyed")).toBe(0);
  });

  it("times out a native find request that never sends a final update", async () => {
    vi.useFakeTimers();
    try {
      const manager = new DesktopBrowserManager();
      const webContents = new FakeWebContents();
      const runtimes = (
        manager as unknown as {
          runtimes: Map<string, { webContents: FakeWebContents }>;
        }
      ).runtimes;
      runtimes.set(`${THREAD_ID}:tab-1`, { webContents });

      const resultPromise = manager.findInPage({
        threadId: THREAD_ID,
        tabId: "tab-1",
        text: "needle",
        action: "search",
      });
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(resultPromise).resolves.toEqual({
        activeMatchOrdinal: 0,
        matches: 0,
      });
      expect(webContents.listenerCount("found-in-page")).toBe(0);
      expect(webContents.listenerCount("destroyed")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits one state change when a different tab becomes active", () => {
    const manager = new DesktopBrowserManager();
    const initial = manager.open({ threadId: THREAD_ID });
    const firstTabId = initial.activeTabId;
    const withSecondTab = manager.newTab({
      threadId: THREAD_ID,
      url: "https://second.example",
      activate: false,
    });
    const secondTabId = withSecondTab.tabs.at(-1)?.id;
    const states = vi.fn();
    manager.subscribe(states);

    expect(firstTabId).not.toBeNull();
    expect(secondTabId).toBeDefined();
    if (!secondTabId) return;
    expect(withSecondTab.activeTabId).toBe(firstTabId);

    const selected = manager.selectTab({
      threadId: THREAD_ID,
      tabId: secondTabId,
    });
    expect(selected.activeTabId).toBe(secondTabId);
    expect(states).toHaveBeenCalledTimes(1);

    manager.selectTab({ threadId: THREAD_ID, tabId: secondTabId });
    expect(states).toHaveBeenCalledTimes(1);
  });

  it("recovers a failed renderer page when Reload has no live runtime", () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "https://example.com/failed",
    });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const state = (
      manager as unknown as {
        states: Map<
          ThreadId,
          {
            tabs: Array<{
              id: string;
              isLoading: boolean;
              lastError: string | null;
            }>;
          }
        >;
      }
    ).states.get(THREAD_ID);
    const tab = state?.tabs.find((candidate) => candidate.id === tabId);
    expect(tab).toBeDefined();
    if (!tab) return;
    tab.isLoading = false;
    tab.lastError = "Couldn't open this page.";

    const onState = vi.fn();
    manager.subscribe(onState);
    const recovered = manager.reload({ threadId: THREAD_ID, tabId });

    expect(recovered.tabs.find((candidate) => candidate.id === tabId)).toMatchObject({
      isLoading: true,
      lastError: null,
    });
    expect(onState).toHaveBeenCalledOnce();
  });

  it("recovers an initial WebView failure missed before attachment from chrome-error state", () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "http://127.0.0.1:41997/",
    });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    tabContents.currentUrl = "chrome-error://chromewebdata/";
    tabContents.currentTitle = "127.0.0.1";
    tabContents.loading = false;
    const runtime = {
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null,
      ownsWebContents: false as const,
      listenerDisposers: [],
    };
    (
      manager as unknown as {
        runtimes: Map<string, typeof runtime>;
      }
    ).runtimes.set(runtime.key, runtime);

    asCharacterizationAccess(manager).syncRuntimeState(THREAD_ID, tabId);

    expect(manager.getState({ threadId: THREAD_ID }).tabs[0]).toMatchObject({
      url: "http://127.0.0.1:41997/",
      lastCommittedUrl: null,
      lastError: "Couldn't open this page.",
      isLoading: false,
    });
  });

  it("records an initial renderer-owned WebView failure before main-process attachment", () => {
    const reportLoadFailure = vi.fn();
    const manager = new DesktopBrowserManager({ reportLoadFailure });
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "http://127.0.0.1:41996/",
    });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const failure = {
      threadId: THREAD_ID,
      tabId,
      errorCode: -102,
      errorDescription: "ERR_CONNECTION_REFUSED",
      validatedUrl: "http://127.0.0.1:41996/",
      isMainFrame: true,
    } as const;
    manager.reportRendererWebviewLoadFailure(failure);
    manager.reportRendererWebviewLoadFailure(failure);

    expect(manager.getState({ threadId: THREAD_ID }).tabs[0]).toMatchObject({
      url: "http://127.0.0.1:41996/",
      lastError: "Connection refused.",
      isLoading: false,
    });
    expect(reportLoadFailure).toHaveBeenCalledWith({
      source: "did-fail-load",
      threadId: THREAD_ID,
      tabId,
      url: "http://127.0.0.1:41996/",
      errorCode: -102,
      errorDescription: "ERR_CONNECTION_REFUSED",
    });
    expect(reportLoadFailure).toHaveBeenCalledOnce();
  });

  it("keeps a document that committed before loadURL rejected", async () => {
    const reportLoadFailure = vi.fn();
    const manager = new DesktopBrowserManager({ reportLoadFailure });
    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    tabContents.currentUrl = "about:blank";
    tabContents.currentTitle = "New tab";
    tabContents.loadURL.mockImplementation(async () => {
      tabContents.currentUrl = "https://mail.google.com/mail/u/0/#inbox";
      tabContents.currentTitle = "Inbox - Gmail";
      tabContents.emit("did-navigate", {}, tabContents.currentUrl);
      throw new Error("ERR_FAILED (-2) loading 'https://gmail.com/'");
    });
    const runtime = {
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null,
      ownsWebContents: false as const,
      listenerDisposers: [],
    };
    asCharacterizationAccess(manager).configureRuntimeWebContents(runtime);
    (
      manager as unknown as {
        runtimes: Map<string, typeof runtime>;
      }
    ).runtimes.set(runtime.key, runtime);

    manager.navigate({ threadId: THREAD_ID, tabId, url: "https://gmail.com" });

    await vi.waitFor(() => {
      expect(manager.getState({ threadId: THREAD_ID }).tabs[0]).toMatchObject({
        url: "https://mail.google.com/mail/u/0/#inbox",
        title: "Inbox - Gmail",
        lastError: null,
      });
    });
    expect(tabContents.loadURL).toHaveBeenCalledOnce();
    expect(reportLoadFailure).not.toHaveBeenCalled();
  });

  it("retains the loadURL fallback when no document committed and no failure event arrived", async () => {
    const reportLoadFailure = vi.fn();
    const manager = new DesktopBrowserManager({ reportLoadFailure });
    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    tabContents.currentUrl = "about:blank";
    tabContents.currentTitle = "New tab";
    tabContents.loadURL.mockRejectedValue(
      new Error("ERR_FAILED (-2) loading 'https://unavailable.example/'"),
    );
    const runtime = {
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null,
      ownsWebContents: false as const,
      listenerDisposers: [],
    };
    asCharacterizationAccess(manager).configureRuntimeWebContents(runtime);
    (
      manager as unknown as {
        runtimes: Map<string, typeof runtime>;
      }
    ).runtimes.set(runtime.key, runtime);

    manager.navigate({
      threadId: THREAD_ID,
      tabId,
      url: "https://unavailable.example",
    });

    await vi.waitFor(() => {
      expect(manager.getState({ threadId: THREAD_ID }).tabs[0]?.lastError).toBe(
        "Couldn't open this page.",
      );
    });
    expect(reportLoadFailure).toHaveBeenCalledOnce();
  });

  it("recovers a missed page favicon on attach and converts it to an App-safe data URL", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "https://example.com",
    });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    tabContents.executeJavaScript.mockResolvedValue(["https://example.com/favicon.ico"]);
    tabContents.session.fetch.mockResolvedValue(
      new Response(Uint8Array.from([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
      }),
    );
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue({
      isEmpty: () => false,
      toDataURL: () => "data:image/png;base64,AQID",
    } as Electron.NativeImage);

    const runtime = {
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null,
      ownsWebContents: false as const,
      listenerDisposers: [],
    };
    (
      manager as unknown as {
        runtimes: Map<string, typeof runtime>;
      }
    ).runtimes.set(runtime.key, runtime);
    asCharacterizationAccess(manager).configureRuntimeWebContents(runtime);

    await vi.waitFor(() => {
      expect(
        manager.getState({ threadId: THREAD_ID }).tabs.find((tab) => tab.id === tabId)?.faviconUrl,
      ).toBe("data:image/png;base64,AQID");
    });
    expect(tabContents.session.fetch).toHaveBeenCalledWith("https://example.com/favicon.ico");
  });

  it("reports the underlying Electron load failure while keeping concise UI copy", () => {
    const reportLoadFailure = vi.fn();
    const manager = new DesktopBrowserManager({ reportLoadFailure });
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "https://example.com",
    });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    asCharacterizationAccess(manager).configureRuntimeWebContents({
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });

    tabContents.emit(
      "did-fail-load",
      {},
      -7,
      "ERR_TIMED_OUT_DURING_REDIRECT",
      "https://example.com/redirect",
      true,
    );

    expect(reportLoadFailure).toHaveBeenCalledWith({
      source: "did-fail-load",
      threadId: THREAD_ID,
      tabId,
      url: "https://example.com/redirect",
      errorCode: -7,
      errorDescription: "ERR_TIMED_OUT_DURING_REDIRECT",
    });
    expect(
      manager.getState({ threadId: THREAD_ID }).tabs.find((tab) => tab.id === tabId)?.lastError,
    ).toBe("Couldn't open this page.");
  });

  it("applies the same popup, tab-open, and scheme-denial policy to tabs and popups", async () => {
    const auxiliaryContents: FakeWebContents[] = [];
    const manager = new DesktopBrowserManager({
      createBrowserView: (options) => {
        const contents =
          (
            options as BrowserWindowConstructorOptions & {
              webContents?: FakeWebContents;
            }
          ).webContents ?? new FakeWebContents();
        expect(contents.setUserAgent).toHaveBeenCalledTimes(1);
        auxiliaryContents.push(contents);
        return new FakeHostedPageView(contents) as unknown as BrowserView;
      },
    });
    const initial = manager.open({ threadId: THREAD_ID });
    const tabId = initial.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;
    manager.newTab({
      threadId: THREAD_ID,
      url: "https://background.example",
      activate: false,
    });

    const tabContents = new FakeWebContents();
    const popup = new FakePopupWindow();
    const access = asCharacterizationAccess(manager);
    access.configureRuntimeWebContents({
      key: `thread-1:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    access.configureOAuthPopupRuntime({
      threadId: THREAD_ID,
      tabId,
      window: popup as unknown as BrowserWindow,
      listenerDisposers: [],
    });

    const handlers = [tabContents.windowOpenHandler, popup.webContents.windowOpenHandler];
    expect(handlers.every(Boolean)).toBe(true);
    for (const handler of handlers) {
      if (!handler) continue;
      const sourceContents =
        handler === tabContents.windowOpenHandler ? tabContents : popup.webContents;
      const beforePopupOpen = manager.getState({ threadId: THREAD_ID });
      const popupResponse = handler({
        url: "https://auth.example",
        frameName: "auth",
        features: "width=480,height=640",
        disposition: "new-window",
      });
      expect(popupResponse).toMatchObject({
        action: "allow",
        createWindow: expect.any(Function),
      });
      const chromiumPopupContents = new FakeWebContents();
      const popupContents = popupResponse.createWindow?.({
        webPreferences: {},
        webContents: chromiumPopupContents,
      } as BrowserWindowConstructorOptions);
      expect(popupContents).toBe(chromiumPopupContents);
      expect(popupContents).toBe(auxiliaryContents.at(-1));
      expect(chromiumPopupContents.setUserAgent).toHaveBeenCalledTimes(3);
      expect(chromiumPopupContents.debugger.attach).toHaveBeenCalledWith("1.3");
      expect(chromiumPopupContents.debugger.sendCommand).toHaveBeenCalledWith(
        "Emulation.setUserAgentOverride",
        expect.objectContaining({ userAgent: expect.not.stringMatching(/Electron/iu) }),
      );
      const afterPopupOpen = manager.getState({ threadId: THREAD_ID });
      expect(afterPopupOpen.tabs).toHaveLength(beforePopupOpen.tabs.length + 1);
      expect(
        afterPopupOpen.tabs.find((tab) => tab.id === afterPopupOpen.activeTabId)?.presentation,
      ).toBe("host");
      auxiliaryContents.at(-1)?.emit("destroyed");
      expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(
        beforePopupOpen.tabs.length,
      );
      expect(manager.getState({ threadId: THREAD_ID }).activeTabId).toBe(tabId);

      const beforeFormOpen = manager.getState({ threadId: THREAD_ID }).tabs.length;
      const genericFormResponse = handler({
        url: "https://account.example/signed-handoff",
        frameName: "",
        features: "",
        disposition: "foreground-tab",
        referrer: {
          url: "https://account.example/dashboard",
          policy: "strict-origin-when-cross-origin",
        },
        postBody: {
          contentType: "application/x-www-form-urlencoded",
          data: [{ bytes: Buffer.from("csrf=redacted&service=123") }],
        },
      });
      expect(genericFormResponse).toMatchObject({
        action: "allow",
        outlivesOpener: true,
        createWindow: expect.any(Function),
      });
      genericFormResponse.createWindow?.({
        webPreferences: {},
        webContents: new FakeWebContents(),
      } as BrowserWindowConstructorOptions);
      expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(beforeFormOpen + 1);
      auxiliaryContents.at(-1)?.emit("destroyed");

      const formResponse = handler({
        url: "https://management.mxroute.com/panel-login",
        frameName: "",
        features: "",
        disposition: "foreground-tab",
        postBody: {
          contentType: "application/x-www-form-urlencoded",
          data: [{ bytes: Buffer.from("csrf_token=redacted&service_id=123") }],
        },
      });
      expect(formResponse).toMatchObject({
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: { show: false },
      });
      const afterFormOpen = manager.getState({ threadId: THREAD_ID });
      expect(afterFormOpen.tabs).toHaveLength(beforeFormOpen);

      const handoffPopup = new FakePopupWindow();
      handoffPopup.webContents.currentUrl = "https://management.mxroute.com/panel-login";
      sourceContents.emit("did-create-window", handoffPopup as unknown as BrowserWindow, {
        url: "https://management.mxroute.com/panel-login",
        frameName: "",
        options: {},
        referrer: {
          url: "https://account.example/dashboard",
          policy: "strict-origin",
        },
        disposition: "foreground-tab",
      });
      expect(handoffPopup.hide).toHaveBeenCalledOnce();
      handoffPopup.webContents.currentUrl = "https://panel.mxroute.com/dashboard.php";
      handoffPopup.webContents.emit("did-finish-load");
      await vi.waitFor(() => expect(handoffPopup.destroy).toHaveBeenCalledOnce());
      const afterHandoff = manager.getState({ threadId: THREAD_ID });
      expect(afterHandoff.tabs).toHaveLength(beforeFormOpen + 1);
      expect(afterHandoff.tabs.find((tab) => tab.id === afterHandoff.activeTabId)?.url).toBe(
        "https://panel.mxroute.com/dashboard.php",
      );

      const beforeTabOpen = manager.getState({ threadId: THREAD_ID }).tabs.length;
      const tabResponse = handler({
        url: "https://docs.example",
        frameName: "",
        features: "",
        disposition: "foreground-tab",
      });
      expect(tabResponse).toMatchObject({
        action: "allow",
        outlivesOpener: true,
        createWindow: expect.any(Function),
      });
      const chromiumTabContents = new FakeWebContents();
      expect(
        tabResponse.createWindow?.({
          webPreferences: {},
          webContents: chromiumTabContents,
        } as BrowserWindowConstructorOptions),
      ).toBe(chromiumTabContents);
      const afterTabOpen = manager.getState({ threadId: THREAD_ID });
      expect(afterTabOpen.tabs).toHaveLength(beforeTabOpen + 1);
      expect(afterTabOpen.tabs.find((tab) => tab.id === afterTabOpen.activeTabId)?.url).toBe(
        "https://docs.example",
      );
      expect(
        afterTabOpen.tabs.find((tab) => tab.id === afterTabOpen.activeTabId)?.presentation,
      ).toBe("host");

      const beforeSchemeDenial = afterTabOpen.tabs.length;
      expect(
        handler({
          url: "penkra://unsafe",
          frameName: "",
          features: "",
          disposition: "foreground-tab",
        }),
      ).toEqual({ action: "deny" });
      expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(beforeSchemeDenial);
    }
  });

  it("gives the shell first refusal on browser guest keyboard input", () => {
    const beforeInputEvent = vi.fn((event: Electron.Event) => {
      event.preventDefault();
      return true;
    });
    const manager = new DesktopBrowserManager({
      beforeInputEvent,
      getWindowZoomFactor: () => 1.2,
    });
    const initial = manager.open({ threadId: THREAD_ID });
    const tabId = initial.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    asCharacterizationAccess(manager).configureRuntimeWebContents({
      key: `thread-1:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    expect(tabContents.setZoomFactor).toHaveBeenCalledWith(1.2);
    const event = {
      preventDefault: vi.fn(),
      defaultPrevented: false,
    };
    const input = {
      type: "keyDown",
      key: "-",
      code: "Minus",
      isAutoRepeat: false,
      isComposing: false,
      shift: false,
      control: true,
      alt: false,
      meta: false,
      location: 0,
      modifiers: ["control"],
    };

    tabContents.emit("before-input-event", event, input);

    expect(beforeInputEvent).toHaveBeenCalledWith(event, input);
    expect(event.preventDefault).toHaveBeenCalledOnce();

    (
      manager as unknown as {
        runtimes: Map<string, { webContents: WebContents }>;
      }
    ).runtimes.set("zoom-test", {
      webContents: tabContents as unknown as WebContents,
    });
    manager.setZoomFactor(0.8);
    expect(tabContents.setZoomFactor).toHaveBeenLastCalledWith(0.8);
  });

  it("contains hosted native pages in an App-aligned clipping view using App-local bounds", () => {
    const manager = new DesktopBrowserManager();
    const windowRoot = new FakeNativeView();
    manager.setWindow({
      contentView: windowRoot,
      isDestroyed: () => false,
    } as unknown as BrowserWindow);

    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const internalState = (
      manager as unknown as {
        states: Map<ThreadId, { tabs: Array<{ id: string; status: "live" | "suspended" }> }>;
      }
    ).states.get(THREAD_ID);
    const activeTab = internalState?.tabs.find((tab) => tab.id === tabId);
    expect(activeTab).toBeDefined();
    if (!activeTab) return;
    activeTab.status = "live";

    const pageContents = new FakeWebContents() as unknown as WebContents & {
      getURL: () => string;
      getTitle: () => string;
      isLoading: () => boolean;
      canGoBack: () => boolean;
      canGoForward: () => boolean;
      isDestroyed: () => boolean;
    };
    pageContents.getURL = () => "about:blank";
    pageContents.getTitle = () => "New tab";
    pageContents.isLoading = () => false;
    pageContents.canGoBack = () => false;
    pageContents.canGoForward = () => false;
    pageContents.isDestroyed = () => false;
    const pageView = new FakeNativeView();
    (
      manager as unknown as {
        runtimes: Map<
          string,
          {
            key: string;
            threadId: ThreadId;
            tabId: string;
            webContents: WebContents;
            view: WebContentsView;
            ownsWebContents: true;
            listenerDisposers: Array<() => void>;
          }
        >;
      }
    ).runtimes.set(`${THREAD_ID}:${tabId}`, {
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: pageContents,
      view: pageView as unknown as WebContentsView,
      ownsWebContents: true,
      listenerDisposers: [],
    });

    const firstHost = new FakeNativeView();
    const hostBounds = { x: 860, y: 42, width: 420, height: 700 };
    const localBounds = { x: 0, y: 84, width: 420, height: 616 };
    manager.setHostedPanelBounds({
      threadId: THREAD_ID,
      parentView: firstHost as unknown as View,
      hostBounds,
      bounds: localBounds,
    });

    const hostedContainer = (
      manager as unknown as {
        hostedContainerByThreadId: Map<ThreadId, { view: FakeNativeView }>;
      }
    ).hostedContainerByThreadId.get(THREAD_ID)?.view;
    expect(hostedContainer).toBeDefined();
    if (!hostedContainer) return;
    expect(hostedContainer.setBounds).toHaveBeenLastCalledWith(hostBounds);
    expect(hostedContainer.addChildView).toHaveBeenCalledWith(pageView);
    expect(windowRoot.addChildView).toHaveBeenCalledWith(hostedContainer);
    expect(pageView.setBounds).toHaveBeenLastCalledWith(localBounds);

    const resizedLocalBounds = { x: 0, y: 84, width: 320, height: 516 };
    manager.setHostedPanelBounds({
      threadId: THREAD_ID,
      parentView: firstHost as unknown as View,
      hostBounds: { ...hostBounds, width: 320, height: 600 },
      bounds: resizedLocalBounds,
    });

    expect(pageView.setBounds).toHaveBeenLastCalledWith(resizedLocalBounds);

    const replacementHost = new FakeNativeView();
    manager.setHostedPanelBounds({
      threadId: THREAD_ID,
      parentView: replacementHost as unknown as View,
      hostBounds: { ...hostBounds, width: 320, height: 600 },
      bounds: resizedLocalBounds,
    });

    expect(hostedContainer.removeChildView).toHaveBeenCalledWith(pageView);
    expect(hostedContainer.addChildView).toHaveBeenCalledTimes(3);

    manager.setHostedPanelBounds({
      threadId: THREAD_ID,
      parentView: null,
      hostBounds: null,
      bounds: null,
    });

    expect(hostedContainer.removeChildView).toHaveBeenCalledWith(pageView);
    expect(windowRoot.removeChildView).toHaveBeenCalledWith(hostedContainer);
    expect(pageView.setVisible).toHaveBeenLastCalledWith(false);
    expect(pageView.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("tracks renderer surface activity without accepting renderer geometry", () => {
    const manager = new DesktopBrowserManager();
    const setPanelBounds = vi.spyOn(manager, "setPanelBounds");

    manager.setRendererSurfaceActive(THREAD_ID, true);
    manager.setRendererSurfaceActive(THREAD_ID, false);

    expect(setPanelBounds).toHaveBeenNthCalledWith(1, {
      threadId: THREAD_ID,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      surface: "renderer",
    });
    expect(setPanelBounds).toHaveBeenNthCalledWith(2, {
      threadId: THREAD_ID,
      bounds: null,
      surface: "renderer",
    });
  });

  it("retains a hidden renderer runtime without time-based suspension", async () => {
    vi.useFakeTimers();
    try {
      const manager = new DesktopBrowserManager();
      const opened = manager.open({
        threadId: THREAD_ID,
        initialUrl: "https://console.example",
      });
      const tabId = opened.activeTabId;
      expect(tabId).not.toBeNull();
      if (!tabId) return;

      manager.setRendererSurfaceActive(THREAD_ID, true);
      const webContents = new FakeWebContents();
      const runtimes = (
        manager as unknown as {
          runtimes: Map<
            string,
            {
              key: string;
              threadId: ThreadId;
              tabId: string;
              webContents: WebContents;
              view: null;
              ownsWebContents: false;
              listenerDisposers: Array<() => void>;
            }
          >;
        }
      ).runtimes;
      const key = `${THREAD_ID}:${tabId}`;
      runtimes.set(key, {
        key,
        threadId: THREAD_ID,
        tabId,
        webContents: webContents as unknown as WebContents,
        view: null,
        ownsWebContents: false,
        listenerDisposers: [],
      });

      manager.setRendererSurfaceActive(THREAD_ID, false);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(runtimes.get(key)?.webContents).toBe(webContents);
      expect(webContents.isDestroyed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives agents the existing live page while its Browser App is hidden", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "https://console.example",
    });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const webContents = new FakeWebContents();
    webContents.currentUrl = "https://console.example/dashboard";
    const key = `${THREAD_ID}:${tabId}`;
    (
      manager as unknown as {
        runtimes: Map<
          string,
          {
            key: string;
            threadId: ThreadId;
            tabId: string;
            webContents: WebContents;
            view: null;
            ownsWebContents: false;
            listenerDisposers: Array<() => void>;
          }
        >;
      }
    ).runtimes.set(key, {
      key,
      threadId: THREAD_ID,
      tabId,
      webContents: webContents as unknown as WebContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    const internal = (
      manager as unknown as {
        states: Map<ThreadId, { tabs: Array<{ id: string; status: "live" | "suspended" }> }>;
      }
    ).states.get(THREAD_ID);
    const tab = internal?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error("Expected Browser tab state.");
    tab.status = "live";

    manager.hide({ threadId: THREAD_ID });
    const observed = await manager.observationWebContents(THREAD_ID);

    expect(observed).toBe(webContents);
    expect(webContents.loadURL).not.toHaveBeenCalled();
    expect(webContents.debugger.attach).toHaveBeenCalledWith("1.3");
  });

  it("attributes adopted runtimes, observation preparation, evaluation, and capture", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "https://console.example",
    });
    const tabId = opened.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const webContents = new FakeWebContents();
    webContents.currentUrl = "https://console.example/";
    const key = `${THREAD_ID}:${tabId}`;
    (
      manager as unknown as {
        runtimes: Map<
          string,
          {
            key: string;
            threadId: ThreadId;
            tabId: string;
            webContents: WebContents;
            view: null;
            ownsWebContents: false;
            listenerDisposers: Array<() => void>;
          }
        >;
      }
    ).runtimes.set(key, {
      key,
      threadId: THREAD_ID,
      tabId,
      webContents: webContents as unknown as WebContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    const internal = (
      manager as unknown as {
        states: Map<ThreadId, { tabs: Array<{ id: string; status: "live" | "suspended" }> }>;
      }
    ).states.get(THREAD_ID);
    const tab = internal?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error("Expected Browser tab state.");
    tab.status = "live";

    await manager.observationWebContents(THREAD_ID);
    await manager.executeCdp({
      threadId: THREAD_ID,
      tabId,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    await manager.captureScreenshot({ threadId: THREAD_ID, tabId });

    expect(manager.getPerformanceSnapshot().counters).toMatchObject({
      adoptedRendererRuntimeCount: 1,
      ownedRuntimeCount: 0,
      prepareObservationCalls: 1,
      executeCdpCalls: 1,
      captureScreenshotCalls: 1,
      captureScreenshotBytes: 3,
    });
    expect(
      manager.getPerformanceSnapshot().counters.prepareObservationTotalMs,
    ).toBeGreaterThanOrEqual(0);
    expect(manager.getPerformanceSnapshot().counters.executeCdpTotalMs).toBeGreaterThanOrEqual(0);
    expect(
      manager.getPerformanceSnapshot().counters.captureScreenshotTotalMs,
    ).toBeGreaterThanOrEqual(0);
  });
});
