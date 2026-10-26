import type { BrowserWindow, IpcMain, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred.test-support";

const mocks = vi.hoisted(() => ({
  entries: new Map<string, unknown>(),
  events: new Map<string, (...args: unknown[]) => void>(),
  ready: Promise.resolve(),
  getSession: vi.fn<
    () => Promise<{
      data: { user: Record<string, unknown> } | null;
      error: { status: number; message: string } | null;
    }>
  >(),
  authenticate: vi.fn(),
  signOut: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({
  app: {
    on: (name: string, listener: (...args: unknown[]) => void) => mocks.events.set(name, listener),
    whenReady: () => mocks.ready,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));
vi.mock("@better-auth/electron/storage", () => ({
  storage: () => ({
    getItem: (key: string) => mocks.entries.get(key) ?? null,
    setItem: (key: string, value: unknown) => void mocks.entries.set(key, value),
  }),
}));
vi.mock("@better-auth/electron/client", () => ({ electronClient: () => ({ fetchPlugins: [] }) }));
vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({
    getSession: mocks.getSession,
    authenticate: mocks.authenticate,
    signOut: mocks.signOut,
    getCookie: () => {
      const value = mocks.entries.get("penkra-account.cookie");
      return typeof value === "string" &&
        JSON.parse(Buffer.from(value, "base64").toString()).session
        ? "session=fixture"
        : "";
    },
    setupMain: vi.fn(),
    requestAuth: vi.fn(),
  }),
}));

import { configurePenkraAccountAuth } from "./accountAuth";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const user = { id: "account-a", email: "a@example.test", name: "A", image: null };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.entries.clear();
  mocks.events.clear();
  mocks.entries.set(
    "penkra-account.local_cache",
    Buffer.from(JSON.stringify({ user })).toString("base64"),
  );
  mocks.entries.set(
    "penkra-account.cookie",
    Buffer.from(JSON.stringify({ session: "fixture" })).toString("base64"),
  );
  mocks.authenticate.mockResolvedValue({ data: { user }, error: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const ready = deferred();
  mocks.ready = ready.promise;
  const handlers = new Map<string, (event: { sender: WebContents }) => Promise<unknown>>();
  const shell = { id: 1 } as WebContents;
  const authenticated = deferred();
  const onBeforeSignOut = vi.fn();
  const send = vi.fn((channel: string) => {
    if (channel === DESKTOP_IPC_CHANNELS.accountAuth.authenticated) authenticated.resolve();
  });
  const runtime = configurePenkraAccountAuth({
    accountAuthScheme: "com.penkra.app.dev",
    authBaseUrl: "https://account.example.test/api/auth",
    desktopFlavor: "development",
    getWindow: () => ({ webContents: { send } }) as unknown as BrowserWindow,
    isShellRenderer: (sender) => sender === shell,
    ipcMain: {
      removeHandler: vi.fn(),
      handle: (key: string, fn: (event: { sender: WebContents }) => Promise<unknown>) =>
        handlers.set(key, fn),
    } as unknown as IpcMain,
    inspectInitialProtocolUrlFromArgv: false,
    registerAsDefaultProtocolClient: false,
    websiteOrigin: "https://account.example.test",
    onBeforeSignOut,
  });
  const read = () => handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.getState)!({ sender: shell });
  return {
    ready,
    read,
    send,
    runtime,
    authenticated,
    onBeforeSignOut,
    signOut: () => handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.signOut)!({ sender: shell }),
    callback: () =>
      mocks.events.get("open-url")!({}, "com.penkra.app.dev://auth/callback#token=fixture"),
  };
}

describe("local account startup authority", () => {
  it("opens from stored identity without making a network request", async () => {
    mocks.getSession.mockImplementation(() => new Promise(() => {}));
    const f = fixture();
    expect(await f.read()).toEqual({ status: "authenticated", user });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(await f.runtime.getAccountId()).toBe(user.id);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("returns signed out when no stored account exists, without consulting the server", async () => {
    mocks.entries.clear();
    const f = fixture();
    expect(await f.read()).toEqual({ status: "unauthenticated" });
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it.each(["network", "503"])(
    "keeps the saved account when the launch check fails: %s",
    async (failure) => {
      const called = deferred();
      const logged = deferred();
      const result = deferred<Awaited<ReturnType<typeof mocks.getSession>>>();
      mocks.getSession.mockImplementation(async () => {
        called.resolve();
        const value = await result.promise;
        if (failure === "network") throw new Error("Fixture network unavailable");
        return value;
      });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {
        logged.resolve();
      });
      const f = fixture();
      f.ready.resolve();
      await called.promise;
      expect(await f.read()).toEqual({ status: "authenticated", user });
      result.resolve({ data: null, error: { status: 503, message: "Fixture unavailable" } });
      await logged.promise;
      expect(warning).toHaveBeenCalledWith(
        "[account-auth] Launch session check failed.",
        expect.anything(),
      );
      expect(await f.read()).toEqual({ status: "authenticated", user });
      expect(f.send).not.toHaveBeenCalled();
      expect(mocks.getSession).toHaveBeenCalledOnce();
    },
  );

  it.each(["401", "null"])(
    "clears the account only on explicit session rejection: %s",
    async (answer) => {
      const called = deferred();
      const result = deferred<Awaited<ReturnType<typeof mocks.getSession>>>();
      mocks.getSession.mockImplementation(() => {
        called.resolve();
        return result.promise;
      });
      const f = fixture();
      f.ready.resolve();
      await called.promise;
      result.resolve({
        data: null,
        error: answer === "401" ? { status: 401, message: "Invalid session" } : null,
      });
      await result.promise;
      expect(await f.read()).toEqual({ status: "unauthenticated" });
      expect(f.send).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.accountAuth.userUpdated, null);
      expect(mocks.signOut).not.toHaveBeenCalled();
    },
  );

  it("saves first sign-in before announcing authentication, without needing get-session", async () => {
    mocks.entries.clear();
    const f = fixture();
    f.callback();
    await f.authenticated.promise;
    expect(await f.read()).toEqual({ status: "authenticated", user });
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("ignores launch rejection that arrives after a newer sign-in", async () => {
    const called = deferred();
    const result = deferred<Awaited<ReturnType<typeof mocks.getSession>>>();
    mocks.getSession.mockImplementation(() => {
      called.resolve();
      return result.promise;
    });
    const f = fixture();
    f.ready.resolve();
    await called.promise;
    f.callback();
    await f.authenticated.promise;
    result.resolve({ data: null, error: { status: 401, message: "Old session rejected" } });
    await result.promise;
    expect(await f.read()).toEqual({ status: "authenticated", user });
    expect(f.send).not.toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.accountAuth.userUpdated, null);
  });

  it.each([
    ["https://account.example.test/api/registry/apps", 401, "session=fixture", "unauthenticated"],
    ["https://account.example.test/api/registry/apps", 503, "session=fixture", "authenticated"],
    ["https://account.example.test/api/registry/apps", 403, "session=fixture", "authenticated"],
    ["https://other.example.test/data", 401, "session=fixture", "authenticated"],
    ["https://account.example.test/api/registry/apps", 401, "", "authenticated"],
  ])(
    "observes only an account-service session rejection: %s %s",
    async (url, status, cookie, expected) => {
      const f = fixture();
      const response = new Response(null, { status });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      expect(await f.runtime.fetch(url, { headers: { cookie } })).toBe(response);
      expect(await f.read()).toMatchObject({ status: expected });
    },
  );

  it("does not let an older API 401 sign out a newer authentication", async () => {
    const result = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => result.promise),
    );
    const f = fixture();
    const request = f.runtime.fetch("https://account.example.test/api/registry/apps", {
      headers: { cookie: "session=fixture" },
    });
    f.callback();
    await f.authenticated.promise;
    result.resolve(new Response(null, { status: 401 }));
    await request;
    expect(await f.read()).toEqual({ status: "authenticated", user });
  });

  it("rejects a launch read begun while sign-out cleanup was still in progress", async () => {
    const entered = deferred();
    const release = deferred();
    const called = deferred();
    const result = deferred<Awaited<ReturnType<typeof mocks.getSession>>>();
    mocks.getSession.mockImplementation(() => {
      called.resolve();
      return result.promise;
    });
    const f = fixture();
    f.onBeforeSignOut.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
    const signingOut = f.signOut();
    await entered.promise;
    f.ready.resolve();
    await called.promise;
    release.resolve();
    await signingOut;
    result.resolve({ data: { user }, error: null });
    await result.promise;
    expect(await f.read()).toEqual({ status: "unauthenticated" });
  });
});
