import type { BrowserWindow, IpcMain, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred.test-support";

const native = vi.hoisted(() => {
  const state = {
    send: vi.fn(),
    entries: new Map<string, unknown>(),
    ready: Promise.resolve(),
    tasks: [] as Promise<unknown>[],
  };
  const app = {
    on: vi.fn(),
    userAgentFallback: "Penkra auth fixture",
    whenReady: () => ({
      // eslint-disable-next-line unicorn/no-thenable -- Join app-ready callbacks in this controlled native fixture, without sleeps.
      then: (fn: () => unknown) => {
        const task = state.ready.then(fn);
        state.tasks.push(task);
        return task;
      },
    }),
  };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  return { send: state.send, state, app, safeStorage };
});
vi.mock("electron", () => ({
  app: native.app,
  safeStorage: native.safeStorage,
  default: {
    app: native.app,
    safeStorage: native.safeStorage,
    webContents: { getFocusedWebContents: () => ({ send: native.send }) },
  },
  shell: {},
}));
vi.mock("@better-auth/electron/storage", () => ({
  storage: () => ({
    getItem: (key: string) => native.state.entries.get(key) ?? null,
    setItem: (key: string, value: unknown) => void native.state.entries.set(key, value),
  }),
}));

// Exercise the installed dependency, not a mock of its cache behavior. The
// native encryption mock keeps this fixture entirely separate from OS secrets.
import { configurePenkraAccountAuth } from "./accountAuth";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("pinned Better Auth Electron session persistence contract", () => {
  it.each([false, true])(
    "honors response ownership through the real SDK (signedOut=%s)",
    async (signedOut) => {
      const previousType = Object.getOwnPropertyDescriptor(process, "type");
      Object.defineProperty(process, "type", { value: "browser", configurable: true });
      const ready = deferred();
      const started = deferred();
      const response = deferred<Response>();
      native.state.ready = ready.promise;
      native.state.tasks = [];
      native.state.entries.clear();
      const user = { id: "account-a", name: "A", email: "a@example.test", image: null };
      native.state.entries.set(
        "penkra-account.local_cache",
        Buffer.from(JSON.stringify({ user })).toString("base64"),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL | Request) => {
          if (url.toString().endsWith("/get-session")) {
            started.resolve();
            return response.promise;
          }
          return Response.json({ success: true });
        }),
      );
      const handlers = new Map<string, (event: { sender: WebContents }) => Promise<unknown>>();
      const sender = { id: 1 } as WebContents;
      try {
        const runtime = configurePenkraAccountAuth({
          accountAuthScheme: "com.penkra.fixture",
          authBaseUrl: "https://account.example.test/auth",
          desktopFlavor: "development",
          getWindow: () => ({ webContents: { send: native.send } }) as unknown as BrowserWindow,
          isShellRenderer: (value) => value === sender,
          ipcMain: {
            removeHandler: vi.fn(),
            handle: (key: string, fn: (event: { sender: WebContents }) => Promise<unknown>) =>
              handlers.set(key, fn),
          } as unknown as IpcMain,
          websiteOrigin: "https://account.example.test",
          inspectInitialProtocolUrlFromArgv: false,
          registerAsDefaultProtocolClient: false,
        });
        ready.resolve();
        await started.promise;
        if (signedOut) await handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.signOut)!({ sender });
        response.resolve(
          Response.json(
            { user },
            { headers: { "set-cookie": "better-auth.session_token=fixture; Path=/; HttpOnly" } },
          ),
        );
        await Promise.all(native.state.tasks);
        expect(await handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.getState)!({ sender })).toEqual(
          signedOut ? { status: "unauthenticated" } : { status: "authenticated", user },
        );
        expect(runtime.getCookie()).toBe(signedOut ? "" : "better-auth.session_token=fixture");
        if (signedOut)
          expect(native.send).not.toHaveBeenCalledWith(
            DESKTOP_IPC_CHANNELS.accountAuth.userUpdated,
            user,
          );
        else
          expect(native.send).toHaveBeenCalledWith(
            DESKTOP_IPC_CHANNELS.accountAuth.userUpdated,
            user,
          );
      } finally {
        ready.resolve();
        response.resolve(Response.json(null));
        await Promise.allSettled(native.state.tasks);
        if (previousType) Object.defineProperty(process, "type", previousType);
        else Reflect.deleteProperty(process, "type");
        native.state.entries.clear();
      }
    },
  );
});
