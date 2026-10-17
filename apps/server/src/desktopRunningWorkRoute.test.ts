import http from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { ServerConfig, type ServerConfigShape } from "./config";
import * as NodeSqliteClient from "./persistence/NodeSqliteClient.ts";
import { runMigrations } from "./persistence/Migrations.ts";
import { seedThreadFolderFixture } from "./cleanCore/threadFixtures.ts";
import { ThreadPublisher } from "./cleanCore/ThreadPublisher.ts";
import {
  answerQuestion,
  createThread,
  makeThreadPublisher,
  setThreadState,
  setThreadDeleted,
  upsertThreadItem,
} from "./cleanCore/threadStore.ts";
import { desktopRunningWorkRouteLayer, makeRunningWorkStream } from "./desktopRunningWorkRoute.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const at = "2026-10-17T00:00:00.000Z";
const seed = Effect.gen(function* () {
  yield* runMigrations();
  yield* seedThreadFolderFixture("work-folder", "work-space");
  for (const id of ["a", "b"])
    yield* createThread({
      id,
      spaceId: "work-space",
      folderId: "work-folder",
      title: id,
      provider: "codex",
      model: "model",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: at,
    });
});

it.effect("emits different working identities even when the count is unchanged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      const publisher = makeThreadPublisher();
      yield* Effect.addFinalizer(() => publisher.close);
      const initial = yield* Deferred.make<void>();
      const active = yield* Deferred.make<void>();
      const states: string[][] = [];
      const stream = yield* makeRunningWorkStream(publisher);
      const fiber = yield* stream.pipe(
        Stream.take(3),
        Stream.runForEach((state) => {
          states.push(state.working);
          return states.length === 1
            ? Deferred.succeed(initial, undefined)
            : Deferred.succeed(active, undefined);
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(initial);
      yield* setThreadState("a", "running", "turn-a", null, at);
      publisher.publish({ threadId: "a" });
      yield* Deferred.await(active);
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* setThreadState("a", "idle", null, null, at);
          yield* setThreadState("b", "running", "turn-b", null, at);
        }),
      );
      publisher.publish({ threadId: "a" });
      publisher.publish({ threadId: "b" });
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(states, [[], ["a"], ["b"]]);
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "streams initial truth without windows, ignores unchanged sets, and tracks questions/deletion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed;
        const publisher = makeThreadPublisher();
        yield* Effect.addFinalizer(() => publisher.close);
        const ready = yield* Effect.forEach([0, 1, 2, 3, 4], () => Deferred.make<void>());
        const states: string[][] = [];
        const stream = yield* makeRunningWorkStream(publisher);
        const fiber = yield* stream.pipe(
          Stream.take(5),
          Stream.runForEach((state) => {
            states.push(state.working);
            return Deferred.succeed(ready[states.length - 1]!, undefined);
          }),
          Effect.forkScoped,
        );
        yield* Deferred.await(ready[0]!);
        yield* setThreadState("a", "running", "turn-a", null, at);
        publisher.publish({ threadId: "a" });
        yield* Deferred.await(ready[1]!);
        // A transcript invalidation alone cannot become an extra state line.
        publisher.publish({ threadId: "a" });
        yield* upsertThreadItem({
          threadId: "a",
          sourceId: "question",
          kind: "question",
          status: "open",
          text: "Which?",
          createdAt: at,
          updatedAt: at,
        });
        publisher.publish({ threadId: "a" });
        yield* Deferred.await(ready[2]!);
        yield* setThreadState("b", "running", "turn-b", null, at);
        publisher.publish({ threadId: "b" });
        yield* Deferred.await(ready[3]!);
        yield* setThreadDeleted("b", at, at);
        publisher.publish({ threadId: "b" });
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(states, [[], ["a"], [], ["b"], []]);
        yield* answerQuestion("a", "question", "{}", at);
        const reconnect = yield* makeRunningWorkStream(publisher);
        assert.deepStrictEqual(yield* reconnect.pipe(Stream.take(1), Stream.runCollect), [
          { working: ["a"] },
        ]);
      }),
    ).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("authenticates the desktop-only NDJSON endpoint and sends its initial set", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      yield* setThreadState("a", "running", "turn-a", null, at);
      let nodeServer!: http.Server;
      const server = yield* NodeHttpServer.make(() => (nodeServer = http.createServer()), {
        port: 0,
        host: "127.0.0.1",
      });
      yield* server.serve(yield* HttpRouter.toHttpEffect(desktopRunningWorkRouteLayer));
      const address = nodeServer.address();
      if (!address || typeof address !== "object") throw new Error("No test address");
      yield* Effect.tryPromise(async () => {
        const url = `http://127.0.0.1:${address.port}/api/desktop/running-work`;
        assert.equal(
          (await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status,
          401,
        );
        const abort = new AbortController();
        try {
          const response = await fetch(url, {
            headers: { Authorization: "Bearer private" },
            signal: abort.signal,
          });
          assert.equal(response.status, 200);
          assert.include(response.headers.get("content-type")!, "application/x-ndjson");
          const reader = response.body!.getReader();
          try {
            const first = await reader.read();
            assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(first.value)), {
              working: ["a"],
            });
          } finally {
            await reader.cancel();
          }
        } finally {
          abort.abort();
        }
      });
    }),
  ).pipe(
    Effect.provideService(ServerConfig, {
      mode: "desktop",
      host: "127.0.0.1",
      publicUrl: undefined,
      desktopShutdownToken: "private",
    } as ServerConfigShape),
    Effect.provideService(ThreadPublisher, makeThreadPublisher()),
    Effect.provide(NodeSqliteClient.layerMemory()),
    Effect.provide(NodeServices.layer),
  ),
);
