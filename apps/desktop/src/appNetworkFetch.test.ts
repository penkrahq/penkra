import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { isPrivateAddress, mediatedAppFetch } from "./appNetworkFetch";

describe("mediated App network policy", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("recognizes local, private, link-local, multicast, and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.2",
      "224.0.0.1",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("rejects non-HTTPS, embedded credentials, and unsafe methods before transport", async () => {
    await expect(mediatedAppFetch({ url: "http://example.com" })).rejects.toThrow("HTTPS");
    await expect(mediatedAppFetch({ url: "https://user:pass@example.com" })).rejects.toThrow(
      "credentials",
    );
    await expect(
      mediatedAppFetch({ url: "https://example.com", method: "CONNECT" }),
    ).rejects.toThrow("not supported");
  });

  it("allows credential-free loopback HTTP for local App development", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server address.");

    const response = await mediatedAppFetch({ url: `http://127.0.0.1:${address.port}/health` });

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}');
  });
});
