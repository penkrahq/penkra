import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { waitForOpenCodeSessionIdle } from "./Layers/OpenCodeAdapter.ts";

import { openCodeRuntimeErrorDetail } from "./opencodeRuntime.ts";

describe("openCodeRuntimeErrorDetail", () => {
  it("keeps the socket reason when the server drops a request", async () => {
    const server = createServer((request) => request.socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const failure = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" }).then(
      () => null,
      (cause: unknown) => cause,
    );
    server.close();
    expect(openCodeRuntimeErrorDetail(failure)).toMatch(/^fetch failed \(UND_ERR_SOCKET .+\)$/);
  });

  it("leaves plain errors unchanged", () => {
    expect(openCodeRuntimeErrorDetail(new Error("Session is busy"))).toBe("Session is busy");
  });
});

describe("waitForOpenCodeSessionIdle", () => {
  it("waits while a cancelled run is still busy", async () => {
    const statuses = ["busy", "busy", "idle"];
    let reads = 0;
    await Effect.runPromise(
      waitForOpenCodeSessionIdle(() => Effect.sync(() => statuses[reads++] ?? "idle"), {
        intervalMs: 1,
      }),
    );
    expect(reads).toBe(3);
  });

  it("fails with a clear reason when the session never settles", async () => {
    const exit = await Effect.runPromiseExit(
      waitForOpenCodeSessionIdle(() => Effect.succeed("busy"), { timeoutMs: 20, intervalMs: 1 }),
    );
    expect(JSON.stringify(exit)).toContain("still busy");
  });
});
