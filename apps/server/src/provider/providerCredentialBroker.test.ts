import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeProviderCredentialBroker } from "./providerCredentialBroker";

describe("provider credential broker", () => {
  it("disables secret methods when desktop safe storage is unavailable", async () => {
    const broker = makeProviderCredentialBroker({});
    expect(broker.available).toBe(false);
    await expect(Effect.runPromise(broker.store("sentinel"))).rejects.toThrow(
      "unavailable outside Penkra Desktop",
    );
  });
});

async function withCredentialPipe(
  handle: (socket: import("node:net").Socket, request: { id: string }) => void,
  run: (broker: ReturnType<typeof makeProviderCredentialBroker>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "penkra-credentials-"));
  const pipe = join(directory, "pipe.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.includes("\n")) handle(socket, JSON.parse(buffer));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });
  try {
    await run(
      makeProviderCredentialBroker({
        PENKRA_APP_COMMAND_PIPE: pipe,
        PENKRA_APP_COMMAND_TOKEN: "test-token",
      }),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

it("resolves on the desktop answer", async () => {
  await withCredentialPipe(
    (socket, request) => {
      socket.end(JSON.stringify({ id: request.id, ok: true, result: { exists: true } }) + "\n");
    },
    async (broker) => {
      await expect(Effect.runPromise(broker.has("test-reference"))).resolves.toBe(true);
    },
  );
});

it("rejects when the desktop closes without answering", async () => {
  await withCredentialPipe(
    (socket) => socket.end(),
    async (broker) => {
      await expect(Effect.runPromise(broker.has("test-reference"))).rejects.toThrow(
        "Desktop closed the provider credential request without a response.",
      );
    },
  );
});
