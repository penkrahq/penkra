import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DesktopRemoteCredentials } from "./desktopCredentials";

async function pipe(
  handle: (request: Record<string, unknown>, socket: import("node:net").Socket) => void,
  run: (client: DesktopRemoteCredentials) => Promise<void>,
) {
  const parent = resolve(import.meta.dirname, "../../../../.penkra/scratch");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "remote-link-pipe-"));
  // Relative Unix socket paths keep the QA socket below scratch without exceeding macOS's limit.
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\penkra-remote-${crypto.randomUUID()}`
      : relative(process.cwd(), resolve(root, "pipe.sock"));
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let bytes = "";
    socket.on("data", (chunk) => {
      bytes += chunk.toString();
      if (bytes.includes("\n")) handle(JSON.parse(bytes), socket);
    });
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(path, done);
    });
    await run(
      new DesktopRemoteCredentials({
        PENKRA_APP_COMMAND_PIPE: path,
        PENKRA_APP_COMMAND_TOKEN: "caller",
        PENKRA_APP_COMMAND_ADMIN_TOKEN: "backend-only",
      }),
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}
describe("DesktopRemoteCredentials", () => {
  it("asks desktop to register the account without passing a cookie or supplied device token", async () => {
    await pipe(
      (request, socket) => {
        expect(request.method).toBe("remote.credentials.register");
        expect(request.params).toEqual({ accountId: "a" });
        socket.end(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              accountId: "a",
              credentials: {
                identityPrivateKey: Buffer.alloc(32, 7).toString("base64"),
                registration: {
                  deviceId: "10000000-0000-4000-8000-000000000001",
                  deviceToken: Buffer.alloc(32, 2).toString("base64url"),
                },
              },
            },
          })}\n`,
        );
      },
      async (client) => {
        expect((await client.register("a")).credentials?.registration?.deviceId).toBe(
          "10000000-0000-4000-8000-000000000001",
        );
      },
    );
  });
  it("requires backend authority before opening a pipe", async () => {
    await expect(
      new DesktopRemoteCredentials({
        PENKRA_APP_COMMAND_PIPE: "unused",
        PENKRA_APP_COMMAND_TOKEN: "caller",
      }).read(),
    ).rejects.toThrow("backend capability");
  });
  it("uses backend authority and validates the correlated desktop snapshot", async () => {
    await pipe(
      (request, socket) => {
        expect(request.adminToken).toBe("backend-only");
        expect(request.method).toBe("remote.credentials.create");
        socket.end(
          `${JSON.stringify({
            ok: true,
            id: request.id,
            result: {
              accountId: "a",
              credentials: {
                identityPrivateKey: Buffer.alloc(32, 7).toString("base64"),
                registration: null,
              },
            },
          })}\n`,
        );
      },
      async (client) => {
        expect((await client.getOrCreate()).accountId).toBe("a");
      },
    );
  });
  it("rejects wrong response identities and closes cancelled requests", async () => {
    await pipe(
      (_request, socket) => socket.end('{"id":"wrong","ok":true}\n'),
      async (client) => {
        await expect(client.read()).rejects.toThrow("invalid RemoteLink credential response");
      },
    );
    const abort = new AbortController();
    await pipe(
      () => abort.abort(),
      async (client) => {
        await expect(client.read(abort.signal)).rejects.toThrow("cancelled");
      },
    );
  });
});
