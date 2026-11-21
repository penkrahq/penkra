import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cookie: "better-auth.session_token=abc",
  store: new Map<string, unknown>(),
  getSession: vi.fn(),
  handlers: new Map<string, (event: unknown) => unknown>(),
  powerListeners: new Map<string, () => void>(),
  ready: Promise.resolve(),
}));

vi.mock("electron", () => ({
  app: {
    whenReady: () => state.ready,
    on: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(() => true),
  },
  powerMonitor: { on: (name: string, fn: () => void) => state.powerListeners.set(name, fn) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));
vi.mock("@better-auth/electron/storage", () => ({
  storage: () => ({
    getItem: (key: string) => state.store.get(key) ?? null,
    setItem: (key: string, value: unknown) => state.store.set(key, value),
  }),
}));
vi.mock("@better-auth/electron/client", () => ({ electronClient: () => ({ fetchPlugins: [] }) }));
vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({
    getCookie: () => state.cookie,
    getSession: state.getSession,
    setupMain: vi.fn(),
    requestAuth: vi.fn(),
    authenticate: vi.fn(),
    signOut: vi.fn(),
  }),
}));

import { configurePenkraAccountAuth } from "./accountAuth";
import { AccountSessionCache } from "./accountSessionCache";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const user = { id: "u1", email: "developer@penkra.local", name: "Dev", image: null };

function setup() {
  const broadcast = vi.fn();
  const runtime = configurePenkraAccountAuth({
    accountAuthScheme: "penkra-dev",
    authBaseUrl: "https://api.example.test/auth",
    desktopFlavor: "development",
    getWindow: () => null,
    broadcast,
    isShellRenderer: () => true,
    ipcMain: {
      removeHandler: vi.fn(),
      handle: (channel: string, fn: (event: unknown) => unknown) => state.handlers.set(channel, fn),
    } as never,
    inspectInitialProtocolUrlFromArgv: false,
    registerAsDefaultProtocolClient: false,
    websiteOrigin: "https://example.test",
  });
  const getState = state.handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.getState)!;
  return { runtime, broadcast, getState };
}

const cache = () =>
  new AccountSessionCache({
    getItem: (key) => state.store.get(key) ?? null,
    setItem: (key, value) => state.store.set(key, value),
  });

beforeEach(() => {
  state.cookie = "better-auth.session_token=abc";
  state.store.clear();
  state.handlers.clear();
  state.powerListeners.clear();
  state.getSession.mockReset();
  state.getSession.mockResolvedValue({ data: { user }, error: null });
});

describe("account session", () => {
  it("shows signed out when the saved user's cookie has expired", async () => {
    const { broadcast, getState, runtime } = setup();
    await state.ready;
    await vi.waitFor(() => expect(state.getSession).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(cache().read()).toEqual(user));
    expect(await getState({ sender: {} })).toEqual({ status: "authenticated", user });

    state.cookie = "";
    expect(await getState({ sender: {} })).toEqual({ status: "unauthenticated" });
    await vi.waitFor(() => expect(cache().read()).toBeNull());
    expect(broadcast).toHaveBeenLastCalledWith(expect.any(String), null);
    expect(runtime.getCookie()).toBe("");
  });

  it("an account call with an expired cookie signs the window out", async () => {
    const { runtime } = setup();
    await vi.waitFor(() => expect(cache().read()).toEqual(user));
    state.cookie = "";
    runtime.getCookie();
    await vi.waitFor(() => expect(cache().read()).toBeNull());
  });

  it("checks in again on wake so a running Penkra keeps its session", async () => {
    setup();
    await vi.waitFor(() => expect(state.powerListeners.has("resume")).toBe(true));
    state.powerListeners.get("resume")!();
    await vi.waitFor(() => expect(state.getSession).toHaveBeenCalledTimes(2));
  });

  it("checks in every 12 hours", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    try {
      setup();
      await vi.waitFor(() => expect(state.powerListeners.has("resume")).toBe(true));
      vi.advanceTimersByTime(12 * 60 * 60 * 1000);
      await vi.waitFor(() => expect(state.getSession).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
