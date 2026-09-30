import http from "node:http";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { emitConnectionAfterUpgrade, installQaFrameObservation } from "./nodeHttpServer";

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
    webSocketServer.on("connection", () => {
      throw new Error("observer failed");
    });
    let upgraded = false;
    server.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, () => {
        upgraded = true;
      });
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
    expect(upgraded).toBe(true);
    webSocketServer.close();
  });
});

describe("QA frame observation", () => {
  it("does not wrap sends or convert messages when QA is disabled", () => {
    const socket = new EventEmitter() as EventEmitter & { send: (data: Buffer) => void };
    let sends = 0;
    socket.send = () => {
      sends += 1;
    };
    const originalSend = socket.send;
    installQaFrameObservation(socket as unknown as WebSocket, null);
    expect(socket.send).toBe(originalSend);
    expect(socket.listenerCount("message")).toBe(0);
    socket.send(Buffer.from("hello"));
    expect(sends).toBe(1);
  });
});
