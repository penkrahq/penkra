import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { startDesktopRemoteRuntime } from "./desktopRuntime";
import { RemoteDevicesControlState } from "./devicesControl";
import { DesktopRemoteCredentials } from "./desktopCredentials";
import { RemotePairingApprovals } from "./pairingApprovals";

it("releases the private lifecycle subscription when its backend scope closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "penkra-remote-runtime-"));
  const path = join(dir, "pipe.sock");
  const ack = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const item = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (item.method === "remote.lifecycle.subscribe") {
          socket.write(
            JSON.stringify({ id: item.id, ok: true, result: { subscribed: true } }) + "\n",
          );
          socket.write(
            JSON.stringify({
              type: "remote.lifecycle",
              revision: 0,
              event: "snapshot",
              snapshot: {
                accountServiceUrl: "https://account.example.test",
                accountId: null,
                accessOn: false,
                suspended: false,
              },
            }) + "\n",
          );
        } else if (item.type === "ack") ack.resolve();
        else if (item.type === "released") released.resolve();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const approvals = new RemotePairingApprovals(() => undefined);
  const layer = SessionCredentialServiceLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "remote-runtime-test-" })),
    Layer.provide(NodeServices.layer),
  );
  try {
    await Effect.gen(function* () {
      yield* startDesktopRemoteRuntime({
        relayUrl: "ws://127.0.0.1:1/v1",
        origin: "http://127.0.0.1:1",
        credentials: new DesktopRemoteCredentials(),
        approvals,
        onViewing: () => undefined,
        devices: new RemoteDevicesControlState(),
        observeSocket: () => undefined,
        observeReconnect: () => undefined,
        observeSession: () => undefined,
        observeFailure: () => {
          throw new Error("unexpected");
        },
        env: {
          PENKRA_APP_COMMAND_PIPE: path,
          PENKRA_APP_COMMAND_TOKEN: "fixture",
          PENKRA_APP_COMMAND_ADMIN_TOKEN: "fixture",
        },
      });
      yield* Effect.promise(() => ack.promise);
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise);
    expect(await released.promise).toBeUndefined();
  } finally {
    approvals.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
