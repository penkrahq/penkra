import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeAppSkillChanges } from "./appSkillChanges.ts";

vi.mock("./appRuntimeCli.ts", () => ({ appCommandTimeoutMs: () => 30_000 }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function host(handle: (socket: Socket, request: Record<string, unknown>) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), "app-skill-change-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\app-skill-${process.pid}-${path.basename(directory)}`
      : path.join(directory, "host.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (chunk) => handle(socket, JSON.parse(chunk.toString())));
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    PENKRA_APP_COMMAND_PIPE: endpoint,
    PENKRA_APP_COMMAND_TOKEN: "token",
    PENKRA_APP_COMMAND_ADMIN_TOKEN: "admin",
  };
}

describe("App skill changes", () => {
  it("registers before resolving, receives changes, and reports a lost source without retrying", async () => {
    let socket!: Socket;
    let connections = 0;
    const env = await host((client, request) => {
      socket = client;
      connections++;
      expect(request).toMatchObject({
        method: "skills.subscribe",
        token: "token",
        adminToken: "admin",
      });
      client.write(
        `${JSON.stringify({ id: request.id, ok: true, result: { subscribed: true } })}\n`,
      );
    });
    let changed!: () => void, failed!: (error: Error) => void;
    const change = new Promise<void>((resolve) => {
      changed = resolve;
    });
    const failure = new Promise<Error>((resolve) => {
      failed = resolve;
    });
    const close = await subscribeAppSkillChanges(changed, failed, env);
    socket.write('{"type":"skills.changed"}\n');
    await change;
    socket.destroy();
    expect((await failure).message).toContain("closed");
    expect(connections).toBe(1);
    close();
  });

  it("rejects admission failures and cancels a pending subscription without leaking its socket", async () => {
    const denied = await host((socket) => socket.end('{"ok":false}\n'));
    await expect(subscribeAppSkillChanges(vi.fn(), vi.fn(), denied)).rejects.toThrow("rejected");
    let accepted!: () => void;
    const connected = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const env = await host(() => accepted());
    const controller = new AbortController();
    const pending = subscribeAppSkillChanges(vi.fn(), vi.fn(), env, controller.signal);
    const rejection = expect(pending).rejects.toThrow("cancelled");
    await connected;
    controller.abort();
    await rejection;
  });
});
