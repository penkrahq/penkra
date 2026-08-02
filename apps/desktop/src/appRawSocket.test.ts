import * as Net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { exchangeRawSocket } from "./appRawSocket";

const servers: Net.Server[] = [];
afterEach(async () =>
  Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  ),
);

describe("raw socket boundary", () => {
  it("performs one bounded loopback exchange without exposing a live socket", async () => {
    const server = Net.createServer((socket) =>
      socket.on("data", (data) => socket.end(Buffer.from(data.toString().toUpperCase()))),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const response = await exchangeRawSocket({
      host: "127.0.0.1",
      port: address.port,
      payload: new TextEncoder().encode("hello"),
    });
    expect(new TextDecoder().decode(response)).toBe("HELLO");
  });

  it("rejects invalid ports and oversized response requests", async () => {
    await expect(
      exchangeRawSocket({ host: "localhost", port: 0, payload: new Uint8Array() }),
    ).rejects.toThrow("port");
    await expect(
      exchangeRawSocket({
        host: "localhost",
        port: 80,
        payload: new Uint8Array(),
        responseBytes: 2_000_000,
      }),
    ).rejects.toThrow("responseBytes");
  });
});
