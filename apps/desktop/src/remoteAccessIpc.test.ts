import type { IpcMain, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { RemoteAccessController } from "./remoteAccessController";
import { registerRemoteAccessIpc } from "./remoteAccessIpc";
import { deferred } from "./deferred.test-support";

it("permits only the shell and never reports an old account's access state", async () => {
  const handlers = new Map<
    string,
    (event: { sender: WebContents }, value?: unknown) => Promise<unknown>
  >();
  const ipc = {
    removeHandler: vi.fn(),
    handle: (name: string, handler: typeof handlers extends Map<string, infer H> ? H : never) =>
      handlers.set(name, handler),
  } as unknown as IpcMain;
  const shell = { id: 1 } as WebContents,
    other = { id: 2 } as WebContents;
  const started = deferred(),
    release = deferred<boolean>();
  let account = "a";
  const setAccess = vi.fn(async () => undefined);
  const controller = new RemoteAccessController({
    account: async () => account,
    register: async () => undefined,
    setAccess,
    signal: new AbortController().signal,
  });
  registerRemoteAccessIpc({
    ipc,
    isShell: (sender) => sender === shell,
    account: async () => account,
    readAccess: async () => {
      started.resolve();
      return release.promise;
    },
    controller,
  });
  const read = handlers.get(DESKTOP_IPC_CHANNELS.remoteAccess.getState)!;
  const set = handlers.get(DESKTOP_IPC_CHANNELS.remoteAccess.setEnabled)!;
  await expect(read({ sender: other })).rejects.toThrow("unavailable");
  await expect(set({ sender: other }, true)).rejects.toThrow("unavailable");
  await expect(set({ sender: shell }, "yes")).rejects.toThrow("unavailable");
  const pending = read({ sender: shell });
  await started.promise;
  account = "b";
  release.resolve(true);
  await expect(pending).rejects.toThrow("account changed");
  await set({ sender: shell }, false);
  expect(setAccess).toHaveBeenCalledWith("b", false);
});
