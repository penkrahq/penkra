import type { IpcMain, WebContents } from "electron";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import type { RemoteAccessController } from "./remoteAccessController";

export function registerRemoteAccessIpc(input: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  isShell: (sender: WebContents) => boolean;
  account: () => Promise<string | null>;
  readAccess: (accountId: string) => Promise<boolean>;
  controller: RemoteAccessController;
}): void {
  const channels = DESKTOP_IPC_CHANNELS.remoteAccess;
  input.ipc.removeHandler(channels.getState);
  input.ipc.handle(channels.getState, async (event) => {
    if (!input.isShell(event.sender)) throw new Error("iPhone access is unavailable.");
    const account = await input.account();
    if (!account) return { signedIn: false, enabled: false };
    const enabled = await input.readAccess(account);
    if ((await input.account()) !== account) throw new Error("The signed-in account changed.");
    return { signedIn: true, enabled };
  });
  input.ipc.removeHandler(channels.setEnabled);
  input.ipc.handle(channels.setEnabled, async (event, enabled: unknown) => {
    if (!input.isShell(event.sender) || typeof enabled !== "boolean")
      throw new Error("iPhone access is unavailable.");
    await input.controller.setEnabled(enabled);
  });
}
