import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  fromPartition: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getAppMetrics: vi.fn(() => []) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
  },
  session: { fromPartition: electron.fromPartition },
  webContents: { fromId: vi.fn(() => null) },
  WebContentsView: class {},
}));

import { startDesktopAppRuntime } from "./desktopAppRuntime";
import { APP_RUNTIME_IPC_CHANNELS } from "./ipcChannels";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

describe("desktop App runtime composition", () => {
  it("starts with an empty durable registry and releases IPC listeners on stop", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-desktop-app-runtime-"));
    roots.push(root);
    const listeners = new Map<string, Set<(...args: never[]) => void>>();
    const ipcMain = {
      on: vi.fn((channel: string, listener: (...args: never[]) => void) => {
        const values = listeners.get(channel) ?? new Set();
        values.add(listener);
        listeners.set(channel, values);
        return ipcMain;
      }),
      removeListener: vi.fn((channel: string, listener: (...args: never[]) => void) => {
        listeners.get(channel)?.delete(listener);
        return ipcMain;
      }),
    };

    const runtime = await startDesktopAppRuntime({
      userDataPath: root,
      appPreloadPath: "/trusted/appPreload.js",
      ipcMain: ipcMain as never,
      window: () => null,
      onTabOpened: () => undefined,
      onTabState: () => undefined,
      onTabClosed: () => undefined,
    });

    expect(runtime.store.snapshot().packagesByInstallationKey).toEqual({});
    expect(runtime.restoreResults).toEqual([]);
    expect(runtime.safeStartRecovery).toBeNull();
    expect(runtime.updateRecovery).toBeNull();
    expect(runtime.packageGarbageCollection).toEqual({ removedPaths: [], failures: [] });
    expect(listeners.get(APP_RUNTIME_IPC_CHANNELS.rendererMessage)).toHaveLength(1);
    expect(listeners.get(APP_RUNTIME_IPC_CHANNELS.ready)).toHaveLength(1);
    await runtime.stop();
    await runtime.stop();
    expect(listeners.get(APP_RUNTIME_IPC_CHANNELS.rendererMessage)).toHaveLength(0);
    expect(listeners.get(APP_RUNTIME_IPC_CHANNELS.ready)).toHaveLength(0);
    expect(electron.fromPartition).not.toHaveBeenCalled();
  });
});
