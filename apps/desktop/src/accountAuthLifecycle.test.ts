import type { IpcMain, BrowserWindow, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: new Map<string, (...args: unknown[]) => void>(),
  authenticate: vi.fn<
    () => Promise<{
      data: { user: Record<string, unknown> } | null;
      error: { message: string } | null;
    }>
  >(),
  getSession: vi.fn(() => Promise.resolve({ data: { user: { id: "account" } }, error: null })),
  signOut: vi.fn(() => Promise.resolve()),
}));
vi.mock("electron", () => ({
  app: {
    on: (event: string, listener: (...args: unknown[]) => void) =>
      mocks.events.set(event, listener),
    whenReady: () => Promise.resolve(),
  },
}));
vi.mock("@better-auth/electron/client", () => ({ electronClient: () => ({}) }));
vi.mock("@better-auth/electron/storage", () => ({ storage: () => ({}) }));
vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({ ...mocks, setupMain: vi.fn() }),
}));
import { configurePenkraAccountAuth } from "./accountAuth";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { deferred } from "./deferred.test-support";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.clear();
  mocks.authenticate.mockImplementation(() =>
    Promise.resolve({ data: { user: { id: "account" } }, error: null }),
  );
});
afterEach(() => vi.useRealTimers());
function fixture() {
  const authenticated = deferred<string>();
  const failed = deferred();
  const onAuthenticated = vi.fn((id: string) => authenticated.resolve(id));
  const onBeforeSignOut = vi.fn();
  const handlers = new Map<string, (event: { sender: WebContents }) => Promise<unknown>>();
  const shell = { id: 1 } as WebContents;
  configurePenkraAccountAuth({
    accountAuthScheme: "com.penkra.app.dev",
    authBaseUrl: "https://example.test/auth",
    desktopFlavor: "development",
    getWindow: () =>
      ({
        webContents: {
          send: (channel: string) => {
            if (channel === DESKTOP_IPC_CHANNELS.accountAuth.error) failed.resolve();
          },
        },
      }) as unknown as BrowserWindow,
    isShellRenderer: (sender) => sender === shell,
    ipcMain: {
      removeHandler: vi.fn(),
      handle: (channel: string, handler: (event: { sender: WebContents }) => Promise<unknown>) =>
        handlers.set(channel, handler),
    } as unknown as IpcMain,
    inspectInitialProtocolUrlFromArgv: false,
    registerAsDefaultProtocolClient: false,
    websiteOrigin: "https://example.test",
    onAuthenticated,
    onBeforeSignOut,
  });
  const callback = () =>
    mocks.events.get("open-url")!({}, "com.penkra.app.dev://auth/callback#token=fixture");
  return { authenticated, failed, onAuthenticated, onBeforeSignOut, handlers, shell, callback };
}

describe("explicit account authentication lifecycle", () => {
  it("waits for remote cleanup before clearing the account session", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f.onBeforeSignOut.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
    const signingOut = f.handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.signOut)!({
      sender: f.shell,
    });
    await entered.promise;
    try {
      expect(mocks.signOut).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await signingOut;
    }
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });
  it("does not claim sign-out completed when remote cleanup fails", async () => {
    const f = fixture();
    f.onBeforeSignOut.mockImplementation(() => Promise.reject(new Error("remote cleanup failed")));
    await expect(
      f.handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.signOut)!({ sender: f.shell }),
    ).rejects.toThrow("remote cleanup failed");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it("does not clear a newer explicit sign-in while older sign-out cleanup was waiting", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f.onBeforeSignOut.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
    const signingOut = f.handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.signOut)!({
      sender: f.shell,
    });
    await entered.promise;
    f.callback();
    await f.authenticated.promise;
    release.resolve();
    await signingOut;
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it("emits successful explicit authentication, never ordinary reads; sign-out is shell-only", async () => {
    const f = fixture();
    await f.handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.getState)!({ sender: f.shell });
    expect(f.onAuthenticated).not.toHaveBeenCalled();
    f.callback();
    expect(await f.authenticated.promise).toBe("account");
    expect(f.onAuthenticated).toHaveBeenCalledTimes(1);
    const signOut = f.handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.signOut)!;
    await signOut({ sender: { id: 2 } as WebContents });
    expect(f.onBeforeSignOut).not.toHaveBeenCalled();
    await signOut({ sender: f.shell });
    expect(f.onBeforeSignOut).toHaveBeenCalledTimes(1);
  });

  it("failed authentication does not trigger device-token renewal", async () => {
    mocks.authenticate.mockImplementation(() =>
      Promise.resolve({ data: null, error: { message: "Rejected" } }),
    );
    const f = fixture();
    f.callback();
    await f.failed.promise;
    expect(f.onAuthenticated).not.toHaveBeenCalled();
  });

  it("sign-out invalidates a late authentication callback before it can trigger renewal", async () => {
    vi.useFakeTimers();
    const response = deferred<{ data: { user: Record<string, unknown> }; error: null }>();
    mocks.authenticate.mockImplementation(() => response.promise);
    const f = fixture();
    f.callback();
    await f.handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.signOut)!({ sender: f.shell });
    expect(vi.getTimerCount()).toBe(0);
    response.resolve({ data: { user: { id: "account" } }, error: null });
    // Both await this exact promise; the callback registered its continuation first.
    await response.promise;
    expect(f.onAuthenticated).not.toHaveBeenCalled();
  });
});
