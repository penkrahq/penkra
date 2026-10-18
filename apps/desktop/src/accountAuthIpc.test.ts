import type { BrowserWindow, IpcMain, WebContents } from "electron";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({
    data: { user: { id: "account", name: "Test", email: "test@example.com" } },
    error: null,
  })),
  requestAuth: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({ app: { on: vi.fn(), whenReady: async () => {} } }));
vi.mock("@better-auth/electron/client", () => ({ electronClient: () => ({}) }));
vi.mock("@better-auth/electron/storage", () => ({ storage: () => ({}) }));
vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({ ...mocks, setupMain: vi.fn() }),
}));

import { configurePenkraAccountAuth } from "./accountAuth";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { ShellWindowRegistry } from "./shellWindowRegistry";

it("authorizes every live shell independently of focus, but rejects App and destroyed renderers", async () => {
  const registry = new ShellWindowRegistry();
  const first = {
    webContents: { id: 1, send: vi.fn() },
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
  let destroyed = false;
  const second = {
    webContents: { id: 2, send: vi.fn() },
    isDestroyed: () => destroyed,
  } as unknown as BrowserWindow;
  registry.add(first);
  registry.add(second);
  const handlers = new Map<string, (event: { sender: WebContents }) => Promise<unknown>>();
  const ipcMain = {
    removeHandler: vi.fn(),
    handle: (channel: string, handler: (event: { sender: WebContents }) => Promise<unknown>) =>
      handlers.set(channel, handler),
  } as unknown as IpcMain;
  configurePenkraAccountAuth({
    accountAuthScheme: "com.penkra.app.dev",
    authBaseUrl: "https://example.com/api/auth",
    desktopFlavor: "development",
    getWindow: () => first,
    isShellRenderer: (sender: WebContents) => registry.hasWebContents(sender),
    ipcMain,
    inspectInitialProtocolUrlFromArgv: false,
    registerAsDefaultProtocolClient: false,
    websiteOrigin: "https://example.com",
  });
  const read = handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.getState)!;
  expect(await read({ sender: first.webContents })).toMatchObject({ status: "authenticated" });
  expect(await read({ sender: second.webContents })).toMatchObject({ status: "authenticated" });
  await handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.requestSignIn)!({
    sender: second.webContents,
  });
  await handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.requestSignUp)!({
    sender: second.webContents,
  });
  await handlers.get(DESKTOP_IPC_CHANNELS.accountAuth.signOut)!({ sender: second.webContents });
  expect(mocks.requestAuth).toHaveBeenCalledTimes(2);
  expect(mocks.signOut).toHaveBeenCalledOnce();
  mocks.requestAuth.mockClear();
  mocks.signOut.mockClear();
  const appRenderer = { id: 3 } as WebContents;
  expect(await read({ sender: appRenderer })).toMatchObject({ status: "error" });
  destroyed = true;
  expect(await read({ sender: second.webContents })).toMatchObject({ status: "error" });
  for (const channel of [
    DESKTOP_IPC_CHANNELS.accountAuth.requestSignIn,
    DESKTOP_IPC_CHANNELS.accountAuth.requestSignUp,
    DESKTOP_IPC_CHANNELS.accountAuth.signOut,
  ]) {
    const handler = handlers.get(channel)!;
    await handler({ sender: appRenderer });
  }
  expect(mocks.requestAuth).not.toHaveBeenCalled();
  expect(mocks.signOut).not.toHaveBeenCalled();
});
