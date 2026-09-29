import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { emitConnectionAfterUpgrade } from "./nodeHttpServer";

const servers: http.Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.length = 0;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("emitConnectionAfterUpgrade", () => {
  it("runs the connection observer when an upgrade handler uses the callback directly", async () => {
    const server = http.createServer();
    servers.push(server);
    const webSocketServer = new WebSocketServer({ noServer: true });
    emitConnectionAfterUpgrade(webSocketServer);
    let observed = 0;
    webSocketServer.on("connection", () => {
      observed += 1;
    });
    server.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    sockets.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });

    expect(observed).toBe(1);
    webSocketServer.close();
  });
});
