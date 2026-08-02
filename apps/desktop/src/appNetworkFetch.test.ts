import { describe, expect, it } from "vitest";
import { isPrivateAddress, mediatedAppFetch } from "./appNetworkFetch";

describe("mediated App network policy", () => {
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
});
