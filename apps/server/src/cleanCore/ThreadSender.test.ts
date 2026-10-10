import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments.ts";
import { CurrentManagedAttachmentPrincipal } from "../managedAttachmentPrincipal.ts";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ThreadId,
  TurnId,
  QueuedEditDraftNotEmptyError,
  QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR,
} from "@penkra/contracts";
import { Cause, Deferred, Effect, Option } from "effect";
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
      Effect.provide(ManagedAttachmentRepositoryLive),
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
        Effect.provide(ManagedAttachmentRepositoryLive),
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
        Effect.provide(ManagedAttachmentRepositoryLive),
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
          assert.isTrue(
            (yield* sender.editQueued({ ...input, updatedAt: "2026-10-09T00:00:04.000Z" })).removed,
          );
          const stored = yield* sql<{
            draft: string;
          }>`SELECT draft FROM threads WHERE id = 'thread-q'`;
          assert.deepStrictEqual(JSON.parse(stored[0]!.draft), {
            prompt: "head",
            attachments: [],
            files: [],
            assistantSelections: [],
          });
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

it.effect("claims queued attachments atomically and delivers them with their original owner", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* createThread({
      id: "thread-attachments",
      spaceId: "space",
      title: "Attachments",
      provider: "codex",
      model: "gpt-5.5",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: "2026-10-10T00:00:00.000Z",
    });
    const repository = yield* ManagedAttachmentRepository;
    const at = new Date().toISOString();
    yield* repository.reserve({
      attachmentId: "attachment",
      ownerThreadId: "thread-attachments",
      ownerKind: "session",
      ownerId: "uploader",
      kind: "image",
      originalName: "image.png",
      mimeType: "image/png",
      reservedBytes: 4,
      relativePath: "attachment.png",
      now: at,
    });
    yield* repository.finalizeStaged({
      attachmentId: "attachment",
      ownerThreadId: "thread-attachments",
      ownerKind: "session",
      ownerId: "uploader",
      sizeBytes: 4,
      sha256: "a".repeat(64),
      stagingExpiresAt: "9999-01-01T00:00:00.000Z",
      now: at,
    });
    yield* setThreadState("thread-attachments", "running", "first", null, at);
    yield* sql`UPDATE threads SET draft = '{"prompt":"draft to clear"}' WHERE id = 'thread-attachments'`;
    const publisher = makeThreadPublisher();
    const changes: string[] = [];
    publisher.subscribe("thread-attachments", (change) => changes.push(change.threadId));
    const coordinator: typeof ProviderThreadSwitchCoordinator.Service = {
      dispatchTurnStart: ({ command, attachmentPrincipal }) =>
        Effect.sync(() => {
          assert.deepStrictEqual(attachmentPrincipal, {
            ownerKind: "session",
            ownerId: "uploader",
          });
          publisher.publishProvider({
            type: "turn.started",
            threadId: command.threadId,
            turnId: "next",
            at: command.createdAt,
          });
          publisher.publishDispatch({
            type: "acknowledged",
            threadId: command.threadId,
            messageId: command.message.messageId,
            turnId: "next",
          });
          return { sequence: 1 };
        }),
      dispatchQueuedTurn: () => Effect.die("no legacy queue"),
      recoverOpen: Effect.void,
    };
    const sender = yield* makeThreadSender.pipe(
      Effect.provideService(ThreadPublisher, publisher),
      Effect.provideService(ProviderThreadSwitchCoordinator, coordinator),
      Effect.provideService(ThreadProviderBindingRepository, {
        getRuntimeBinding: () => Effect.succeed(Option.none()),
      } as unknown as typeof ThreadProviderBindingRepository.Service),
      Effect.provideService(ProviderService, {
        interruptTurn: () => Effect.void,
      } as unknown as typeof ProviderService.Service),
    );
    const request: ThreadSendInput = {
      threadId: ThreadId.makeUnsafe("thread-attachments"),
      dispatchMode: "queue",
      message: {
        messageId: MessageId.makeUnsafe("image-message"),
        text: "image",
        attachments: [
          {
            type: "image",
            id: "attachment",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
        ],
        senderThreadId: null,
        dispatchOrigin: "user",
        queuedAt: at,
      },
    };
    const wrongOwner = yield* sender.send(request);
    assert.equal(wrongOwner.delivery, "failed");
    assert.deepStrictEqual(yield* readThreadQueue(request.threadId), []);
    assert.equal(changes.length, 0);
    assert.equal(
      (yield* sql<{
        draft: string | null;
      }>`SELECT draft FROM threads WHERE id = ${request.threadId}`)[0]!.draft,
      '{"prompt":"draft to clear"}',
    );
    const queued = yield* sender.send(request).pipe(
      Effect.provideService(CurrentManagedAttachmentPrincipal, {
        ownerKind: "session",
        ownerId: "uploader",
      } as const),
    );
    assert.equal(queued.delivery, "queued");
    assert.equal(changes.length, 1);
    assert.equal(
      (yield* sql<{
        draft: string | null;
      }>`SELECT draft FROM threads WHERE id = ${request.threadId}`)[0]!.draft,
      null,
    );
    const blob = yield* repository.findClaimedById({ attachmentId: "attachment" });
    assert.isTrue(Option.isSome(blob));
    yield* setThreadState(request.threadId, "idle", null, null, new Date().toISOString());
    const started = yield* sender.send(request).pipe(
      Effect.provideService(CurrentManagedAttachmentPrincipal, {
        ownerKind: "session",
        ownerId: "another-window",
      } as const),
    );
    assert.equal(started.delivery, "started");
    assert.deepStrictEqual(yield* readThreadQueue(request.threadId), []);
  }).pipe(
    Effect.scoped,
    Effect.provide(ManagedAttachmentRepositoryLive),
    Effect.provide(NodeSqliteClient.layerMemory()),
  ),
);

it.effect(
  "moves the stored queued message into the draft atomically, publishes once, and repeats as a no-op",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-edit");
      yield* createThread({
        id: threadId,
        spaceId: "space",
        title: "Edit",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      yield* setThreadState(threadId, "running", "turn", null, "2026-10-10T00:00:01.000Z");
      const message = {
        messageId: MessageId.makeUnsafe("message-edit"),
        text: "text exactly once",
        attachments: [
          {
            type: "image" as const,
            id: "image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
          {
            type: "file" as const,
            id: "file",
            name: "file.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
          },
        ],
        senderThreadId: null,
        dispatchOrigin: "user" as const,
        queuedAt: "2026-10-10T00:00:02.000Z",
      };
      yield* enqueueMessage(threadId, message);
      yield* sql`UPDATE threads SET draft = '{"prompt":"","attachments":[],"files":[]}' WHERE id = ${threadId}`;
      const publisher = makeThreadPublisher();
      const changes: string[] = [];
      publisher.subscribe(threadId, (change) => changes.push(change.threadId));
      const sender = yield* makeThreadSender.pipe(
        Effect.provide(ManagedAttachmentRepositoryLive),
        Effect.provideService(ThreadPublisher, publisher),
        Effect.provideService(
          ProviderThreadSwitchCoordinator,
          {} as typeof ProviderThreadSwitchCoordinator.Service,
        ),
        Effect.provideService(
          ThreadProviderBindingRepository,
          {} as typeof ThreadProviderBindingRepository.Service,
        ),
        Effect.provideService(ProviderService, {} as typeof ProviderService.Service),
      );
      const input = {
        threadId,
        messageId: message.messageId,
        updatedAt: "2026-10-10T00:00:03.000Z",
      };
      yield* sql`CREATE TRIGGER reject_edit BEFORE UPDATE OF draft ON threads BEGIN SELECT RAISE(ABORT, 'edit rejected'); END`;
      assert.isTrue((yield* Effect.exit(sender.editQueued(input)))._tag === "Failure");
      assert.deepStrictEqual(yield* readThreadQueue(threadId), [message]);
      assert.equal(
        (yield* sql<{ draft: string }>`SELECT draft FROM threads WHERE id = ${threadId}`)[0]!.draft,
        '{"prompt":"","attachments":[],"files":[]}',
      );
      assert.deepStrictEqual(changes, []);
      yield* sql`DROP TRIGGER reject_edit`;
      assert.isTrue((yield* sender.editQueued(input)).removed);
      assert.deepStrictEqual(yield* readThreadQueue(threadId), []);
      const read = sql<{
        draft: string;
        draftUpdatedAt: string;
        updatedAt: string;
      }>`SELECT draft, draft_updated_at AS "draftUpdatedAt", updated_at AS "updatedAt" FROM threads WHERE id = ${threadId}`;
      const stored = (yield* read)[0]!;
      assert.deepStrictEqual(JSON.parse(stored.draft), {
        prompt: message.text,
        attachments: [{ id: "image", name: "image.png", mimeType: "image/png" }],
        files: [{ id: "file", name: "file.txt", mimeType: "text/plain" }],
        assistantSelections: [],
      });
      assert.equal(stored.draftUpdatedAt, input.updatedAt);
      assert.equal(stored.updatedAt, input.updatedAt);
      assert.deepStrictEqual(changes, [threadId]);
      assert.isFalse(
        (yield* sender.editQueued({ ...input, updatedAt: "2026-10-10T00:00:04.000Z" })).removed,
      );
      assert.deepStrictEqual((yield* read)[0], stored);
      assert.deepStrictEqual(changes, [threadId]);
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM thread_items WHERE thread_id = ${threadId}`)[0]!.count,
        0,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

for (const content of [
  { name: "text", prompt: "unsent text", attachments: [], files: [] },
  {
    name: "image",
    prompt: "",
    attachments: [{ id: "image", name: "image.png", mimeType: "image/png" }],
    files: [],
  },
  {
    name: "file",
    prompt: "",
    attachments: [],
    files: [{ id: "file", name: "file.txt", mimeType: "text/plain" }],
  },
]) {
  it.effect(
    `refuses queued Edit with a draft containing ${content.name}, without a write or broadcast`,
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("edit-nonempty");
        yield* createThread({
          id: threadId,
          spaceId: "space",
          title: "Edit",
          provider: "codex",
          model: "gpt-5.5",
          runtimeMode: "full-access",
          createdBy: "user",
          createdAt: "2026-10-10T00:00:00.000Z",
        });
        yield* setThreadState(threadId, "running", "turn", null, "2026-10-10T00:00:01.000Z");
        yield* enqueueMessage(threadId, {
          messageId: MessageId.makeUnsafe("queued"),
          text: "queued text",
          attachments: [],
          senderThreadId: null,
          dispatchOrigin: "user",
          queuedAt: "2026-10-10T00:00:02.000Z",
        });
        const draft = JSON.stringify({
          prompt: content.prompt,
          attachments: content.attachments,
          files: content.files,
        });
        yield* sql`UPDATE threads SET draft = ${draft}, draft_updated_at = '2026-10-10T00:00:03.000Z' WHERE id = ${threadId}`;
        const read = sql`SELECT queue, draft, draft_updated_at, updated_at FROM threads WHERE id = ${threadId}`;
        const before = yield* read;
        const publisher = makeThreadPublisher();
        const changes: string[] = [];
        publisher.subscribe(threadId, (change) => changes.push(change.threadId));
        const sender = yield* makeThreadSender.pipe(
          Effect.provide(ManagedAttachmentRepositoryLive),
          Effect.provideService(ThreadPublisher, publisher),
          Effect.provideService(
            ProviderThreadSwitchCoordinator,
            {} as typeof ProviderThreadSwitchCoordinator.Service,
          ),
          Effect.provideService(
            ThreadProviderBindingRepository,
            {} as typeof ThreadProviderBindingRepository.Service,
          ),
          Effect.provideService(ProviderService, {} as typeof ProviderService.Service),
        );
        const result = yield* Effect.exit(
          sender.editQueued({
            threadId,
            messageId: "queued",
            updatedAt: "2026-10-10T00:00:04.000Z",
          }),
        );
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          const error = Option.getOrThrow(Cause.findErrorOption(result.cause));
          assert.instanceOf(error, QueuedEditDraftNotEmptyError);
          assert.equal(
            (error as QueuedEditDraftNotEmptyError)._tag,
            "QueuedEditDraftNotEmptyError",
          );
          assert.equal(error.message, QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR);
        }
        assert.deepStrictEqual(yield* read, before);
        assert.deepStrictEqual(changes, []);
      }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
  );
}
