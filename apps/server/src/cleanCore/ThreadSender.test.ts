import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId, TurnId } from "@penkra/contracts";
import { Deferred, Effect, Option } from "effect";
import { makeThreadSender, type ThreadSendInput } from "./ThreadSender.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { createThread, makeThreadPublisher, setThreadState } from "./threadStore.ts";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ThreadProviderBindingRepository } from "../persistence/Services/ThreadProviderBindings.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { applyProviderEvent } from "./providerStreamConsumer.ts";
import { enqueueMessage, readThreadQueue } from "./threadQueue.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

it.effect("uses the exact current binding revision and waits for native confirmation", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* createThread({
      id: "thread-1",
      spaceId: "space-1",
      title: "Hello",
      provider: "codex",
      model: "gpt-5.5",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: "2026-10-09T00:00:00.000Z",
    });
    const publisher = makeThreadPublisher();
    let dispatchCount = 0;
    const coordinator: typeof ProviderThreadSwitchCoordinator.Service = {
      dispatchTurnStart: ({ command }) =>
        Effect.sync(() => {
          dispatchCount += 1;
          assert.equal(command.bindingRevision, 12);
          assert.isTrue(command.commandId.length > 0);
          publisher.publishProvider({
            type: "turn.started",
            threadId: command.threadId,
            turnId: "native-turn",
            at: command.createdAt,
          });
          publisher.publishDispatch({
            type: "acknowledged",
            threadId: command.threadId,
            messageId: command.message.messageId,
            turnId: "native-turn",
          });
          return { sequence: 1 };
        }),
      dispatchQueuedTurn: () => Effect.die("no old queue"),
      recoverOpen: Effect.void,
    };
    const sender = yield* makeThreadSender.pipe(
      Effect.provideService(ThreadPublisher, publisher),
      Effect.provideService(ProviderThreadSwitchCoordinator, coordinator),
      Effect.provideService(ThreadProviderBindingRepository, {
        getRuntimeBinding: () => Effect.succeed(Option.some({ revision: 12 })),
      } as unknown as typeof ThreadProviderBindingRepository.Service),
      Effect.provideService(ProviderService, {
        interruptTurn: () => Effect.void,
      } as unknown as typeof ProviderService.Service),
    );
    const request = {
      threadId: ThreadId.makeUnsafe("thread-1"),
      message: {
        messageId: MessageId.makeUnsafe("m1"),
        text: "hello",
        attachments: [],
        senderThreadId: null,
        dispatchOrigin: "user",
        queuedAt: "2026-10-09T00:00:01.000Z",
      },
      dispatchMode: "queue",
    } satisfies ThreadSendInput;
    const result = yield* sender.send(request);
    assert.deepStrictEqual(yield* sender.send(request), result);
    assert.equal(dispatchCount, 1);
    assert.equal(result.delivery, "started");
    if (result.delivery === "started")
      assert.equal(result.turnId, TurnId.makeUnsafe("native-turn"));
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "message cancellation only removes queued entries; thread interruption waits for provider state",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* createThread({
        id: "thread-1",
        spaceId: "space-1",
        title: "Hello",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-09T00:00:00.000Z",
      });
      for (const id of ["first", "middle", "last"])
        yield* enqueueMessage("thread-1", {
          messageId: MessageId.makeUnsafe(id),
          text: id,
          attachments: [],
          senderThreadId: null,
          dispatchOrigin: "user",
          queuedAt: "2026-10-09T00:00:01.000Z",
        });
      yield* setThreadState(
        "thread-1",
        "running",
        "started-message",
        null,
        "2026-10-09T00:00:02.000Z",
      );
      const publisher = makeThreadPublisher();
      const changes: string[] = [];
      publisher.subscribe("thread-1", (change) => changes.push(change.threadId));
      const interrupts: unknown[] = [];
      const sender = yield* makeThreadSender.pipe(
        Effect.provideService(ThreadPublisher, publisher),
        Effect.provideService(
          ProviderThreadSwitchCoordinator,
          {} as typeof ProviderThreadSwitchCoordinator.Service,
        ),
        Effect.provideService(
          ThreadProviderBindingRepository,
          {} as typeof ThreadProviderBindingRepository.Service,
        ),
        Effect.provideService(ProviderService, {
          interruptTurn: (input: unknown) =>
            Effect.sync(() => {
              interrupts.push(input);
            }),
        } as unknown as typeof ProviderService.Service),
      );
      const threadId = ThreadId.makeUnsafe("thread-1");
      assert.equal(yield* sender.queuedThread("middle"), threadId);
      assert.isTrue((yield* sender.cancelQueued({ threadId, messageId: "middle" })).removed);
      assert.deepStrictEqual(
        (yield* readThreadQueue(threadId)).map((message) => message.messageId),
        ["first", "last"],
      );
      assert.isNull(yield* sender.queuedThread("middle"));
      assert.isFalse((yield* sender.cancelQueued({ threadId, messageId: "middle" })).removed);
      assert.isFalse(
        (yield* sender.cancelQueued({ threadId, messageId: "started-message" })).removed,
      );
      assert.deepStrictEqual(changes, [threadId]);
      assert.deepStrictEqual(interrupts, []);
      const stopped = yield* sender.interrupt(threadId);
      assert.isTrue(stopped.interruptRequested);
      assert.equal(stopped.interruptedTurnId, TurnId.makeUnsafe("started-message"));
      assert.equal((yield* sender.getRuntime(threadId)).state, "running");
      assert.deepStrictEqual(interrupts, [{ threadId }]);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        state: string;
        active_turn_id: string;
      }>`SELECT state, active_turn_id FROM threads WHERE id = ${threadId}`;
      assert.equal(rows[0]?.state, "running");
      assert.equal(rows[0]?.active_turn_id, "started-message");
      yield* setThreadState(threadId, "idle", null, null, "2026-10-09T00:00:03.000Z");
      assert.isFalse((yield* sender.interrupt(threadId)).interruptRequested);
      assert.deepStrictEqual(interrupts, [{ threadId }]);
      yield* enqueueMessage(threadId, {
        messageId: MessageId.makeUnsafe("queued-after-service-start"),
        text: "fresh row",
        attachments: [],
        senderThreadId: null,
        dispatchOrigin: "user",
        queuedAt: "2026-10-09T00:00:04.000Z",
      });
      assert.equal(yield* sender.queuedThread("queued-after-service-start"), threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

for (const release of ["next-send", "remove-head", "edit-head"] as const) {
  it.effect(`a failed queue head stays blocked until ${release}`, () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* createThread({
        id: "thread-q",
        spaceId: "space-1",
        title: "Queue",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-09T00:00:00.000Z",
      });
      const message = (id: string) => ({
        messageId: MessageId.makeUnsafe(id),
        text: id,
        attachments: [],
        senderThreadId: null,
        dispatchOrigin: "user" as const,
        queuedAt: "2026-10-09T00:00:01.000Z",
      });
      for (const id of ["head", "second"]) yield* enqueueMessage("thread-q", message(id));
      yield* setThreadState("thread-q", "running", "old-turn", null, "2026-10-09T00:00:02.000Z");
      const publisher = makeThreadPublisher();
      const failed = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      let reject = true;
      let rejected = false;
      let startChanges: number | null = null;
      const attempts: string[] = [];
      publisher.subscribe("thread-q", () => {
        if (rejected) Effect.runSync(Deferred.succeed(failed, undefined));
        if (startChanges !== null && ++startChanges === 3)
          Effect.runSync(Deferred.succeed(delivered, undefined));
      });
      const coordinator = {
        dispatchTurnStart: ({
          command,
        }: Parameters<(typeof ProviderThreadSwitchCoordinator.Service)["dispatchTurnStart"]>[0]) =>
          Effect.gen(function* () {
            attempts.push(command.message.messageId);
            if (reject) {
              rejected = true;
              return yield* Effect.fail(new Error("provider launch rejected, unchanged"));
            }
            startChanges = 0;
            yield* applyProviderEvent(publisher, {
              type: "turn.started",
              threadId: command.threadId,
              turnId: "new-native",
              at: command.createdAt,
            });
            publisher.publishDispatch({
              type: "acknowledged",
              threadId: command.threadId,
              messageId: command.message.messageId,
              turnId: "new-native",
            });
            return { sequence: 1 };
          }),
      } as typeof ProviderThreadSwitchCoordinator.Service;
      const sender = yield* makeThreadSender.pipe(
        Effect.provideService(ThreadPublisher, publisher),
        Effect.provideService(ProviderThreadSwitchCoordinator, coordinator),
        Effect.provideService(ThreadProviderBindingRepository, {
          getRuntimeBinding: () => Effect.succeed(Option.none()),
        } as unknown as typeof ThreadProviderBindingRepository.Service),
        Effect.provideService(ProviderService, {} as typeof ProviderService.Service),
      );
      yield* applyProviderEvent(
        publisher,
        release === "edit-head"
          ? { type: "provider.exited", threadIds: ["thread-q"], at: "2026-10-09T00:00:03.000Z" }
          : {
              type: "turn.ended",
              threadId: "thread-q",
              turnId: "old-turn",
              state: release === "remove-head" ? "error" : "completed",
              error: "old turn error",
              at: "2026-10-09T00:00:03.000Z",
            },
      );
      yield* Deferred.await(failed);
      const sql = yield* SqlClient.SqlClient;
      const state = yield* sql<{
        state: string;
        last_error: string;
      }>`SELECT state, last_error FROM threads WHERE id = 'thread-q'`;
      assert.equal(state[0]?.state, "error");
      assert.equal(state[0]?.last_error, "provider launch rejected, unchanged");
      assert.deepStrictEqual(
        (yield* readThreadQueue("thread-q")).map((m) => m.messageId),
        ["head", "second"],
      );
      assert.equal(
        (yield* sql`SELECT source_id FROM thread_items WHERE thread_id = 'thread-q' AND kind = 'user' LIMIT 50`)
          .length,
        0,
      );
      assert.deepStrictEqual(attempts, ["head"]);
      const blockedResult = yield* sender.send({
        threadId: ThreadId.makeUnsafe("thread-q"),
        message: message("third"),
        dispatchMode: "queue",
      });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(blockedResult)), {
        threadId: "thread-q",
        messageId: "third",
        delivery: "queued",
        position: 3,
        queueLength: 3,
        runningTurnId: null,
      });
      assert.deepStrictEqual(attempts, ["head", "head"]);
      reject = false;
      if (release === "next-send") {
        const result = yield* sender.send({
          threadId: ThreadId.makeUnsafe("thread-q"),
          message: message("fourth"),
          dispatchMode: "steer",
        });
        assert.equal(result.delivery, "queued");
        assert.deepStrictEqual(attempts, ["head", "head", "head"]);
        assert.deepStrictEqual(
          (yield* readThreadQueue("thread-q")).map((m) => m.messageId),
          ["second", "third", "fourth"],
        );
      } else {
        const input = { threadId: ThreadId.makeUnsafe("thread-q"), messageId: "head" };
        if (release === "edit-head") {
          const draft = JSON.stringify({ prompt: "head", attachments: [] });
          assert.isTrue(
            (yield* sender.editQueued({ ...input, draft, updatedAt: "2026-10-09T00:00:04.000Z" }))
              .removed,
          );
          const stored = yield* sql<{
            draft: string;
          }>`SELECT draft FROM threads WHERE id = 'thread-q'`;
          assert.equal(stored[0]?.draft, draft);
        } else assert.isTrue((yield* sender.cancelQueued(input)).removed);
        yield* Deferred.await(delivered);
        assert.deepStrictEqual(attempts, ["head", "head", "second"]);
        assert.deepStrictEqual(
          (yield* readThreadQueue("thread-q")).map((m) => m.messageId),
          ["third"],
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
  );
}
