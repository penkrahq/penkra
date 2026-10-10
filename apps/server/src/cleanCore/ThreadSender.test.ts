import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId, TurnId } from "@penkra/contracts";
import { Effect, Option } from "effect";
import { makeThreadSender } from "./ThreadSender.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { createThread, makeThreadPublisher, setThreadState } from "./threadStore.ts";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ThreadProviderBindingRepository } from "../persistence/Services/ThreadProviderBindings.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
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
    const coordinator: typeof ProviderThreadSwitchCoordinator.Service = {
      dispatchTurnStart: ({ command }) =>
        Effect.sync(() => {
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
    const result = yield* sender.send({
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
    });
    assert.equal(result.delivery, "started");
    if (result.delivery === "started")
      assert.equal(result.turnId, TurnId.makeUnsafe("native-turn"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
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
      assert.isTrue((yield* sender.interrupt(threadId)).interruptRequested);
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
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
