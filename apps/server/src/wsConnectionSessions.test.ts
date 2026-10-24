import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { WS_METHODS } from "@penkra/contracts";
import { Headers } from "effect/http";
import type { RpcMiddleware } from "effect/rpc";
import { describe, expect, it } from "vitest";

import {
  CurrentManagedAttachmentPrincipal,
  LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
} from "./managedAttachmentPrincipal.ts";
import {
  CurrentWsSessionRole,
  makeWsConnectionSessions,
  makeWsConnectionSessionMiddleware,
  WsConnectionSessions,
  WS_CONNECTION_SESSION_HEADER,
  provideWsConnectionSession,
  type WsConnectionSession,
} from "./wsConnectionSessions.ts";

const OWNER_SESSION: WsConnectionSession = {
  role: "owner",
  attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
};

describe("WsConnectionSessions", () => {
  it("runs five concurrent expensive reads for one client while preserving its authenticated identity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* makeWsConnectionSessions;
        const key = yield* sessions.register(OWNER_SESSION);
        const middleware = yield* makeWsConnectionSessionMiddleware.pipe(
          Effect.provideService(WsConnectionSessions, sessions),
        );
        const ready = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const methods = [
          WS_METHODS.cleanCoreGetBootstrap,
          WS_METHODS.cleanCoreListThreadItemsPage,
          WS_METHODS.providerGetCatalog,
          WS_METHODS.providerReloadCatalog,
          WS_METHODS.filesystemBrowse,
        ];
        let started = 0;
        const reads = methods.map((method) =>
          middleware(
            Effect.gen(function* () {
              expect(yield* CurrentWsSessionRole).toBe("owner");
              expect(yield* CurrentManagedAttachmentPrincipal).toEqual(
                OWNER_SESSION.attachmentPrincipal,
              );
              if (++started === methods.length) yield* Deferred.succeed(ready, undefined);
              yield* Deferred.await(release);
              return method as unknown as RpcMiddleware.SuccessValue;
            }),
            {
              clientId: 1,
              headers: Headers.fromInput({ [WS_CONNECTION_SESSION_HEADER]: key }),
              rpc: { _tag: method },
            } as unknown as Parameters<typeof middleware>[1],
          ),
        );
        const fiber = yield* Effect.all(reads, { concurrency: "unbounded" }).pipe(Effect.forkChild);
        yield* Deferred.await(ready);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(fiber)).toEqual(methods);
      }).pipe(Effect.scoped),
    );
  });
  it("registers sessions for the connection scope and forgets them on close", async () => {
    const sessions = await Effect.runPromise(makeWsConnectionSessions);
    const scope = await Effect.runPromise(Scope.make());
    const key = await Effect.runPromise(Scope.provide(sessions.register(OWNER_SESSION), scope));

    expect(sessions.lookup(key)).toEqual(OWNER_SESSION);
    expect(sessions.lookup(undefined)).toBeUndefined();
    expect(sessions.lookup("unknown-key")).toBeUndefined();

    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(sessions.lookup(key)).toBeUndefined();
  });

  it("issues unguessable, unique keys per connection", async () => {
    const sessions = await Effect.runPromise(makeWsConnectionSessions);
    const scope = await Effect.runPromise(Scope.make());
    const first = await Effect.runPromise(Scope.provide(sessions.register(OWNER_SESSION), scope));
    const second = await Effect.runPromise(
      Scope.provide(
        sessions.register({
          role: "client",
          attachmentPrincipal: { ownerKind: "session", ownerId: "session-1" },
        }),
        scope,
      ),
    );

    expect(first).not.toEqual(second);
    expect(sessions.lookup(second)?.role).toBe("client");
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("provides role and attachment principal to the wrapped effect", async () => {
    const read = Effect.gen(function* () {
      return {
        role: yield* CurrentWsSessionRole,
        principal: yield* CurrentManagedAttachmentPrincipal,
      };
    });

    const withSession = await Effect.runPromise(
      provideWsConnectionSession(read, {
        role: "owner",
        attachmentPrincipal: { ownerKind: "session", ownerId: "session-9" },
      }),
    );
    expect(withSession).toEqual({
      role: "owner",
      principal: { ownerKind: "session", ownerId: "session-9" },
    });

    // Without a session the conservative defaults must apply.
    const withoutSession = await Effect.runPromise(provideWsConnectionSession(read, undefined));
    expect(withoutSession).toEqual({
      role: "client",
      principal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
    });
  });
});
