import * as NodeServices from "@effect/platform-node/NodeServices";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { createNoiseIdentity, NoiseHandshake, noisePublicKey, type NoiseTransport } from "./noise";
import { openPairedSession, remoteNoisePrologue } from "./pairedSession";

const macId = "10000000-0000-4000-8000-000000000001";
const phoneId = "10000000-0000-4000-8000-000000000002";
const testLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "penkra-paired-noise-test-" })),
  Layer.provide(NodeServices.layer),
);
function phoneHandshake(macKey: Uint8Array, phoneKey: Uint8Array, id = phoneId) {
  return new NoiseHandshake({
    pattern: "KK",
    initiator: true,
    staticPrivateKey: phoneKey,
    remoteStaticKey: noisePublicKey(macKey),
    prologue: remoteNoisePrologue(macId, id),
  });
}
describe("paired Noise authorization", () => {
  it("does not authorize or renew an approval still pending registry acknowledgement", async () => {
    await Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: phoneId,
        role: "client",
        method: "bearer-session-token",
      });
      yield* TestClock.adjust(Duration.days(30));
      const error = yield* Effect.flip(
        Effect.scoped(
          openPairedSession({
            macDeviceId: macId,
            macPrivateKey: createNoiseIdentity(),
            phone: {
              deviceId: phoneId,
              identityKey: noisePublicKey(createNoiseIdentity()),
              sessionId: issued.sessionId,
              pendingBackend: 1,
            },
            openingMessage: new Uint8Array(),
          }),
        ),
      );
      expect(error.message).toContain("not recorded");
      expect(yield* sessions.listActive()).toHaveLength(0);
    }).pipe(
      Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      Effect.scoped,
      Effect.runPromise,
    );
  });
  it("renews only after the paired key authenticates, and closes encryption with its session scope", async () => {
    const macKey = createNoiseIdentity(),
      phoneKey = createNoiseIdentity();
    const phone = phoneHandshake(macKey, phoneKey);
    let closedTransport: NoiseTransport | undefined;
    await Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: phoneId,
        role: "client",
        method: "bearer-session-token",
      });
      yield* TestClock.adjust(Duration.days(30));
      const connected = yield* openPairedSession({
        macDeviceId: macId,
        macPrivateKey: macKey,
        phone: {
          deviceId: phoneId,
          identityKey: noisePublicKey(phoneKey),
          sessionId: issued.sessionId,
          pendingBackend: 0,
        },
        openingMessage: phone.writeMessage(new Uint8Array()),
      });
      closedTransport = connected.transport;
      phone.readMessage(connected.reply);
      const bytes = Buffer.from("an encrypted RPC frame");
      expect(
        Buffer.from(connected.transport.receive.decrypt(phone.finish().send.encrypt(bytes))),
      ).toEqual(bytes);
      expect((yield* sessions.verify(connected.credential.token)).subject).toBe(phoneId);
      expect(connected.credential.sessionId).toBe(issued.sessionId);
      expect(connected.credential.token).not.toBe(issued.token);
    }).pipe(
      Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      Effect.scoped,
      Effect.runPromise,
    );
    expect(() => closedTransport!.send.encrypt(new Uint8Array())).toThrow("closed");
    phone.destroy();
  });
  it("refuses wrong keys and swapped device IDs before renewing, and refuses explicit revocation after valid proof", async () => {
    const macKey = createNoiseIdentity(),
      phoneKey = createNoiseIdentity();
    await Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: phoneId,
        role: "client",
        method: "bearer-session-token",
      });
      yield* TestClock.adjust(Duration.days(30));
      for (const attempt of [
        phoneHandshake(macKey, createNoiseIdentity()),
        phoneHandshake(macKey, phoneKey, macId),
      ]) {
        const error = yield* Effect.flip(
          Effect.scoped(
            openPairedSession({
              macDeviceId: macId,
              macPrivateKey: macKey,
              phone: {
                deviceId: phoneId,
                identityKey: noisePublicKey(phoneKey),
                sessionId: issued.sessionId,
                pendingBackend: 0,
              },
              openingMessage: attempt.writeMessage(new Uint8Array()),
            }),
          ),
        );
        expect(error.message).toContain("paired key");
        expect(yield* sessions.listActive()).toHaveLength(0);
        attempt.destroy();
      }
      yield* sessions.revoke(issued.sessionId);
      const valid = phoneHandshake(macKey, phoneKey);
      const error = yield* Effect.flip(
        Effect.scoped(
          openPairedSession({
            macDeviceId: macId,
            macPrivateKey: macKey,
            phone: {
              deviceId: phoneId,
              identityKey: noisePublicKey(phoneKey),
              sessionId: issued.sessionId,
              pendingBackend: 0,
            },
            openingMessage: valid.writeMessage(new Uint8Array()),
          }),
        ),
      );
      expect(error.message).toContain("revoked");
      expect(yield* sessions.listActive()).toHaveLength(0);
      valid.destroy();
    }).pipe(
      Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      Effect.scoped,
      Effect.runPromise,
    );
  });
});
