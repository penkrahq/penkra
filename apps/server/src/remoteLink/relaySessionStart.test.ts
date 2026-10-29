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

it("writes an explicit rejection frame when the Mac has no phone trust", async () => {
  const macKey = createNoiseIdentity();
  const rejected = Promise.withResolvers<{ type: RelayFrameType; payload: Uint8Array }>();
  const socket = { send: async (frame: { type: RelayFrameType; payload: Uint8Array }) => { rejected.resolve(frame); } } as unknown as RemoteRelaySocket;
  const approvals = new RemotePairingApprovals(() => undefined);
  try {
    await Effect.gen(function* () {
      const registry = yield* makeRemotePhoneRegistry(new RemoteRegistryClient({ apiUrl: "http://localhost:1", deviceToken: "fixture" }));
      const start = yield* makeRelaySessionStart({ macDeviceId: macId, macPrivateKey: macKey, origin: "http://127.0.0.1:1", approvals, registry,
        onViewing: () => {}, onSession: () => {}, observe: () => {} });
      const work = start(socket)({ type: RelayFrameType.OPEN, mode: RelayOpenMode.SESSION, sessionId, peerId: phoneId, payload: new Uint8Array() }, new AbortController().signal);
      const finished = work.finished.catch(() => undefined);
      const frame = yield* Effect.promise(() => rejected.promise);
      expect(frame.type).toBe(RelayFrameType.ERROR);
      expect(Buffer.from(frame.payload).toString()).toBe("not-paired");
      yield* Effect.promise(() => finished);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
  } finally { approvals.close(); macKey.fill(0); }
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
        onSession: () => undefined,
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




