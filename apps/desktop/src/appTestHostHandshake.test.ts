import { describe, expect, it } from "vitest";

import { resolveAppTestHandshake } from "./appTestHostHandshake";

describe("resolveAppTestHandshake", () => {
  it("preserves a successful handshake", async () => {
    await expect(resolveAppTestHandshake(async () => undefined)).resolves.toBe("ready");
  });

  it("routes the bounded handshake timeout to diagnostics", async () => {
    await expect(
      resolveAppTestHandshake(async () => {
        throw new Error('App integration phase "runtime-handshake" exceeded 10000 ms.');
      }),
    ).resolves.toBe("timed-out");
  });

  it("does not hide unrelated handshake failures", async () => {
    await expect(
      resolveAppTestHandshake(async () => {
        throw new Error("frame execution failed");
      }),
    ).rejects.toThrow("frame execution failed");
  });
});
