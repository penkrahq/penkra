import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeRemoteTrustStore, RemoteTrustStore, RemoteTrustStoreLive } from "./trustStore";
import { createNoiseIdentity, NoiseHandshake, noisePublicKey } from "./noise";
import { openPairedSession, remoteNoisePrologue } from "./pairedSession";

const testLayer = RemoteTrustStoreLive.pipe(
  Layer.provideMerge(SessionCredentialServiceLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "penkra-remote-trust-test-" })),
  Layer.provide(NodeServices.layer),
);
const phone = () => ({
  deviceId: "10000000-0000-4000-8000-000000000002",
  name: "Test iPhone",
  identityKey: noisePublicKey(createNoiseIdentity()),
});
describe("RemoteTrustStore", () => {
  it("persists Allow, survives store recreation, and replaces/revokes a previous pairing atomically", async () => {
    await Effect.gen(function* () {
      const store = yield* RemoteTrustStore;
      const sessions = yield* SessionCredentialService;
      const phonePrivateKey = createNoiseIdentity();
      const input = { ...phone(), identityKey: noisePublicKey(phonePrivateKey) };
      const first = yield* store.allow(input);
      expect((yield* store.get(input.deviceId))?.pendingBackend).toBe(1);
      const restarted = yield* makeRemoteTrustStore;
      expect((yield* restarted.get(input.deviceId))?.sessionId).toBe(first.sessionId);
      yield* store.markPaired(input.deviceId, first.sessionId);
      const saved = (yield* store.get(input.deviceId))!;
      expect(Buffer.from(saved.identityKey)).toEqual(Buffer.from(input.identityKey));
      const macDeviceId = "10000000-0000-4000-8000-000000000001";
      const macPrivateKey = createNoiseIdentity();
      const initiator = new NoiseHandshake({
        pattern: "KK",
        initiator: true,
        staticPrivateKey: phonePrivateKey,
        remoteStaticKey: noisePublicKey(macPrivateKey),
        prologue: remoteNoisePrologue(macDeviceId, input.deviceId),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connected = yield* openPairedSession({
            macDeviceId,
            macPrivateKey,
            phone: saved,
            openingMessage: initiator.writeMessage(new Uint8Array()),
          });
          initiator.readMessage(connected.reply);
          expect(connected.credential.token).toBe(first.token);
        }),
      );
      initiator.destroy();
      yield* store.connected(input.deviceId, first.sessionId);
      expect((yield* store.get(input.deviceId))?.lastConnectedAt).not.toBeNull();
      const replaced = yield* store.allow({
        ...input,
        identityKey: noisePublicKey(createNoiseIdentity()),
      });
      expect(replaced.sessionId).not.toBe(first.sessionId);
      expect((yield* Effect.flip(sessions.verify(first.token))).message).toContain("revoked");
      expect(yield* store.remove(input.deviceId, first.sessionId)).toBe(false);
      expect((yield* sessions.verify(replaced.token)).sessionId).toBe(replaced.sessionId);
      yield* store.markPaired(input.deviceId, first.sessionId);
      expect((yield* store.get(input.deviceId))?.pendingBackend).toBe(1);
      yield* store.markPaired(input.deviceId, replaced.sessionId);
      expect((yield* store.get(input.deviceId))?.pendingBackend).toBe(0);
      expect(yield* sessions.listActive()).toHaveLength(1);
      expect(yield* store.remove(input.deviceId)).toBe(true);
      expect(yield* store.remove(input.deviceId)).toBe(false);
      expect(yield* store.list()).toHaveLength(0);
      expect((yield* Effect.flip(sessions.verify(replaced.token))).message).toContain("revoked");
    }).pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
  });
  it("rolls back failed Allow and Remove without leaking credentials or interrupting a valid connection", async () => {
    await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* RemoteTrustStore;
      const sessions = yield* SessionCredentialService;
      const input = phone();
      yield* sql`CREATE TRIGGER fail_remote_allow BEFORE INSERT ON remote_devices BEGIN SELECT RAISE(ABORT, 'injected Allow failure'); END`;
      yield* Effect.flip(store.allow(input));
      expect(yield* store.list()).toHaveLength(0);
      expect(yield* sessions.listActive()).toHaveLength(0);
      yield* sql`DROP TRIGGER fail_remote_allow`;
      const issued = yield* store.allow(input);
      const started = yield* Deferred.make<void>(),
        closed = yield* Deferred.make<void>();
      const running = yield* Effect.forkChild(
        sessions.runAuthenticatedConnection(
          issued.sessionId,
          Effect.acquireUseRelease(
            Deferred.succeed(started, undefined),
            () => Effect.never,
            () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
          ),
        ),
      );
      yield* Deferred.await(started);
      yield* sql`CREATE TRIGGER fail_remote_replace AFTER UPDATE ON remote_devices BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END`;
      yield* Effect.flip(
        store.allow({ ...input, identityKey: noisePublicKey(createNoiseIdentity()) }),
      );
      expect((yield* store.get(input.deviceId))?.sessionId).toBe(issued.sessionId);
      expect((yield* sessions.verify(issued.token)).sessionId).toBe(issued.sessionId);
      expect(yield* Deferred.isDone(closed)).toBe(false);
      expect(yield* sessions.listActive()).toHaveLength(1);
      yield* sql`DROP TRIGGER fail_remote_replace`;
      yield* sql`CREATE TRIGGER fail_remote_remove BEFORE DELETE ON remote_devices BEGIN SELECT RAISE(ABORT, 'injected Remove failure'); END`;
      yield* Effect.flip(store.remove(input.deviceId));
      expect(yield* Deferred.isDone(closed)).toBe(false);
      expect((yield* sessions.verify(issued.token)).sessionId).toBe(issued.sessionId);
      expect(yield* store.get(input.deviceId)).not.toBeNull();
      yield* sql`DROP TRIGGER fail_remote_remove`;
      yield* store.remove(input.deviceId);
      yield* Deferred.await(closed);
      yield* Fiber.interrupt(running);
      expect(yield* store.list()).toHaveLength(0);
    }).pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
  });
});
