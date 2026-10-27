import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeRemoteAccountWork } from "./accountWork";
import type { DesktopRemoteCredentials } from "./desktopCredentials";
import { RemotePairingApprovals } from "./pairingApprovals";
import { httpFixture } from "./httpFixture.test-support";
import { decodeRelayFrame, RelayFrameType } from "./relayProtocol";

const layer = SessionCredentialServiceLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "penkra-remote-account-work-" })),
  Layer.provide(NodeServices.layer),
);
const snapshot = {
  accountServiceUrl: "https://account.example.test",
  accountId: "a",
  accessOn: true,
  suspended: false,
};

it("does not open a relay with another account's registration", async () => {
  const failure = Promise.withResolvers<unknown>();
  const credentials = {
    read: async () => ({ accountId: "b", credentials: null }),
  } as unknown as DesktopRemoteCredentials;
  const approvals = new RemotePairingApprovals(() => undefined);
  await Effect.gen(function* () {
    const mount = yield* makeRemoteAccountWork({
      relayUrl: "ws://127.0.0.1:1/v1",
      origin: "http://127.0.0.1:1",
      credentials,
      approvals,
      onViewing: () => undefined,
      onSessions: () => undefined,
      observeSocket: () => undefined,
      observeReconnect: () => undefined,
      observeSession: () => undefined,
      observeFailure: failure.resolve,
    });
    const work = mount(snapshot, new AbortController().signal);
    expect(yield* Effect.promise(() => failure.promise)).toBeInstanceOf(Error);
    yield* Effect.promise(() => work.close("sign-out"));
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
  approvals.close();
});

it("cancels and joins credential preparation before an account can be replaced", async () => {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const credentials = {
    read: (signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        started.resolve();
        signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      }),
  } as unknown as DesktopRemoteCredentials;
  const approvals = new RemotePairingApprovals(() => undefined);
  await Effect.gen(function* () {
    const mount = yield* makeRemoteAccountWork({
      relayUrl: "ws://127.0.0.1:1/v1",
      origin: "http://127.0.0.1:1",
      credentials,
      approvals,
      onViewing: () => undefined,
      onSessions: () => undefined,
      observeSocket: () => undefined,
      observeReconnect: () => undefined,
      observeSession: () => undefined,
      observeFailure: () => {
        throw new Error("unexpected");
      },
    });
    const work = mount(snapshot, new AbortController().signal);
    yield* Effect.promise(() => started.promise);
    yield* Effect.promise(() => work.close("sign-out"));
    yield* Effect.promise(() => cancelled.promise);
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
  approvals.close();
});

it("sends sleep on the account's real relay before joining it", async () => {
  await httpFixture(
    (_request, response) => response.end(),
    async (origin, server) => {
      const wss = new WebSocketServer({ noServer: true });
      const opened = Promise.withResolvers<void>(),
        slept = Promise.withResolvers<number>();
      const failed = Promise.withResolvers<unknown>();
      server.on("upgrade", (request, socket, head) =>
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on("message", (bytes) => slept.resolve(decodeRelayFrame(bytes as Buffer).type));
        }),
      );
      const credentials = {
        read: async () => ({
          accountId: "a",
          credentials: {
            identityPrivateKey: Buffer.alloc(32, 1).toString("base64"),
            registration: {
              deviceId: "10000000-0000-4000-8000-000000000001",
              deviceToken: "fixture",
            },
          },
        }),
      } as unknown as DesktopRemoteCredentials;
      const approvals = new RemotePairingApprovals(() => undefined);
      try {
        await Effect.gen(function* () {
          const mount = yield* makeRemoteAccountWork({
            relayUrl: origin.replace("http:", "ws:") + "/v1",
            origin: "http://127.0.0.1:1",
            credentials,
            approvals,
            onViewing: () => undefined,
            onSessions: () => undefined,
            observeSocket: (event) => {
              if (event.event === "opened") opened.resolve();
            },
            observeReconnect: () => undefined,
            observeSession: () => undefined,
            observeFailure: failed.resolve,
          });
          const work = mount(snapshot, new AbortController().signal);
          yield* Effect.promise(() =>
            Promise.race([
              opened.promise,
              failed.promise.then((error) => {
                throw error;
              }),
            ]),
          );
          yield* Effect.promise(() => work.close("suspend"));
          expect(yield* Effect.promise(() => slept.promise)).toBe(RelayFrameType.SLEEP);
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
      } finally {
        approvals.close();
        for (const socket of wss.clients) socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    },
  );
});
