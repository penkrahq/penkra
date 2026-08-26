import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppCommandPipeServer, resolveAppCommandPipePath } from "./appCommandPipeServer";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

describe("AppCommandPipeServer", () => {
  it("uses a short private Unix socket path independent of the profile path", () => {
    if (process.platform === "win32") return;
    if (!process.getuid) throw new Error("Expected getuid on Unix.");
    const path = resolveAppCommandPipePath(
      "/Users/example/Library/Application Support/penkra-development-profile-with-a-long-name",
    );

    expect(path).toMatch(
      new RegExp(`^/tmp/penkra-${process.getuid()}/app-\\d+-[a-f0-9]{12}\\.sock$`),
    );
    expect(Buffer.byteLength(path)).toBeLessThan(100);
  });

  it("authenticates, resolves the current tab, and invokes through the trusted broker", async () => {
    if (process.platform === "win32") return;
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-command-"));
    const path = Path.join(directory, "command.sock");
    const invoke = vi.fn(async () => ({ created: true }));
    const open = vi.fn(async () => ({ destination: "system" }));
    const sideload = vi.fn(async () => ({ status: "installed" }));
    const current = {
      id: "tab-1",
      rendererId: 101,
      appId: "com.acme.linear",
      slug: "linear",
      name: "Linear",
      iconDataUrl: null,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/issues",
      status: "ready" as const,
      documentUrl: "penkra-app://linear/index.html#penkra-tab=tab-1",
    };
    const secondTab = {
      ...current,
      id: "tab-2",
      rendererId: 102,
      route: "/issues/second",
    };
    const otherThreadTab = {
      ...current,
      id: "tab-other-thread",
      rendererId: 103,
      threadId: "thread-2",
    };
    const snapshot = vi.fn(async () => ({ snapshot: "" }));
    const screenshot = vi.fn(async () => ({ kind: "image" }));
    const server = new AppCommandPipeServer({
      path,
      token: "secret",
      catalog: {
        list: vi.fn(() => [
          { slug: "linear", operations: [{ key: "issues.create", input: { type: "object" } }] },
        ]),
        help: vi.fn(async () => "Linear help\n"),
        skills: vi.fn(async () => []),
      } as never,
      broker: { invoke } as never,
      tabs: { list: () => [current, secondTab, otherThreadTab], current: () => current },
      observer: {
        snapshot,
        find: vi.fn(async () => ({ matches: [] })),
        screenshot,
        click: vi.fn(async () => ({})),
        hover: vi.fn(async () => ({})),
        type: vi.fn(async () => ({})),
        press: vi.fn(async () => ({})),
        select: vi.fn(async () => ({})),
        scroll: vi.fn(async () => ({})),
        wait: vi.fn(async () => ({})),
        handleDialog: vi.fn(async () => ({})),
        upload: vi.fn(async () => ({})),
      },
      providerCredentialVault: {
        store: vi.fn(async () => "provider-secret:stored"),
        issueLease: vi.fn(() => "lease.capability"),
        consumeLease: vi.fn(() => "provider-secret-value"),
        remove: vi.fn(async () => undefined),
      } as never,
      open,
      sideload,
    });
    await server.start();
    disposers.push(async () => {
      await server.dispose();
      FS.rmSync(directory, { recursive: true, force: true });
    });

    await expect(
      send(path, {
        id: "request-1",
        token: "secret",
        method: "operations.invoke",
        params: { app: "linear", operation: "issues.create", input: { title: "Fix auth" } },
      }),
    ).resolves.toEqual({ ok: true, id: "request-1", result: { created: true } });
    expect(invoke).toHaveBeenCalledWith({
      app: "linear",
      callerKind: "agent",
      operation: "issues.create",
      input: { title: "Fix auth" },
      spaceId: "personal",
      threadId: "thread-1",
      tabId: "tab-1",
    });

    await expect(
      send(path, {
        id: "request-open",
        token: "secret",
        method: "core.open",
        params: {
          path: "/tmp/example.pdf",
          requestedApp: "explorer",
          spaceId: "personal",
          threadId: "thread-1",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-open",
      result: { destination: "system" },
    });
    expect(open).toHaveBeenCalledWith({
      path: "/tmp/example.pdf",
      requestedApp: "explorer",
      spaceId: "personal",
      threadId: "thread-1",
    });

    await expect(
      send(path, {
        id: "request-sideload",
        token: "secret",
        method: "developer.sideload",
        params: { sourcePath: "/work/canvas/dist", spaceId: "personal" },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-sideload",
      result: { status: "installed" },
    });
    expect(sideload).toHaveBeenCalledWith({
      sourcePath: "/work/canvas/dist",
      spaceId: "personal",
    });

    await expect(
      send(path, {
        id: "request-tabs",
        token: "secret",
        method: "tabs.list",
        params: { spaceId: "personal", threadId: "thread-1" },
      }),
    ).resolves.toEqual({ ok: true, id: "request-tabs", result: [current, secondTab] });

    await expect(
      send(path, {
        id: "request-tabs-other-thread",
        token: "secret",
        method: "tabs.list",
        params: { spaceId: "personal", threadId: "thread-2" },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-tabs-other-thread",
      result: [otherThreadTab],
    });

    await expect(
      send(path, {
        id: "request-exact-second-tab",
        token: "secret",
        method: "tabs.snapshot",
        params: { spaceId: "personal", threadId: "thread-1", tabId: "tab-2" },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-exact-second-tab",
      result: { snapshot: "" },
    });
    expect(snapshot).toHaveBeenCalledWith("tab-2", {
      target: undefined,
      depth: undefined,
      boxes: undefined,
      outputPath: undefined,
    });

    await expect(
      send(path, {
        id: "request-cross-thread-tab",
        token: "secret",
        method: "tabs.snapshot",
        params: {
          spaceId: "personal",
          threadId: "thread-1",
          tabId: "tab-other-thread",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("not open in the caller Thread and Space") },
    });
    expect(snapshot).toHaveBeenCalledOnce();

    await expect(
      send(path, {
        id: "request-visible-screenshot",
        token: "secret",
        method: "tabs.screenshot",
        params: { spaceId: "personal", threadId: "thread-1" },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-visible-screenshot",
      result: { kind: "image" },
    });
    expect(screenshot).toHaveBeenCalledWith("tab-1", undefined);

    await expect(
      send(path, {
        id: "request-2",
        token: "wrong",
        method: "tabs.list",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "APP_COMMAND_FAILED", message: "Invalid App command capability." },
    });
  });
});

function send(path: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = Net.createConnection(path);
    let response = "";
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}
