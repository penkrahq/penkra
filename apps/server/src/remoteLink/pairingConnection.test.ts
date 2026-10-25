import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { httpFixture } from "./httpFixture.test-support";
import { createNoiseIdentity, NoiseHandshake, noisePairingCode } from "./noise";
import { openPairedSession, remoteNoisePrologue } from "./pairedSession";
import { PAIRING_REQUEST_TTL_MS, RemotePairingApprovals } from "./pairingApprovals";
import { runPairingConnection } from "./pairingConnection";
import { decodePairingResult } from "./pairingProtocol";
import { makeRemotePhoneRegistry } from "./phoneRegistry";
import { RemoteRegistryClient } from "./registry";
import { RemoteTrustStore, RemoteTrustStoreLive } from "./trustStore";

const layer = RemoteTrustStoreLive.pipe(
  Layer.provideMerge(SessionCredentialServiceLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "penkra-pairing-connection-test-" }),
  ),
  Layer.provide(NodeServices.layer),
);
const macId = "10000000-0000-4000-8000-000000000001";
const phoneId = "10000000-0000-4000-8000-000000000002";
afterEach(() => vi.useRealTimers());

function phone() {
  const macKey = createNoiseIdentity(),
    phoneKey = createNoiseIdentity();
  const handshake = new NoiseHandshake({
    pattern: "XX",
    initiator: true,
    staticPrivateKey: phoneKey,
    prologue: remoteNoisePrologue(macId, phoneId),
  });
  const opening = handshake.writeMessage(
    Buffer.from(JSON.stringify({ type: "pair", name: "Fixture iPhone", model: "Fixture model" })),
  );
  let receive: ((bytes: Uint8Array) => void) | null = null;
  let replies = 0;
  const results: unknown[] = [];
  return {
    macKey,
    phoneKey,
    handshake,
    opening,
    results,
    setReceiver: (next: typeof receive) => {
      receive = next;
    },
    receiver: () => receive,
    sendWire: async (bytes: Uint8Array) => {
      replies++;
      if (replies === 1) {
        handshake.readMessage(bytes);
        const final = handshake.writeMessage(new Uint8Array());
        expect(receive).not.toBeNull();
        receive!(final); // Peer may answer synchronously inside the reply writer.
      } else results.push(decodePairingResult(handshake.finish().receive.decrypt(bytes)));
    },
  };
}

describe("scoped XX pairing with real registry HTTP and isolated SQLite", () => {
  it("interrupts a pairing even while the relay reply callback is held", async () => {
    const peer = phone();
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const approvals = new RemotePairingApprovals(() => {
      throw new Error("Consent must not start yet");
    });
    try {
      await Effect.gen(function* () {
        const trust = yield* RemoteTrustStore;
        const registry = yield* makeRemotePhoneRegistry(
          new RemoteRegistryClient({ apiUrl: "https://example.test", deviceToken: "fixture" }),
        );
        const running = yield* Effect.forkChild(
          runPairingConnection({
            macDeviceId: macId,
            macPrivateKey: peer.macKey,
            phoneDeviceId: phoneId,
            openingMessage: peer.opening,
            approvals,
            registry,
            setReceiver: peer.setReceiver,
            sendWire: async (bytes) => {
              await peer.sendWire(bytes);
              writing.resolve();
              await release.promise;
            },
          }),
        );
        yield* Effect.promise(() => writing.promise);
        yield* Fiber.interrupt(running);
        expect(peer.receiver()).toBeNull();
        expect(approvals.current).toBeNull();
        expect(yield* trust.list()).toEqual([]);
        expect(peer.results).toEqual([]);
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
    } finally {
      release.resolve();
      approvals.close();
      peer.handshake.destroy();
    }
  });
  it.each(["paired", "denied", "expired", "failed"] as const)(
    "sends authenticated %s without confusing consent and persistence",
    async (expected) => {
      if (expected === "expired") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const peer = phone();
      const shown = Promise.withResolvers<void>();
      let posts = 0;
      const approvals = new RemotePairingApprovals((request) => {
        if (!request) return;
        expect(request.code).toBe(noisePairingCode(peer.handshake.finish().handshakeHash));
        expect(request.phoneName).toBe("Fixture iPhone");
        shown.resolve();
        if (expected !== "expired") approvals.answer(request.requestId, expected !== "denied");
      });
      try {
        await httpFixture(
          (_request, response) => {
            posts++;
            response.writeHead(expected === "failed" ? 503 : 204).end();
          },
          async (apiUrl) => {
            const running = Effect.gen(function* () {
              const trust = yield* RemoteTrustStore;
              const registry = yield* makeRemotePhoneRegistry(
                new RemoteRegistryClient({ apiUrl, deviceToken: "fixture" }),
              );
              const result = yield* runPairingConnection({
                macDeviceId: macId,
                macPrivateKey: peer.macKey,
                phoneDeviceId: phoneId,
                openingMessage: peer.opening,
                approvals,
                registry,
                setReceiver: peer.setReceiver,
                sendWire: peer.sendWire,
              });
              expect(result).toEqual({ type: expected });
              const saved = yield* trust.get(phoneId);
              if (expected === "paired" || expected === "failed")
                expect(saved?.pendingBackend).toBe(expected === "paired" ? 0 : 1);
              else expect(saved).toBeNull();
            }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
            if (expected === "expired") {
              void running.catch((error) => shown.reject(error));
              await shown.promise;
              await vi.advanceTimersByTimeAsync(PAIRING_REQUEST_TTL_MS);
            }
            await running;
          },
        );
        expect(peer.results).toEqual([{ type: expected }]);
        expect(posts).toBe(expected === "paired" || expected === "failed" ? 1 : 0);
        expect(approvals.current).toBeNull();
        expect(peer.receiver()).toBeNull();
        if (expected === "expired") expect(vi.getTimerCount()).toBe(0);
      } finally {
        approvals.close();
        peer.handshake.destroy();
      }
    },
  );

  it("invalid XX proof never opens the consent prompt or writes trust", async () => {
    const peer = phone();
    const observe = vi.fn();
    const approvals = new RemotePairingApprovals(observe);
    try {
      await Effect.gen(function* () {
        const trust = yield* RemoteTrustStore;
        const registry = yield* makeRemotePhoneRegistry(
          new RemoteRegistryClient({ apiUrl: "https://example.test", deviceToken: "fixture" }),
        );
        const error = yield* Effect.flip(
          runPairingConnection({
            macDeviceId: macId,
            macPrivateKey: peer.macKey,
            phoneDeviceId: phoneId,
            openingMessage: peer.opening,
            approvals,
            registry,
            setReceiver: peer.setReceiver,
            sendWire: async (bytes) => {
              peer.handshake.readMessage(bytes);
              const final = peer.handshake.writeMessage(new Uint8Array());
              final[final.length - 1]! ^= 1;
              peer.receiver()!(final);
            },
          }),
        );
        expect(error).toMatchObject({ code: "protocol" });
        expect(observe).not.toHaveBeenCalled();
        expect(yield* trust.list()).toEqual([]);
        expect(peer.receiver()).toBeNull();
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
    } finally {
      approvals.close();
      peer.handshake.destroy();
    }
  });

  it("disconnect while awaiting consent dismisses the request without a grant or fabricated result", async () => {
    const peer = phone();
    const shown = Promise.withResolvers<void>();
    const approvals = new RemotePairingApprovals((request) => {
      if (request) shown.resolve();
    });
    try {
      await Effect.gen(function* () {
        const trust = yield* RemoteTrustStore;
        const registry = yield* makeRemotePhoneRegistry(
          new RemoteRegistryClient({ apiUrl: "https://example.test", deviceToken: "fixture" }),
        );
        const running = yield* Effect.forkChild(
          runPairingConnection({
            macDeviceId: macId,
            macPrivateKey: peer.macKey,
            phoneDeviceId: phoneId,
            openingMessage: peer.opening,
            approvals,
            registry,
            setReceiver: peer.setReceiver,
            sendWire: peer.sendWire,
          }),
        );
        yield* Effect.promise(() => shown.promise);
        yield* Fiber.interrupt(running);
        expect(approvals.current).toBeNull();
        expect(yield* trust.list()).toEqual([]);
        expect(peer.results).toEqual([]);
        expect(peer.receiver()).toBeNull();
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
    } finally {
      approvals.close();
      peer.handshake.destroy();
    }
  });

  it("a lost paired reply retains committed trust so the phone can prove its key with KK", async () => {
    const peer = phone();
    const approvals = new RemotePairingApprovals((request) => {
      if (request) approvals.answer(request.requestId, true);
    });
    let writes = 0;
    try {
      await httpFixture(
        (_request, response) => response.writeHead(204).end(),
        (apiUrl) =>
          Effect.gen(function* () {
            const trust = yield* RemoteTrustStore;
            const registry = yield* makeRemotePhoneRegistry(
              new RemoteRegistryClient({ apiUrl, deviceToken: "fixture" }),
            );
            const error = yield* Effect.flip(
              runPairingConnection({
                macDeviceId: macId,
                macPrivateKey: peer.macKey,
                phoneDeviceId: phoneId,
                openingMessage: peer.opening,
                approvals,
                registry,
                setReceiver: peer.setReceiver,
                sendWire: async (bytes) => {
                  writes++;
                  if (writes === 1) await peer.sendWire(bytes);
                  else throw new Error("Reply transport lost");
                },
              }),
            );
            expect(error).toMatchObject({ code: "relay" });
            const saved = (yield* trust.get(phoneId))!;
            expect(saved.pendingBackend).toBe(0);
            const kk = new NoiseHandshake({
              pattern: "KK",
              initiator: true,
              staticPrivateKey: peer.phoneKey,
              remoteStaticKey: peer.handshake.finish().remoteStaticKey,
              prologue: remoteNoisePrologue(macId, phoneId),
            });
            try {
              const session = yield* openPairedSession({
                macDeviceId: macId,
                macPrivateKey: peer.macKey,
                phone: saved,
                openingMessage: kk.writeMessage(new Uint8Array()),
              });
              kk.readMessage(session.reply);
              expect(session.credential.sessionId).toBe(saved.sessionId);
            } finally {
              kk.destroy();
            }
          }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise),
      );
    } finally {
      approvals.close();
      peer.handshake.destroy();
    }
  });
});
