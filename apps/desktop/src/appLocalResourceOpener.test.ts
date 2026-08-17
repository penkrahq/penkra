import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openLocalAppResource } from "./appLocalResourceOpener";
import { AppScopedFileHandleStore } from "./appScopedFileHandleStore";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => FS.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe("openLocalAppResource", () => {
  it("hands an exact file handle to Explorer and reuses its Thread tab", async () => {
    const directory = await temporaryDirectory();
    const path = Path.join(directory, "AGENTS.md");
    await FS.promises.writeFile(path, "# Instructions\n");
    const fileHandles = new AppScopedFileHandleStore();
    const invoke = vi.fn().mockResolvedValue({ tabId: "explorer-tab" });
    const present = vi.fn();

    const result = await openLocalAppResource({
      appTabs: {
        currentFor: () => null,
        list: () => [
          {
            id: "explorer-tab",
            appId: "com.penkra.explorer",
            spaceId: "personal",
            threadId: "thread-1",
          },
        ],
        present,
      },
      broker: { invoke },
      fileHandles,
      intents: {
        resolve: () => ({
          appId: "com.penkra.explorer",
          slug: "explorer",
          name: "Explorer",
          operation: "resources.open",
        }),
      } as never,
      openSystem: vi.fn(),
      openWith: { get: () => undefined } as never,
      path,
      spaceId: "personal",
      threadId: "thread-1",
      callerKind: "user",
    });

    const operationInput = invoke.mock.calls[0]![0];
    expect(operationInput).toMatchObject({
      app: "explorer",
      operation: "resources.open",
      tabId: "explorer-tab",
      callerKind: "user",
      input: { kind: "file", name: "AGENTS.md" },
    });
    const handleId = operationInput.input.handleId as string;
    expect(fileHandles.resolve("com.penkra.explorer", "personal", handleId).rootPath).toBe(path);
    expect(present).toHaveBeenCalledWith("explorer-tab");
    expect(result).toMatchObject({ destination: "app", appId: "com.penkra.explorer" });
  });

  it("uses the operating system when no App handles the exact extension", async () => {
    const directory = await temporaryDirectory();
    const path = Path.join(directory, "archive.unknown");
    await FS.promises.writeFile(path, "data");
    const openSystem = vi.fn().mockResolvedValue(undefined);

    const result = await openLocalAppResource({
      appTabs: { currentFor: () => null, list: () => [], present: vi.fn() },
      broker: { invoke: vi.fn() },
      fileHandles: new AppScopedFileHandleStore(),
      intents: { resolve: () => null } as never,
      openSystem,
      openWith: { get: () => undefined } as never,
      path,
      spaceId: "personal",
      threadId: "thread-1",
    });

    expect(openSystem).toHaveBeenCalledWith(path);
    expect(result).toEqual({ destination: "system", intent: "open-file", path });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-local-open-"));
  temporaryDirectories.push(directory);
  return FS.promises.realpath(directory);
}
