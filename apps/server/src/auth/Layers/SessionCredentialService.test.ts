import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@penkra/contracts";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { AuthSessionRepositoryLive } from "../../persistence/Layers/AuthSessions";
import { ServerSecretStoreLive } from "./ServerSecretStore";
import {
  SessionCapacityError,
  SessionCredentialService,
  type SessionCredentialError,
} from "../Services/SessionCredentialService";
import {
  MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION,
  MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION,
  SessionCredentialServiceLive,
  makeSessionCredentialService,
} from "./SessionCredentialService";

const testLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "penkra-auth-session-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const runSessionTest = <A, E>(effect: Effect.Effect<A, E, SessionCredentialService>) =>
  effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);

const makeBlockingConnection = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const effect = Effect.acquireUseRelease(
    Deferred.succeed(started, undefined),
    () => Effect.never,
    () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
  );
  return { started, closed, effect } as const;
});

describe("SessionCredentialServiceLive", () => {
  it("leaves a client unusable when renewal races explicit revocation", async () => {
    await Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: "phone-a",
        role: "client",
        method: "bearer-session-token",
      });
      yield* TestClock.adjust(Duration.days(30));
      const [renewed] = yield* Effect.all(
        [
          Effect.exit(sessions.resumeClient({ sessionId: issued.sessionId, subject: "phone-a" })),
          sessions.revoke(issued.sessionId),
        ],
        { concurrency: "unbounded" },
      );
      if (Exit.isSuccess(renewed)) {
        expect((yield* Effect.flip(sessions.verify(renewed.value.token))).message).toContain(
          "revoked",
        );
      }
      expect(yield* sessions.listActive()).toHaveLength(0);
      expect(
        (yield* Effect.flip(
          sessions.resumeClient({ sessionId: issued.sessionId, subject: "phone-a" }),
        )).message,
      ).toContain("revoked");
    }).pipe(
      Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      Effect.scoped,
      Effect.runPromise,
    );
  });

  it("never resumes revoked clients, another phone, or an owner credential", async () => {
    await Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const client = yield* sessions.issue({
        subject: "phone-a",
        role: "client",
        method: "bearer-session-token",
      });
      const owner = yield* sessions.issue({
        subject: "phone-a",
        role: "owner",
        method: "bearer-session-token",
      });
      const browser = yield* sessions.issue({ subject: "phone-a" });
      expect(
        (yield* Effect.flip(
          sessions.resumeClient({ sessionId: browser.sessionId, subject: "phone-a" }),
        )).message,
      ).toContain("not eligible");
      expect(
        (yield* Effect.flip(
          sessions.resumeClient({
            sessionId: AuthSessionId.make("10000000-0000-4000-8000-000000000099"),
            subject: "phone-a",
          }),
        )).message,
      ).toContain("Unknown client session");
      expect(
        (yield* Effect.flip(
          sessions.resumeClient({ sessionId: client.sessionId, subject: "phone-b" }),
        )).message,
      ).toContain("not eligible");
      expect(
        (yield* Effect.flip(
          sessions.resumeClient({ sessionId: owner.sessionId, subject: "phone-a" }),
        )).message,
      ).toContain("not eligible");
      yield* sessions.revoke(client.sessionId);
      yield* TestClock.adjust(Duration.days(30));
      expect(
        (yield* Effect.flip(
          sessions.resumeClient({ sessionId: client.sessionId, subject: "phone-a" }),
        )).message,
      ).toContain("revoked");
    }).pipe(
      Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      Effect.scoped,
      Effect.runPromise,
    );
  });

  it("rejects malformed session tokens", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const error = yield* Effect.flip(sessions.verify("not-a-session-token"));

        expect(error.message).toContain("Malformed session token");
      }),
    );
  });

  it("consumes websocket tickets exactly once under concurrent verification", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);
        const attempts = yield* Effect.forEach(
          Array.from({ length: 12 }),
          () => sessions.verifyWebSocketToken(websocket.token).pipe(Effect.exit),
          { concurrency: "unbounded" },
        );

        expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(1);
        expect(attempts.filter((attempt) => attempt._tag === "Failure")).toHaveLength(11);
      }),
    );
  });

  it("interrupts every connection for a revoked session without affecting other sessions", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const revokedSession = yield* sessions.issue({ subject: "revoked-client" });
        const survivingSession = yield* sessions.issue({ subject: "surviving-client" });
        const first = yield* makeBlockingConnection;
        const second = yield* makeBlockingConnection;
        const survivor = yield* makeBlockingConnection;

        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(revokedSession.sessionId, first.effect),
        );
        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(revokedSession.sessionId, second.effect),
        );
        const survivorFiber = yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(survivingSession.sessionId, survivor.effect),
        );
        yield* Deferred.await(first.started);
        yield* Deferred.await(second.started);
        yield* Deferred.await(survivor.started);

        expect(yield* sessions.revoke(revokedSession.sessionId)).toBe(true);
        expect(yield* Deferred.isDone(first.closed)).toBe(true);
        expect(yield* Deferred.isDone(second.closed)).toBe(true);
        yield* Deferred.await(first.closed);
        yield* Deferred.await(second.closed);

        expect(yield* Deferred.isDone(survivor.closed)).toBe(false);
        expect(
          (yield* sessions.listActive()).find(
            (item) => item.sessionId === survivingSession.sessionId,
          )?.connected,
        ).toBe(true);

        yield* Fiber.interrupt(survivorFiber);
      }),
    );
  });

  it("rejects connection registration after revocation", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        yield* sessions.revoke(issued.sessionId);

        const error = yield* Effect.flip(
          sessions.runAuthenticatedConnection(issued.sessionId, Effect.void),
        );

        expect(error).toBeInstanceOf(Error);
        expect((error as SessionCredentialError).message).toContain("revoked");
      }),
    );
  });

  it("interrupts revoked connections before revoke-all-except returns", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const currentSession = yield* sessions.issue({ subject: "current-client" });
        const firstRevokedSession = yield* sessions.issue({ subject: "first-revoked-client" });
        const secondRevokedSession = yield* sessions.issue({ subject: "second-revoked-client" });
        const current = yield* makeBlockingConnection;
        const firstRevoked = yield* makeBlockingConnection;
        const secondRevoked = yield* makeBlockingConnection;

        const currentFiber = yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(currentSession.sessionId, current.effect),
        );
        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(firstRevokedSession.sessionId, firstRevoked.effect),
        );
        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(secondRevokedSession.sessionId, secondRevoked.effect),
        );
        yield* Deferred.await(current.started);
        yield* Deferred.await(firstRevoked.started);
        yield* Deferred.await(secondRevoked.started);

        expect(yield* sessions.revokeAllExcept(currentSession.sessionId)).toBe(2);
        expect(yield* Deferred.isDone(firstRevoked.closed)).toBe(true);
        expect(yield* Deferred.isDone(secondRevoked.closed)).toBe(true);
        expect(yield* Deferred.isDone(current.closed)).toBe(false);

        yield* Fiber.interrupt(currentFiber);
      }),
    );
  });

  it("rejects websocket tokens once the parent session has expired", async () => {
    await Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({ ttl: Duration.seconds(1) });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error.message).toContain("Invalid websocket token");
    }).pipe(
      Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      Effect.scoped,
      Effect.runPromise,
    );
  });

  it("interrupts an established connection when its session expires", async () => {
    await Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({ ttl: Duration.seconds(1) });
      const connection = yield* makeBlockingConnection;

      yield* Effect.forkChild(
        sessions.runAuthenticatedConnection(issued.sessionId, connection.effect),
      );
      yield* Deferred.await(connection.started);
      yield* TestClock.adjust(Duration.seconds(2));
      yield* Deferred.await(connection.closed);

      expect(yield* sessions.listActive()).toHaveLength(0);
    }).pipe(
      Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      Effect.scoped,
      Effect.runPromise,
    );
  });
});
