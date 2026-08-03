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
    const current = {
      id: "tab-1",
      appId: "com.acme.linear",
      slug: "linear",
      name: "Linear",
      iconDataUrl: null,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/issues",
      status: "ready" as const,
    };
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
      tabs: { list: () => [current], current: () => current },
      open,
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
        id: "request-2",
        token: "wrong",
        method: "tabs.list",
      }),
    ).resolves.toMatchObject({ ok: false, error: "Invalid App command capability." });
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
