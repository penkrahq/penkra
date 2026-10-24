import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { RemoteTrustStore, RemoteTrustStoreLive } from "./trustStore";
import { createNoiseIdentity, noisePublicKey, NoiseHandshake } from "./noise";
import { remoteNoisePrologue } from "./pairedSession";
import { runPairedConnection } from "./pairedConnection";
import { encodeTunnelEnvelope } from "./tunnelCodec";
import type { RemoteSessionBridge } from "./sessionBridge";

const layer = RemoteTrustStoreLive.pipe(
  Layer.provideMerge(SessionCredentialServiceLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "penkra-paired-connection-" })),
  Layer.provide(NodeServices.layer),
);
const macId = "10000000-0000-4000-8000-000000000001";
const phoneId = "10000000-0000-4000-8000-000000000002";

describe("paired connection ownership", () => {
  it("accepts authenticated DATA arriving as soon as the handshake reply is delivered", async () => {
    const macKey = createNoiseIdentity(),
      phoneKey = createNoiseIdentity();
    const phone = new NoiseHandshake({
      pattern: "KK",
      initiator: true,
      staticPrivateKey: phoneKey,
      remoteStaticKey: noisePublicKey(macKey),
      prologue: remoteNoisePrologue(macId, phoneId),
    });
    let bridge: RemoteSessionBridge | undefined;
    const viewing: (string | null)[] = [];
    try {
      await Effect.gen(function* () {
        const trust = yield* RemoteTrustStore;
        const issued = yield* trust.allow({
          deviceId: phoneId,
          name: "Fixture Phone",
          identityKey: noisePublicKey(phoneKey),
        });
        yield* trust.markPaired(phoneId, issued.sessionId);
        const result = yield* Effect.exit(
          runPairedConnection({
            macDeviceId: macId,
            macPrivateKey: macKey,
            phoneDeviceId: phoneId,
            sessionId: "immediate-data",
            origin: "http://127.0.0.1:1",
            openingMessage: phone.writeMessage(new Uint8Array()),
            sendHandshakeReply: async (reply) => {
              phone.readMessage(reply);
              // Delivery can make the peer's next frame arrive before this write callback returns.
              expect(bridge).toBeDefined();
              bridge!.receive(
                phone
                  .finish()
                  .send.encrypt(encodeTunnelEnvelope({ t: "viewing", threadId: "thread-1" })),
              );
              await bridge!.close();
            },
            sendWire: async () => undefined,
            onBridge: (value) => {
              bridge = value;
            },
            onViewing: (value) => viewing.push(value),
            observe: () => undefined,
          }),
        );
        expect(Exit.isSuccess(result)).toBe(true);
        expect(viewing).toEqual(["thread-1", null]);
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
    } finally {
      phone.destroy();
      macKey.fill(0);
      phoneKey.fill(0);
    }
  });
  it("releases its authenticated lease when the handshake reply cannot be sent", async () => {
    const macKey = createNoiseIdentity(),
      phoneKey = createNoiseIdentity();
    const phone = new NoiseHandshake({
      pattern: "KK",
      initiator: true,
      staticPrivateKey: phoneKey,
      remoteStaticKey: noisePublicKey(macKey),
      prologue: remoteNoisePrologue(macId, phoneId),
    });
    const viewing: (string | null)[] = [];
    let opened: RemoteSessionBridge | undefined;
    try {
      await Effect.gen(function* () {
        const trust = yield* RemoteTrustStore;
        const sessions = yield* SessionCredentialService;
        const issued = yield* trust.allow({
          deviceId: phoneId,
          name: "Fixture Phone",
          identityKey: noisePublicKey(phoneKey),
        });
        yield* trust.markPaired(phoneId, issued.sessionId);
        const exit = yield* Effect.exit(
          runPairedConnection({
            macDeviceId: macId,
            macPrivateKey: macKey,
            phoneDeviceId: phoneId,
            sessionId: "failed-reply-session",
            origin: "http://127.0.0.1:1",
            openingMessage: phone.writeMessage(new Uint8Array()),
            sendHandshakeReply: async () => {
              throw new Error("fixture write failed");
            },
            sendWire: async () => undefined,
            onBridge: (bridge) => {
              opened = bridge;
            },
            onViewing: (value) => viewing.push(value),
            observe: () => undefined,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(opened?.channel.signal.aborted).toBe(true);
        expect(viewing).toEqual([null]);
        // A retained connection lease would make this await itself forever.
        yield* sessions.revoke(issued.sessionId);
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
    } finally {
      phone.destroy();
      macKey.fill(0);
      phoneKey.fill(0);
    }
  });
  it("revokes an authenticated connection with an asynchronous finalizer", async () => {
    await Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        role: "client",
        subject: phoneId,
        method: "bearer-session-token",
      });
      const ready = yield* Deferred.make<void>();
      const running = yield* Effect.forkChild(
        sessions.runAuthenticatedConnection(
          issued.sessionId,
          Effect.scoped(
            Effect.gen(function* () {
              const stopped = yield* Effect.acquireRelease(
                Effect.sync(() => new AbortController()),
                (value) =>
                  Effect.promise(async () => {
                    value.abort();
                    await Promise.resolve();
                  }),
              );
              yield* Effect.promise(async () => undefined);
              yield* Deferred.succeed(ready, undefined);
              yield* Effect.callback<void>((resume) => {
                const stop = () => resume(Effect.void);
                stopped.signal.addEventListener("abort", stop, { once: true });
                return Effect.sync(() => stopped.signal.removeEventListener("abort", stop));
              });
            }),
          ),
        ),
      );
      yield* Deferred.await(ready);
      yield* sessions.revoke(issued.sessionId);
      yield* Fiber.await(running);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
  });

  it("revocation closes the authenticated Noise session and clears viewing state", async () => {
    const macKey = createNoiseIdentity(),
      phoneKey = createNoiseIdentity();
    const phone = new NoiseHandshake({
      pattern: "KK",
      initiator: true,
      staticPrivateKey: phoneKey,
      remoteStaticKey: noisePublicKey(macKey),
      prologue: remoteNoisePrologue(macId, phoneId),
    });
    const viewing: (string | null)[] = [];
    let closed: RemoteSessionBridge | undefined;
    try {
      await Effect.gen(function* () {
        const trust = yield* RemoteTrustStore;
        const sessions = yield* SessionCredentialService;
        const issued = yield* trust.allow({
          deviceId: phoneId,
          name: "Fixture Phone",
          identityKey: noisePublicKey(phoneKey),
        });
        yield* trust.markPaired(phoneId, issued.sessionId);
        const ready = Promise.withResolvers<RemoteSessionBridge>();
        const running = yield* Effect.forkChild(
          runPairedConnection({
            macDeviceId: macId,
            macPrivateKey: macKey,
            phoneDeviceId: phoneId,
            sessionId: "fixture-relay-session",
            origin: "http://127.0.0.1:1",
            openingMessage: phone.writeMessage(new Uint8Array()),
            sendHandshakeReply: async (bytes) => {
              phone.readMessage(bytes);
              ready.resolve(closed!);
            },
            sendWire: async () => undefined,
            onBridge: (bridge) => {
              closed = bridge;
            },
            onViewing: (value) => viewing.push(value),
            observe: () => undefined,
          }),
        );
        const bridge = yield* Effect.promise(() => ready.promise);
        bridge.receive(
          phone.finish().send.encrypt(encodeTunnelEnvelope({ t: "viewing", threadId: "thread-1" })),
        );
        expect(bridge.viewingThreadId).toBe("thread-1");
        yield* trust.remove(phoneId);
        yield* Fiber.await(running);
        expect(bridge.channel.signal.aborted).toBe(true);
        expect(bridge.viewingThreadId).toBeNull();
        expect(yield* sessions.listActive()).toHaveLength(0);
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
      expect(viewing).toEqual(["thread-1", null]);
      expect(closed?.channel.signal.aborted).toBe(true);
    } finally {
      phone.destroy();
      macKey.fill(0);
      phoneKey.fill(0);
    }
  });
});
