import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect, it, onTestFinished } from "vitest";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { httpFixture } from "./httpFixture.test-support";
import { createNoiseIdentity, noisePublicKey } from "./noise";
import { makeRemotePhoneRegistry } from "./phoneRegistry";
import { RemoteRegistryClient } from "./registry";
import { RemoteTrustStore, RemoteTrustStoreLive } from "./trustStore";

const layer = RemoteTrustStoreLive.pipe(
  Layer.provideMerge(SessionCredentialServiceLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "penkra-phone-registry-test-" })),
  Layer.provide(NodeServices.layer),
);
const phone = (suffix = "2") => ({
  deviceId: `10000000-0000-4000-8000-00000000000${suffix}`,
  name: "Test iPhone",
  identityKey: noisePublicKey(createNoiseIdentity()),
});
const client = (apiUrl: string) =>
  new RemoteRegistryClient({ apiUrl, deviceToken: "fixture-token" });

describe("phone registry ownership with real HTTP and isolated SQLite", () => {
  it("Remove revokes a live local session without waiting for an earlier blocked POST", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    onTestFinished(() => {
      release.resolve();
      cancellation.abort();
    });
    const operations: string[] = [];
    await httpFixture(
      (request, response) => {
        if (request.method === "POST") {
          blocked.resolve();
          void release.promise.then(() => {
            operations.push("post");
            response.writeHead(204).end();
          });
        } else {
          operations.push("delete");
          response.writeHead(204).end();
        }
      },
      (origin) =>
        Effect.gen(function* () {
          const trust = yield* RemoteTrustStore;
          const sessions = yield* SessionCredentialService;
          const input = phone();
          const owner = yield* makeRemotePhoneRegistry(client(origin));
          const allowing = yield* Effect.forkChild(owner.allow(input));
          yield* Effect.promise(() => blocked.promise);
          const saved = (yield* trust.get(input.deviceId))!;
          const started = yield* Deferred.make<void>();
          const closed = yield* Deferred.make<void>();
          yield* Effect.forkChild(
            sessions.runAuthenticatedConnection(
              saved.sessionId,
              Effect.acquireUseRelease(
                Deferred.succeed(started, undefined),
                () => Effect.never,
                () => Deferred.succeed(closed, undefined),
              ),
            ),
          );
          yield* Deferred.await(started);
          const removing = yield* Effect.forkChild(owner.remove(input.deviceId));
          yield* Deferred.await(closed);
          expect(yield* trust.get(input.deviceId)).toBeNull();
          expect(operations).toEqual([]);
          release.resolve();
          yield* Fiber.join(allowing);
          yield* Fiber.join(removing);
          expect(operations).toEqual(["post", "delete"]);
        }).pipe(
          Effect.ensuring(Effect.sync(() => release.resolve())),
          Effect.provide(layer),
          Effect.scoped,
          (effect) => Effect.runPromise(effect, { signal: cancellation.signal }),
        ),
    );
  }, 10000);
  it("keeps failed Allow pending, retries on reconciliation, and revokes locally before failed Remove", async () => {
    let fail = true;
    const input = phone();
    let remote = false;
    await httpFixture(
      (request, response) => {
        if (request.method === "GET") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(remote ? [{ phoneDeviceId: input.deviceId }] : []));
        } else if (fail) {
          response.writeHead(503).end();
        } else {
          remote = request.method === "POST";
          response.writeHead(204).end();
        }
      },
      (origin) =>
        Effect.gen(function* () {
          const trust = yield* RemoteTrustStore;
          const sessions = yield* SessionCredentialService;
          const owner = yield* makeRemotePhoneRegistry(client(origin));
          const allowed = yield* owner.allow(input);
          expect(allowed.backendPaired).toBe(false);
          expect((yield* trust.get(input.deviceId))?.pendingBackend).toBe(1);
          fail = false;
          yield* owner.reconcile;
          expect(remote).toBe(true);
          expect((yield* trust.get(input.deviceId))?.pendingBackend).toBe(0);
          fail = true;
          expect(yield* owner.remove(input.deviceId)).toBe(false);
          expect(yield* trust.get(input.deviceId)).toBeNull();
          expect((yield* Effect.flip(sessions.verify(allowed.credential.token))).message).toContain(
            "revoked",
          );
          expect(remote).toBe(true);
          fail = false;
          // No in-memory failed-delete queue is needed across a restart.
          const restarted = yield* makeRemotePhoneRegistry(client(origin));
          yield* restarted.reconcile;
          expect(remote).toBe(false);
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise),
    );
  });

  it("removes a completed pairing missing from the backend rather than recreating it", async () => {
    let posts = 0;
    await httpFixture(
      (request, response) => {
        if (request.method === "POST") posts++;
        response.setHeader("content-type", "application/json");
        response.end("[]");
      },
      (origin) =>
        Effect.gen(function* () {
          const trust = yield* RemoteTrustStore;
          const sessions = yield* SessionCredentialService;
          const input = phone();
          const issued = yield* trust.allow(input);
          yield* trust.markPaired(input.deviceId, issued.sessionId);
          const owner = yield* makeRemotePhoneRegistry(client(origin));
          yield* owner.reconcile;
          expect(yield* trust.get(input.deviceId)).toBeNull();
          expect((yield* Effect.flip(sessions.verify(issued.token))).message).toContain("revoked");
          expect(posts).toBe(0);
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise),
    );
  });

  it("a stale backend read cannot revoke a newer completed Allow", async () => {
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await httpFixture(
      (request, response) => {
        if (request.method === "GET") {
          reading.resolve();
          void release.promise.then(() => response.end("[]"));
        } else response.writeHead(204).end();
      },
      (origin) =>
        Effect.gen(function* () {
          const trust = yield* RemoteTrustStore;
          const input = phone();
          const old = yield* trust.allow(input);
          yield* trust.markPaired(input.deviceId, old.sessionId);
          const owner = yield* makeRemotePhoneRegistry(client(origin));
          const reconciling = yield* Effect.forkChild(owner.reconcile);
          yield* Effect.promise(() => reading.promise);
          const newer = yield* owner.allow({
            ...input,
            identityKey: noisePublicKey(createNoiseIdentity()),
          });
          release.resolve();
          yield* Fiber.join(reconciling);
          const current = yield* trust.get(input.deviceId);
          expect(current?.sessionId).toBe(newer.credential.sessionId);
          expect(current?.pendingBackend).toBe(0);
        }).pipe(
          Effect.ensuring(Effect.sync(() => release.resolve())),
          Effect.provide(layer),
          Effect.scoped,
          Effect.runPromise,
        ),
    );
  });

  it("an old remote deletion finishes before a new Allow can post the same phone", async () => {
    const input = phone();
    const deleting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const operations: string[] = [];
    await httpFixture(
      (request, response) => {
        if (request.method === "GET")
          response.end(JSON.stringify([{ phoneDeviceId: input.deviceId }]));
        else if (request.method === "DELETE") {
          operations.push("delete-start");
          deleting.resolve();
          void release.promise.then(() => {
            operations.push("delete-end");
            response.writeHead(204).end();
          });
        } else {
          operations.push("post");
          response.writeHead(204).end();
        }
      },
      (origin) =>
        Effect.gen(function* () {
          const trust = yield* RemoteTrustStore;
          const owner = yield* makeRemotePhoneRegistry(client(origin));
          const reconciling = yield* Effect.forkChild(owner.reconcile);
          yield* Effect.promise(() => deleting.promise);
          const allowing = yield* Effect.forkChild(owner.allow(input));
          release.resolve();
          yield* Fiber.join(reconciling);
          expect((yield* Fiber.join(allowing)).backendPaired).toBe(true);
          expect(operations).toEqual(["delete-start", "delete-end", "post"]);
          expect((yield* trust.get(input.deviceId))?.pendingBackend).toBe(0);
        }).pipe(
          Effect.ensuring(Effect.sync(() => release.resolve())),
          Effect.provide(layer),
          Effect.scoped,
          Effect.runPromise,
        ),
    );
  });

  it("a blocked phone's registry write does not block another phone", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = phone("2"),
      second = phone("3");
    await httpFixture(
      (request, response) => {
        const parts: Buffer[] = [];
        request.on("data", (part: Buffer) => parts.push(part));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(parts).toString()) as { phoneDeviceId: string };
          if (body.phoneDeviceId === first.deviceId) {
            blocked.resolve();
            void release.promise.then(() => response.writeHead(204).end());
          } else response.writeHead(204).end();
        });
      },
      (origin) =>
        Effect.gen(function* () {
          const trust = yield* RemoteTrustStore;
          const owner = yield* makeRemotePhoneRegistry(client(origin));
          const waiting = yield* Effect.forkChild(owner.allow(first));
          yield* Effect.promise(() => blocked.promise);
          const other = yield* owner.allow(second);
          expect(other.backendPaired).toBe(true);
          expect((yield* trust.get(first.deviceId))?.pendingBackend).toBe(1);
          release.resolve();
          expect((yield* Fiber.join(waiting)).backendPaired).toBe(true);
        }).pipe(
          Effect.ensuring(Effect.sync(() => release.resolve())),
          Effect.provide(layer),
          Effect.scoped,
          Effect.runPromise,
        ),
    );
  });
});
