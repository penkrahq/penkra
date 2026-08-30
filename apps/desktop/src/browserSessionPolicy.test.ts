import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  headerListener: {
    current: null as
      | null
      | ((
          details: { requestHeaders: Record<string, string> },
          callback: (result: { requestHeaders: Record<string, string> }) => void,
        ) => void),
  },
  fromPartition: vi.fn(),
  partitionSetUserAgent: vi.fn(),
  onBeforeSendHeaders: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getName: () => "Penkra",
    getPreferredSystemLanguages: () => ["en-US", "it-IT"],
    userAgentFallback:
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Electron/40.0.0 Safari/537.36 Penkra/0.5.5",
  },
  session: {
    fromPartition: electronMocks.fromPartition,
  },
}));

import {
  BROWSER_SESSION_PARTITION,
  BrowserSessionPolicy,
  createScopedBrowserSessionPartition,
} from "./browserSessionPolicy";

describe("BrowserSessionPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.headerListener.current = null;
    electronMocks.onBeforeSendHeaders.mockImplementation((listener) => {
      electronMocks.headerListener.current = listener;
    });
    electronMocks.fromPartition.mockReturnValue({
      setUserAgent: electronMocks.partitionSetUserAgent,
      webRequest: { onBeforeSendHeaders: electronMocks.onBeforeSendHeaders },
    });
  });

  it("configures the persistent partition only once", () => {
    const policy = new BrowserSessionPolicy();

    policy.ensureConfigured();
    policy.ensureConfigured();

    expect(electronMocks.fromPartition).toHaveBeenCalledOnce();
    expect(electronMocks.fromPartition).toHaveBeenCalledWith(BROWSER_SESSION_PARTITION);
    expect(electronMocks.partitionSetUserAgent).toHaveBeenCalledOnce();
    expect(electronMocks.onBeforeSendHeaders).toHaveBeenCalledOnce();
  });

  it("derives stable opaque App/Space partitions and configures each independently", () => {
    const personal = createScopedBrowserSessionPartition("com.penkra.browser", "personal");
    const work = createScopedBrowserSessionPartition("com.penkra.browser", "work");
    expect(personal).toBe(createScopedBrowserSessionPartition("com.penkra.browser", "personal"));
    expect(personal).not.toBe(work);
    expect(personal).not.toContain("personal");
    const policy = new BrowserSessionPolicy();
    policy.ensureConfigured(personal);
    policy.ensureConfigured(work);
    expect(electronMocks.fromPartition).toHaveBeenCalledWith(personal);
    expect(electronMocks.fromPartition).toHaveBeenCalledWith(work);
  });

  it("replaces identity headers case-insensitively while retaining the Penkra product token", () => {
    const policy = new BrowserSessionPolicy();
    policy.ensureConfigured();
    const listener = electronMocks.headerListener.current;
    expect(listener).not.toBeNull();
    if (!listener) return;

    const headers = {
      "user-agent": "Old Electron/40.0.0",
      "SEC-CH-UA": '"Electron";v="40"',
      "accept-language": "fr",
      "X-Preserved": "yes",
    };
    const callback = vi.fn();
    listener({ requestHeaders: headers }, callback);

    expect(callback).toHaveBeenCalledWith({ requestHeaders: headers });
    expect(headers["X-Preserved"]).toBe("yes");
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    expect(normalizedHeaders["user-agent"]).not.toMatch(/Electron/iu);
    expect(normalizedHeaders["user-agent"]).toContain("Penkra/0.5.5");
    expect(normalizedHeaders["sec-ch-ua"]).not.toMatch(/Electron/iu);
    expect(normalizedHeaders["sec-ch-ua"]).not.toContain("Google Chrome");
    expect(normalizedHeaders["sec-ch-ua"]).toContain("Chromium");
    expect(normalizedHeaders["accept-language"]).toContain("en-US");
    for (const name of ["user-agent", "sec-ch-ua", "accept-language"]) {
      expect(Object.keys(headers).filter((key) => key.toLowerCase() === name)).toHaveLength(1);
    }
  });

  it("retries partition configuration after a transient failure", () => {
    electronMocks.fromPartition.mockImplementationOnce(() => {
      throw new Error("session not ready");
    });
    const policy = new BrowserSessionPolicy();

    policy.ensureConfigured();
    policy.ensureConfigured();

    expect(electronMocks.fromPartition).toHaveBeenCalledTimes(2);
    expect(electronMocks.partitionSetUserAgent).toHaveBeenCalledOnce();
    expect(electronMocks.onBeforeSendHeaders).toHaveBeenCalledOnce();
  });

  it("builds hardened popup options with an optional parent", () => {
    const policy = new BrowserSessionPolicy();
    const parent = {} as BrowserWindow;

    expect(policy.buildOAuthPopupWindowOptions(parent)).toMatchObject({
      parent,
      webPreferences: {
        partition: BROWSER_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect(policy.buildOAuthPopupWindowOptions(null)).not.toHaveProperty("parent");
  });

  it("applies the same derived identity to the partition, tabs, and popups", () => {
    const policy = new BrowserSessionPolicy();
    const firstContents = { setUserAgent: vi.fn() };
    const secondContents = { setUserAgent: vi.fn() };

    policy.ensureConfigured();
    policy.applyUserAgent(firstContents);
    policy.applyUserAgent(secondContents);

    const partitionUserAgent = electronMocks.partitionSetUserAgent.mock.calls[0]?.[0];
    expect(partitionUserAgent).not.toMatch(/Electron/iu);
    expect(partitionUserAgent).toContain("Penkra/0.5.5");
    expect(firstContents.setUserAgent).toHaveBeenCalledWith(partitionUserAgent);
    expect(secondContents.setUserAgent).toHaveBeenCalledWith(partitionUserAgent);
  });
});
