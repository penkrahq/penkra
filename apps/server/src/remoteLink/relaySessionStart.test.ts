import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { createNoiseIdentity, noisePublicKey, NoiseHandshake } from "./noise";
import { httpFixture } from "./httpFixture.test-support";
import { remoteNoisePrologue } from "./pairedSession";
import { RemotePairingApprovals } from "./pairingApprovals";
import { decodePairingResult } from "./pairingProtocol";
import { makeRemotePhoneRegistry } from "./phoneRegistry";
import { RemoteRegistryClient } from "./registry";
import { decodeRelayFrame, encodeRelayFrame, RelayFrameType, RelayOpenMode } from "./relayProtocol";
import { makeRelaySessionStart } from "./relaySessionStart";
import { RelaySessions } from "./relaySessions";
import type { RemoteRelaySocket } from "./relaySocket";
import { RemoteTrustStore, RemoteTrustStoreLive } from "./trustStore";
import { remoteTrustScopeLayer } from "./trustScope.test-support";
import { encodeTunnelEnvelope } from "./tunnelCodec";
import { makeSessionRelay } from "./sessionRelay";

const macId = "10000000-0000-4000-8000-000000000001";
const phoneId = "10000000-0000-4000-8000-000000000002";
const sessionId = "10000000-0000-4000-8000-000000000003";
const layer = RemoteTrustStoreLive.pipe(
  Layer.provideMerge(remoteTrustScopeLayer),
  Layer.provideMerge(SessionCredentialServiceLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "penkra-relay-start-" })),
  Layer.provide(NodeServices.layer),
);

it("routes a real KK handshake and encrypted data through the session owner", async () => {
  const macKey = createNoiseIdentity(),
    phoneKey = createNoiseIdentity();
  const phone = new NoiseHandshake({
    pattern: "KK",
    initiator: true,
    staticPrivateKey: phoneKey,
    remoteStaticKey: noisePublicKey(macKey),
    prologue: remoteNoisePrologue(macId, phoneId),
  });
  const viewed = Promise.withResolvers<string | null>();
  let router: RelaySessions;
  const socket = {
    send: async (frame: { payload: Uint8Array }) => {
      phone.readMessage(frame.payload);
      router.receive({
        type: RelayFrameType.DATA,
        sessionId,
        peerId: phoneId,
        payload: phone
          .finish()
          .send.encrypt(encodeTunnelEnvelope({ t: "viewing", threadId: "fixture-thread" })),
      });
    },
  } as unknown as RemoteRelaySocket;
  try {
    await Effect.gen(function* () {
      const trust = yield* RemoteTrustStore;
      const issued = yield* trust.allow({
        deviceId: phoneId,
        name: "Phone",
        identityKey: noisePublicKey(phoneKey),
      });
      yield* trust.markPaired(phoneId, issued.sessionId);
      const registry = yield* makeRemotePhoneRegistry(
        new RemoteRegistryClient({ apiUrl: "http://localhost:1", deviceToken: "fixture" }),
      );
      const makeStart = yield* makeRelaySessionStart({
        macDeviceId: macId,
        macPrivateKey: macKey,
        origin: "http://127.0.0.1:1",
        approvals: new RemotePairingApprovals(() => undefined),
        registry,
        onViewing: (_phone, thread) => viewed.resolve(thread),
        observe: () => undefined,
      });
      router = new RelaySessions({
        start: makeStart(socket),
        closePeer: async () => undefined,
        observeFailure: (error) => {
          throw error;
        },
      });
      router.receive({
        type: RelayFrameType.OPEN,
        mode: RelayOpenMode.SESSION,
        sessionId,
        peerId: phoneId,
        payload: phone.writeMessage(new Uint8Array()),
      });
      expect(yield* Effect.promise(() => viewed.promise)).toBe("fixture-thread");
      yield* Effect.promise(() => router.close());
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
  } finally {
    phone.destroy();
    macKey.fill(0);
    phoneKey.fill(0);
  }
});

it("routes a real XX pairing and an explicit denial through the session owner", async () => {
  const macKey = createNoiseIdentity(),
    phoneKey = createNoiseIdentity();
  const phone = new NoiseHandshake({
    pattern: "XX",
    initiator: true,
    staticPrivateKey: phoneKey,
    prologue: remoteNoisePrologue(macId, phoneId),
  });
  const result = Promise.withResolvers<string>();
  let router: RelaySessions;
  let replies = 0;
  const socket = {
    send: async (frame: { payload: Uint8Array }) => {
      if (++replies === 1) {
        phone.readMessage(frame.payload);
        router.receive({
          type: RelayFrameType.DATA,
          sessionId,
          peerId: phoneId,
          payload: phone.writeMessage(new Uint8Array()),
        });
      } else
        result.resolve(decodePairingResult(phone.finish().receive.decrypt(frame.payload)).type);
    },
  } as unknown as RemoteRelaySocket;
  const approvals = new RemotePairingApprovals((request) => {
    if (request) approvals.answer(request.requestId, false);
  });
  try {
    await Effect.gen(function* () {
      const registry = yield* makeRemotePhoneRegistry(
        new RemoteRegistryClient({ apiUrl: "http://localhost:1", deviceToken: "fixture" }),
      );
      const makeStart = yield* makeRelaySessionStart({
        macDeviceId: macId,
        macPrivateKey: macKey,
        origin: "http://127.0.0.1:1",
        approvals,
        registry,
        onViewing: () => undefined,
        observe: () => undefined,
      });
      router = new RelaySessions({
        start: makeStart(socket),
        closePeer: async () => undefined,
        observeFailure: (error) => {
          throw error;
        },
      });
      router.receive({
        type: RelayFrameType.OPEN,
        mode: RelayOpenMode.PAIRING,
        sessionId,
        peerId: phoneId,
        payload: phone.writeMessage(
          Buffer.from(JSON.stringify({ type: "pair", name: "Phone", model: "Fixture" })),
        ),
      });
      expect(yield* Effect.promise(() => result.promise)).toBe("denied");
      yield* Effect.promise(() => router.close());
      expect(yield* (yield* RemoteTrustStore).list()).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
  } finally {
    approvals.close();
    phone.destroy();
    macKey.fill(0);
    phoneKey.fill(0);
  }
});

it("routes an immediate relay OPEN through real WebSocket and XX pairing", async () => {
  await httpFixture(
    (_request, response) => response.end(),
    async (origin, server) => {
      const macKey = createNoiseIdentity(),
        phoneKey = createNoiseIdentity();
      const phone = new NoiseHandshake({
        pattern: "XX",
        initiator: true,
        staticPrivateKey: phoneKey,
        prologue: remoteNoisePrologue(macId, phoneId),
      });
      const result = Promise.withResolvers<string>();
      const wss = new WebSocketServer({ noServer: true });
      server.on("upgrade", (request, socket, head) =>
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.send(
            encodeRelayFrame({
              type: RelayFrameType.OPEN,
              mode: RelayOpenMode.PAIRING,
              sessionId,
              peerId: phoneId,
              payload: phone.writeMessage(
                Buffer.from(JSON.stringify({ type: "pair", name: "Phone", model: "Fixture" })),
              ),
            }),
          );
          let replies = 0;
          ws.on("message", (data) => {
            const frame = decodeRelayFrame(data as Buffer);
            if (frame.type !== RelayFrameType.DATA) return;
            if (++replies === 1) {
              phone.readMessage(frame.payload);
              ws.send(
                encodeRelayFrame({
                  type: RelayFrameType.DATA,
                  sessionId,
                  peerId: phoneId,
                  payload: phone.writeMessage(new Uint8Array()),
                }),
              );
            } else
              result.resolve(
                decodePairingResult(phone.finish().receive.decrypt(frame.payload)).type,
              );
          });
        }),
      );
      const approvals = new RemotePairingApprovals((request) => {
        if (request) approvals.answer(request.requestId, false);
      });
      try {
        await Effect.gen(function* () {
          const registry = yield* makeRemotePhoneRegistry(
            new RemoteRegistryClient({ apiUrl: "http://localhost:1", deviceToken: "fixture" }),
          );
          const relay = yield* makeSessionRelay({
            macDeviceId: macId,
            macPrivateKey: macKey,
            origin: "http://127.0.0.1:1",
            approvals,
            registry,
            url: origin.replace("http:", "ws:") + "/v1",
            deviceToken: "fixture",
            signal: new AbortController().signal,
            onViewing: () => undefined,
            observe: () => undefined,
            observeSocket: () => undefined,
            observeReconnect: () => undefined,
            observeFailure: (error) => {
              throw error;
            },
          });
          try {
            expect(yield* Effect.promise(() => result.promise)).toBe("denied");
          } finally {
            yield* Effect.promise(() => relay.close());
          }
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
      } finally {
        approvals.close();
        phone.destroy();
        macKey.fill(0);
        phoneKey.fill(0);
        for (const socket of wss.clients) socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    },
  );
});

it("reconciles phone permissions again on each relay connection", async () => {
  await httpFixture(
    (_request, response) => response.end(),
    async (origin, server) => {
      const wss = new WebSocketServer({ noServer: true });
      server.on("upgrade", (request, socket, head) =>
        wss.handleUpgrade(request, socket, head, () => undefined),
      );
      const first = Promise.withResolvers<void>(),
        second = Promise.withResolvers<void>();
      let count = 0;
      const approvals = new RemotePairingApprovals(() => undefined);
      const macKey = createNoiseIdentity();
      try {
        await Effect.gen(function* () {
          const registry = yield* makeRemotePhoneRegistry(
            new RemoteRegistryClient({ apiUrl: "http://localhost:1", deviceToken: "fixture" }),
          );
          const relay = yield* makeSessionRelay({
            macDeviceId: macId,
            macPrivateKey: macKey,
            origin: "http://127.0.0.1:1",
            approvals,
            registry: {
              ...registry,
              reconcile: Effect.sync(() => {
                if (++count === 1) first.resolve();
                else second.resolve();
              }),
            },
            url: origin.replace("http:", "ws:") + "/v1",
            deviceToken: "fixture",
            signal: new AbortController().signal,
            onViewing: () => undefined,
            observe: () => undefined,
            observeSocket: () => undefined,
            observeReconnect: () => undefined,
            observeFailure: () => undefined,
          });
          try {
            yield* Effect.promise(() => first.promise);
            relay.reconnect("wake");
            yield* Effect.promise(() => second.promise);
            expect(count).toBe(2);
          } finally {
            yield* Effect.promise(() => relay.close());
          }
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
      } finally {
        approvals.close();
        macKey.fill(0);
        for (const socket of wss.clients) socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    },
  );
});
