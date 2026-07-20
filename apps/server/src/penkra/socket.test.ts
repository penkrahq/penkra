import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Server as SocketServer } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";

import { coalesceRegistryReconciliations } from "./registrySync";
import { PenkraSocketClient } from "./socket";

let httpServer: HttpServer | null = null;
let socketServer: SocketServer | null = null;
let root: string | null = null;

afterEach(async () => {
  socketServer?.close();
  socketServer = null;
  await closeHttpServer();
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("PenkraSocketClient", () => {
  it("publishes offline state and performs a full pull after reconnect", async () => {
    root = await mkdtemp(path.join(tmpdir(), "penkra-socket-"));
    const configPath = path.join(root, "hq", ".penkra", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    let revision = 1;
    const port = await startBackend(0, () => remoteSnapshot(revision));
    const endpoint = `http://127.0.0.1:${port}`;
    await writeFile(configPath, JSON.stringify({ endpoint, scope: "hq", token: "pk_hq_test" }));
    const published: Array<{ status: string; generatedAt: string | null }> = [];
    let registryReconciliations = 0;
    const client = new PenkraSocketClient(
      { root, endpoint, hqConfigPath: configPath },
      (snapshot) => published.push({ status: snapshot.status, generatedAt: snapshot.generatedAt }),
      async () => {
        registryReconciliations += 1;
      },
    );

    await expect(client.getSnapshot()).resolves.toMatchObject({
      status: "ready",
      generatedAt: "r1",
    });
    await waitFor(() => published.some((snapshot) => snapshot.status === "ready"));
    await waitFor(() => registryReconciliations === 1);

    revision = 2;
    socketServer!.emit("penkra:changed", { entity: "todo", id: "todo-1" });
    await waitFor(() => published.some((snapshot) => snapshot.generatedAt === "r2"));
    expect(registryReconciliations).toBe(1);

    socketServer!.emit("penkra:changed", { entity: "client", id: "client-1" });
    await waitFor(() => registryReconciliations === 2);

    socketServer!.close();
    socketServer = null;
    await closeHttpServer();
    await waitFor(() => published.at(-1)?.status === "offline");

    revision = 3;
    await startBackend(port, () => remoteSnapshot(revision));
    await waitFor(() => published.some((snapshot) => snapshot.generatedAt === "r3"), 5_000);
    await waitFor(() => registryReconciliations === 3, 5_000);
    expect(published.at(-1)).toEqual({ status: "ready", generatedAt: "r3" });
    client.close();
  });

  it("reports reconciliation failures without losing remote snapshot updates", async () => {
    root = await mkdtemp(path.join(tmpdir(), "penkra-socket-"));
    const configPath = path.join(root, "hq", ".penkra", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    let revision = 1;
    const port = await startBackend(0, () => remoteSnapshot(revision));
    const endpoint = `http://127.0.0.1:${port}`;
    await writeFile(configPath, JSON.stringify({ endpoint, scope: "hq", token: "pk_hq_test" }));
    const published: Array<{ status: string; generatedAt: string | null }> = [];
    const failures: Array<{ phase: string; entity: string | null; id: string | null }> = [];
    const client = new PenkraSocketClient(
      { root, endpoint, hqConfigPath: configPath },
      (snapshot) => published.push({ status: snapshot.status, generatedAt: snapshot.generatedAt }),
      async () => {
        throw new Error("disk unavailable");
      },
      (failure) => failures.push({ phase: failure.phase, entity: failure.entity, id: failure.id }),
    );

    await expect(client.getSnapshot()).resolves.toMatchObject({ generatedAt: "r1" });
    await waitFor(() => failures.some((failure) => failure.phase === "connect"));

    revision = 2;
    socketServer!.emit("penkra:changed", { entity: "client", id: "client-1" });
    await waitFor(() => published.some((snapshot) => snapshot.generatedAt === "r2"));
    await waitFor(() =>
      failures.some(
        (failure) =>
          failure.phase === "change" && failure.entity === "client" && failure.id === "client-1",
      ),
    );
    client.close();
  });

  it("reconciles relevant changes before publishing their refreshed snapshot", async () => {
    root = await mkdtemp(path.join(tmpdir(), "penkra-socket-"));
    const configPath = path.join(root, "hq", ".penkra", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    let revision = 1;
    const port = await startBackend(0, () => remoteSnapshot(revision));
    const endpoint = `http://127.0.0.1:${port}`;
    await writeFile(configPath, JSON.stringify({ endpoint, scope: "hq", token: "pk_hq_test" }));
    const published: Array<{ status: string; generatedAt: string | null }> = [];
    let reconciliation = 0;
    let releaseChange!: () => void;
    const blockedChange = new Promise<void>((resolve) => {
      releaseChange = resolve;
    });
    const client = new PenkraSocketClient(
      { root, endpoint, hqConfigPath: configPath },
      (snapshot) => published.push({ status: snapshot.status, generatedAt: snapshot.generatedAt }),
      async () => {
        reconciliation += 1;
        if (reconciliation === 2) await blockedChange;
      },
    );

    await expect(client.getSnapshot()).resolves.toMatchObject({ generatedAt: "r1" });
    await waitFor(() => reconciliation === 1);
    revision = 2;
    socketServer!.emit("penkra:changed", { entity: "client", id: "client-1" });
    await waitFor(() => reconciliation === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(published.some((snapshot) => snapshot.generatedAt === "r2")).toBe(false);

    releaseChange();
    await waitFor(() => published.some((snapshot) => snapshot.generatedAt === "r2"));
    client.close();
  });

  it("runs one trailing refresh when changes overlap an in-flight snapshot", async () => {
    root = await mkdtemp(path.join(tmpdir(), "penkra-socket-"));
    const configPath = path.join(root, "hq", ".penkra", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    let revision = 1;
    let blockSnapshot = false;
    let blockedSnapshotStarted = false;
    let releaseSnapshot!: () => void;
    const blockedSnapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const port = await startBackend(0, async () => {
      const capturedRevision = revision;
      if (blockSnapshot) {
        blockSnapshot = false;
        blockedSnapshotStarted = true;
        await blockedSnapshot;
      }
      return remoteSnapshot(capturedRevision);
    });
    const endpoint = `http://127.0.0.1:${port}`;
    await writeFile(configPath, JSON.stringify({ endpoint, scope: "hq", token: "pk_hq_test" }));
    const published: Array<{ status: string; generatedAt: string | null }> = [];
    const client = new PenkraSocketClient(
      { root, endpoint, hqConfigPath: configPath },
      (snapshot) => published.push({ status: snapshot.status, generatedAt: snapshot.generatedAt }),
    );

    await expect(client.getSnapshot()).resolves.toMatchObject({ generatedAt: "r1" });
    await waitFor(() => published.some((snapshot) => snapshot.generatedAt === "r1"));
    revision = 2;
    blockSnapshot = true;
    socketServer!.emit("penkra:changed", { entity: "todo", id: "todo-1" });
    await waitFor(() => blockedSnapshotStarted);
    revision = 3;
    socketServer!.emit("penkra:changed", { entity: "todo", id: "todo-2" });
    releaseSnapshot();

    await waitFor(() => published.some((snapshot) => snapshot.generatedAt === "r3"));
    client.close();
  });

  it("coalesces overlapping registry requests into one required follow-up", async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reconcile = coalesceRegistryReconciliations(async () => {
      calls += 1;
      if (calls === 1) await firstRun;
      return calls;
    });

    const first = reconcile();
    const second = reconcile();
    const third = reconcile();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(calls).toBe(1);

    releaseFirst();
    await expect(first).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  it("allows a fresh reconciliation after a failed run", async () => {
    let calls = 0;
    const reconcile = coalesceRegistryReconciliations(async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      return calls;
    });

    await expect(reconcile()).rejects.toThrow("temporary failure");
    await expect(reconcile()).resolves.toBe(2);
  });
});

async function startBackend(
  port: number,
  snapshot: () => object | Promise<object>,
): Promise<number> {
  httpServer = createServer(async (request, response) => {
    if (
      request.url !== "/api/app/snapshot" ||
      request.headers.authorization !== "Bearer pk_hq_test"
    ) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(await snapshot()));
  });
  socketServer = new SocketServer(httpServer, {
    path: "/api/socket.io",
    transports: ["websocket"],
  });
  socketServer.use((socket, next) => {
    next(socket.handshake.auth.token === "pk_hq_test" ? undefined : new Error("Unauthorized"));
  });
  await new Promise<void>((resolve) => httpServer!.listen(port, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
}

async function closeHttpServer(): Promise<void> {
  if (!httpServer) return;
  const current = httpServer;
  httpServer = null;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

function remoteSnapshot(revision: number) {
  return {
    generatedAt: `r${revision}`,
    clients: [],
    todos: [],
    programWarnings: [],
  };
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
