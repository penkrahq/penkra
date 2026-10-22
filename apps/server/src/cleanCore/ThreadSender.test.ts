import { ThreadLanesLive } from "./ThreadLanes.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { observePublisher } from "./threadPublisherTestHelpers.ts";
import { ensureDurableThreadWorkspace } from "../scratchWorkspaces.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { ServerConfig } from "../config.ts";
const senderStateDir = mkdtempSync(join(tmpdir(), "penkra-folder-sender-"));
afterAll(() => rmSync(senderStateDir, { recursive: true, force: true }));
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments.ts";
import { CurrentManagedAttachmentPrincipal } from "../managedAttachmentPrincipal.ts";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderConnectionId,
  ThreadId,
  TurnId,
  QueuedEditDraftNotEmptyError,
  QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR,
} from "@penkra/contracts";
import { Cause, Deferred, Effect, Exit, Option } from "effect";
import { settleMessage, sendMessage } from "./sendMessage";
import { makeThreadSender, type ThreadSendInput } from "./ThreadSender.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { createThread, makeThreadPublisher, setThreadState } from "./threadStore.ts";
import {
  ProviderThreadSwitchCoordinator,
  ProviderThreadSwitchCoordinatorError,
} from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { applyProviderEvent } from "./providerStreamConsumer.ts";
import { setThreadDraft } from "./threadDraft.ts";
import { enqueueMessage, readThreadQueue } from "./threadQueue.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const waitForSentMessage = (
  publisher: ReturnType<typeof makeThreadPublisher>,
  threadId: string,
  messageId: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const scope = yield* Effect.scope;
      const settled = yield* Deferred.make<void>();
      const check = Effect.gen(function* () {
        const [item] = yield* sql<{ status: string }>`SELECT status FROM thread_items
        WHERE thread_id=${threadId} AND source_id=${messageId}`;
        if (item?.status === "sent") yield* Deferred.succeed(settled, undefined);
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie);
      const stop = yield* observePublisher(publisher.threadChanges, () => {
        Effect.runSync(Effect.forkIn(check, scope));
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      yield* check;
      yield* Deferred.await(settled);
    }),
  );

it.effect("delivers a queued message on model B after the composer changes from model A", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_folders (folder_id, title, workspace_root, space_id, created_at, updated_at)
      VALUES ('sender-folder', 'Sender folder', NULL, 'space-1', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`;
    yield* createThread({
      folderId: "sender-folder",
      id: "thread-1",
      spaceId: "space-1",
      title: "Queue",
      provider: "codex",
      model: "model-A",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: "2026-10-09T00:00:00.000Z",
    });
    yield* sql`UPDATE threads SET connection_id='old-connection', native_state_id='old-native' WHERE id='thread-1'`;
    yield* setThreadState("thread-1", "running", "active-turn", null, "2026-10-09T00:00:01.000Z");
    const publisher = makeThreadPublisher();
    const drained = yield* Deferred.make<void>();
    const scope = yield* Effect.scope;
    yield* observePublisher(publisher.threadChanges, () => {
      Effect.runSync(
        Effect.forkIn(
          Effect.gen(function* () {
            if ((yield* readThreadQueue("thread-1")).length === 0)
              yield* Deferred.succeed(drained, undefined);
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          scope,
        ),
      );
    });
    const selections: string[] = [];
    const sender = yield* makeThreadSender.pipe(
      Effect.provide(ProviderSessionDirectoryLive),
      Effect.provide(ThreadLanesLive),
      Effect.provideService(ServerConfig, {
        stateDir: senderStateDir,
      } as typeof ServerConfig.Service),
      Effect.provide(ManagedAttachmentRepositoryLive),
      Effect.provideService(ThreadPublisher, publisher),
      Effect.provideService(ProviderThreadSwitchCoordinator, {
        dispatchTurnStart: ({ command }) =>
          Effect.gen(function* () {
            selections.push(command.modelSelection!.model);
            assert.equal(command.connectionId, "new-connection");
            yield* applyProviderEvent(publisher, {
              type: "turn.started",
              threadId: command.threadId,
              turnId: "next-turn",
              at: command.createdAt,
            });
            yield* settleMessage(
              publisher,
              {
                type: "acknowledged",
                threadId: command.threadId,
                messageId: command.message.messageId,
                turnId: "next-turn",
              },
              new Date().toISOString(),
            );
            return { turnId: TurnId.makeUnsafe("fixture-turn") };
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
      }),
      Effect.provideService(ProviderService, {} as typeof ProviderService.Service),
    );
    const result = yield* sender.send({
      threadId: ThreadId.makeUnsafe("thread-1"),
      dispatchMode: "queue",
      connectionId: ProviderConnectionId.makeUnsafe("new-connection"),
      message: {
        messageId: MessageId.makeUnsafe("queued-model"),
        text: "next",
        attachments: [],
        origin: { _tag: "user" as const },
        queuedAt: "2026-10-09T00:00:02.000Z",
      },
    });
    assert.equal(result.plan, "queue");
    assert.deepStrictEqual(
      yield* sql`SELECT connection_id, native_state_id FROM threads WHERE id='thread-1'`,
      [{ connection_id: "old-connection", native_state_id: "old-native" }],
    );
    assert.deepStrictEqual(Object.keys((yield* readThreadQueue("thread-1"))[0]!).sort(), [
      "attachments",
      "messageId",
      "origin",
      "queuedAt",
      "text",
    ]);
    yield* setThreadDraft(
      publisher,
      "thread-1",
      JSON.stringify({
        prompt: "",
        attachments: [],
        files: [],
        modelSelectionByProvider: { codex: { provider: "codex", model: "model-B" } },
        connectionSelectionByProvider: { codex: "new-connection" },
        activeProvider: "codex",
      }),
      "2099-10-09T00:00:02.500Z",
    );
    assert.deepStrictEqual(
      yield* sql`SELECT connection_id, native_state_id, model, active_turn_id FROM threads WHERE id='thread-1'`,
      [
        {
          connection_id: "old-connection",
          native_state_id: "old-native",
          model: "model-A",
          active_turn_id: "active-turn",
        },
      ],
    );
    yield* applyProviderEvent(publisher, {
      type: "turn.ended",
      threadId: "thread-1",
      turnId: "active-turn",
      state: "completed",
      error: null,
      at: "2026-10-09T00:00:03.000Z",
    });
    yield* Deferred.await(drained);
    assert.deepStrictEqual(selections, ["model-B"]);
    assert.deepStrictEqual(yield* readThreadQueue("thread-1"), []);
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

for (const workspaceRoot of [null, "/repo"]) {
  it.effect(
    workspaceRoot === null
      ? "starts in the durable thread scratch directory when its folder has no workspace"
      : "admits immediately and dispatches in its folder workspace",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const folderSql = yield* SqlClient.SqlClient;
        yield* folderSql`INSERT INTO projection_folders (folder_id, title, workspace_root, space_id, created_at, updated_at)
      VALUES ('sender-folder', 'Sender folder', ${workspaceRoot}, 'space-1', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`;
        yield* createThread({
          folderId: "sender-folder",
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
        const completions = new Map<string, Deferred.Deferred<void, unknown>>();
        for (const id of ["m1", "m2", "m3"])
          completions.set(id, yield* Deferred.make<void, unknown>());
        let expectedCwd =
          workspaceRoot ??
          ensureDurableThreadWorkspace(ThreadId.makeUnsafe("thread-1"), senderStateDir);
        const dispatchedCwds: string[] = [];
        const coordinator: typeof ProviderThreadSwitchCoordinator.Service = {
          dispatchTurnStart: ({ command, cwd }) =>
            Effect.gen(function* () {
              dispatchCount += 1;
              assert.equal(cwd, expectedCwd);
              if (cwd === undefined) throw new Error("The turn must have a directory.");
              dispatchedCwds.push(cwd);
              assert.equal(command.connectionId, null);
              publisher.publishProvider({
                type: "turn.started",
                threadId: command.threadId,
                turnId: "native-turn",
                at: command.createdAt,
              });
              yield* settleMessage(
                publisher,
                {
                  type: "acknowledged",
                  threadId: command.threadId,
                  messageId: command.message.messageId,
                  turnId: "native-turn",
                },
                new Date().toISOString(),
              );
              yield* Deferred.succeed(completions.get(command.message.messageId)!, undefined);
              return { turnId: TurnId.makeUnsafe("fixture-turn") };
            }).pipe(
              Effect.provideService(SqlClient.SqlClient, folderSql),
              Effect.onError((cause) =>
                Deferred.failCause(completions.get(command.message.messageId)!, cause),
              ),
              Effect.orDie,
            ),
        };
        const sender = yield* makeThreadSender.pipe(
          Effect.provide(ProviderSessionDirectoryLive),
          Effect.provide(ThreadLanesLive),
          Effect.provideService(ServerConfig, {
            stateDir: senderStateDir,
          } as typeof ServerConfig.Service),
          Effect.provide(ManagedAttachmentRepositoryLive),
          Effect.provideService(ThreadPublisher, publisher),
          Effect.provideService(ProviderThreadSwitchCoordinator, coordinator),
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
            origin: { _tag: "user" as const },
            queuedAt: "2026-10-09T00:00:01.000Z",
          },
          dispatchMode: "queue",
        } satisfies ThreadSendInput;
        const result = yield* sender.send(request);
        assert.deepStrictEqual(yield* sender.send(request), result);
        yield* Deferred.await(completions.get("m1")!);
        assert.equal(dispatchCount, 1);
        assert.equal(result.plan, "deliver");
        if (result.plan === "deliver") assert.isNumber(result.seq);
        yield* folderSql`UPDATE projection_folders SET workspace_root='/new-repo' WHERE folder_id='sender-folder'`;
        assert.equal(dispatchCount, 1);
        assert.equal(dispatchedCwds[0], expectedCwd);
        yield* setThreadState("thread-1", "idle", null, null, "2026-10-09T00:00:02.000Z");
        expectedCwd = "/new-repo";
        assert.equal(
          (yield* sender.send({
            ...request,
            message: { ...request.message, messageId: MessageId.makeUnsafe("m2") },
          })).plan,
          "deliver",
        );
        yield* Deferred.await(completions.get("m2")!);
        yield* folderSql`UPDATE projection_folders SET workspace_root=NULL WHERE folder_id='sender-folder'`;
        yield* setThreadState("thread-1", "idle", null, null, "2026-10-09T00:00:03.000Z");
        expectedCwd = ensureDurableThreadWorkspace(ThreadId.makeUnsafe("thread-1"), senderStateDir);
        assert.equal(
          (yield* sender.send({
            ...request,
            message: { ...request.message, messageId: MessageId.makeUnsafe("m3") },
          })).plan,
          "deliver",
        );
        yield* Deferred.await(completions.get("m3")!);
        assert.equal(dispatchCount, 3);
      }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
  );
}
it.effect(
  "message cancellation only removes queued entries; thread interruption waits for provider state",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const folderSql = yield* SqlClient.SqlClient;
      yield* folderSql`INSERT INTO projection_folders (folder_id, title, workspace_root, space_id, created_at, updated_at)
      VALUES ('sender-folder', 'Sender folder', NULL, 'space-1', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`;
      yield* createThread({
        folderId: "sender-folder",
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
          origin: { _tag: "user" as const },
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
      yield* observePublisher(publisher.threadChanges, (change) => changes.push(change.threadId));
      const interrupts: unknown[] = [];
      let nativeState: "ready" | "starting" = "ready";
      const sender = yield* makeThreadSender.pipe(
        Effect.provide(ProviderSessionDirectoryLive),
        Effect.provide(ThreadLanesLive),
        Effect.provideService(ServerConfig, {
          stateDir: senderStateDir,
        } as typeof ServerConfig.Service),
        Effect.provide(ManagedAttachmentRepositoryLive),
        Effect.provideService(ThreadPublisher, publisher),
        Effect.provideService(
          ProviderThreadSwitchCoordinator,
          {} as typeof ProviderThreadSwitchCoordinator.Service,
        ),
        Effect.provideService(ProviderService, {
          getRuntimeState: () => nativeState,
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
      nativeState = "starting";
      const startupStop = yield* sender.interrupt(threadId);
      assert.isTrue(startupStop.interruptRequested);
      assert.isNull(startupStop.interruptedTurnId);
      assert.deepStrictEqual(interrupts, [{ threadId }, { threadId }]);
      nativeState = "ready";
      yield* enqueueMessage(threadId, {
        messageId: MessageId.makeUnsafe("queued-after-service-start"),
        text: "fresh row",
        attachments: [],
        origin: { _tag: "user" as const },
        queuedAt: "2026-10-09T00:00:04.000Z",
      });
      assert.equal(yield* sender.queuedThread("queued-after-service-start"), threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

for (const release of ["next-send", "remove-head", "edit-head"] as const) {
  it.effect(`a failed queue head stays blocked until ${release}`, () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const folderSql = yield* SqlClient.SqlClient;
      yield* folderSql`INSERT INTO projection_folders (folder_id, title, workspace_root, space_id, created_at, updated_at)
      VALUES ('sender-folder', 'Sender folder', NULL, 'space-1', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`;
      yield* createThread({
        folderId: "sender-folder",
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
        origin: { _tag: "user" as const },
        queuedAt: "2026-10-09T00:00:01.000Z",
      });
      for (const id of ["head", "second"]) yield* enqueueMessage("thread-q", message(id));
      yield* setThreadState("thread-q", "running", "old-turn", null, "2026-10-09T00:00:02.000Z");
      const publisher = makeThreadPublisher();
      const failed = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const failedAgain = yield* Deferred.make<void>();
      let reject = true;
      let rejected = false;
      const attempts: string[] = [];
      yield* observePublisher(publisher.threadChanges, () => {
        if (rejected) Effect.runFork(Deferred.succeed(failed, undefined));
        if (rejected && attempts.length === 2)
          Effect.runFork(Deferred.succeed(failedAgain, undefined));
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
            yield* applyProviderEvent(publisher, {
              type: "turn.started",
              threadId: command.threadId,
              turnId: "new-native",
              at: command.createdAt,
            });
            yield* settleMessage(
              publisher,
              {
                type: "acknowledged",
                threadId: command.threadId,
                messageId: command.message.messageId,
                turnId: "new-native",
              },
              new Date().toISOString(),
            );
            yield* Deferred.succeed(delivered, undefined);
            return { turnId: TurnId.makeUnsafe("fixture-turn") };
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, folderSql),
            Effect.mapError(
              (cause) => new ProviderThreadSwitchCoordinatorError({ detail: cause.message }),
            ),
          ),
      } satisfies typeof ProviderThreadSwitchCoordinator.Service;
      const sender = yield* makeThreadSender.pipe(
        Effect.provide(ProviderSessionDirectoryLive),
        Effect.provide(ThreadLanesLive),
        Effect.provideService(ServerConfig, {
          stateDir: senderStateDir,
        } as typeof ServerConfig.Service),
        Effect.provide(ManagedAttachmentRepositoryLive),
        Effect.provideService(ThreadPublisher, publisher),
        Effect.provideService(ProviderThreadSwitchCoordinator, coordinator),
        Effect.provideService(ProviderService, {} as typeof ProviderService.Service),
      );
      yield* applyProviderEvent(publisher, {
        type: "turn.ended",
        threadId: "thread-q",
        turnId: "old-turn",
        state: release === "next-send" ? "completed" : "error",
        error: "old turn error",
        at: "2026-10-09T00:00:03.000Z",
      });
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
        plan: "queue",
        position: 3,
        queueLength: 3,
      });
      yield* Deferred.await(failedAgain);
      assert.deepStrictEqual(attempts, ["head", "head"]);
      reject = false;
      if (release === "next-send") {
        const result = yield* sender.send({
          threadId: ThreadId.makeUnsafe("thread-q"),
          message: message("fourth"),
          dispatchMode: "steer",
        });
        assert.equal(result.plan, "queue");
        yield* Deferred.await(delivered);
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
            skills: [],
            mentions: [],
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
    const folderSql = yield* SqlClient.SqlClient;
    yield* folderSql`INSERT INTO projection_folders (folder_id, title, workspace_root, space_id, created_at, updated_at)
      VALUES ('sender-folder', 'Sender folder', NULL, 'space-1', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`;
    const sql = yield* SqlClient.SqlClient;
    yield* createThread({
      folderId: "sender-folder",
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
    yield* observePublisher(publisher.threadChanges, (change) => changes.push(change.threadId));
    const coordinator: typeof ProviderThreadSwitchCoordinator.Service = {
      dispatchTurnStart: ({ command, attachmentPrincipal }) =>
        Effect.gen(function* () {
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
          yield* settleMessage(
            publisher,
            {
              type: "acknowledged",
              threadId: command.threadId,
              messageId: command.message.messageId,
              turnId: "next",
            },
            new Date().toISOString(),
          );
          return { turnId: TurnId.makeUnsafe("fixture-turn") };
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
    };
    const sender = yield* makeThreadSender.pipe(
      Effect.provide(ProviderSessionDirectoryLive),
      Effect.provide(ThreadLanesLive),
      Effect.provideService(ServerConfig, {
        stateDir: senderStateDir,
      } as typeof ServerConfig.Service),
      Effect.provideService(ThreadPublisher, publisher),
      Effect.provideService(ProviderThreadSwitchCoordinator, coordinator),
      Effect.provideService(ProviderService, {
        interruptTurn: () => Effect.void,
      } as unknown as typeof ProviderService.Service),
    );
    const request: ThreadSendInput = {
      threadId: ThreadId.makeUnsafe("thread-attachments"),
      draftUpdatedAt: null,
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
        origin: { _tag: "user" as const },
        queuedAt: at,
      },
    };
    const wrongOwner = yield* Effect.exit(sender.send(request));
    assert.isTrue(Exit.isFailure(wrongOwner));
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
    assert.equal(queued.plan, "queue");
    assert.equal(changes.length, 1);
    const [cleared] = yield* sql<{
      draft: string;
    }>`SELECT draft FROM threads WHERE id=${request.threadId}`;
    assert.deepStrictEqual(JSON.parse(cleared!.draft), {
      prompt: "",
      attachments: [],
      files: [],
      modelSelectionByProvider: { codex: { provider: "codex", model: "gpt-5.5" } },
      connectionSelectionByProvider: { codex: null },
      activeProvider: "codex",
      runtimeMode: "full-access",
    });
    const blob = yield* repository.findClaimedById({ attachmentId: "attachment" });
    assert.isTrue(Option.isSome(blob));
    yield* setThreadState(request.threadId, "idle", null, null, new Date().toISOString());
    const started = yield* sender.send(request).pipe(
      Effect.provideService(CurrentManagedAttachmentPrincipal, {
        ownerKind: "session",
        ownerId: "another-window",
      } as const),
    );
    assert.equal(started.plan, "queue");
    yield* waitForSentMessage(publisher, request.threadId, request.message.messageId);
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
      const folderSql = yield* SqlClient.SqlClient;
      yield* folderSql`INSERT INTO projection_folders (folder_id, title, workspace_root, space_id, created_at, updated_at)
      VALUES ('sender-folder', 'Sender folder', NULL, 'space-1', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-edit");
      yield* createThread({
        folderId: "sender-folder",
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
        origin: { _tag: "user" as const },
        queuedAt: "2026-10-10T00:00:02.000Z",
      };
      yield* enqueueMessage(threadId, message);
      yield* sql`UPDATE threads SET draft = '{"prompt":"","attachments":[],"files":[]}',draft_updated_at='2026-10-10T00:00:02.000Z' WHERE id = ${threadId}`;
      const publisher = makeThreadPublisher();
      const changes: string[] = [];
      yield* observePublisher(publisher.threadChanges, (change) => changes.push(change.threadId));
      const sender = yield* makeThreadSender.pipe(
        Effect.provide(ProviderSessionDirectoryLive),
        Effect.provide(ThreadLanesLive),
        Effect.provideService(ServerConfig, {
          stateDir: senderStateDir,
        } as typeof ServerConfig.Service),
        Effect.provide(ManagedAttachmentRepositoryLive),
        Effect.provideService(ThreadPublisher, publisher),
        Effect.provideService(
          ProviderThreadSwitchCoordinator,
          {} as typeof ProviderThreadSwitchCoordinator.Service,
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
      const [beforeEdit] = yield* sql<{
        draft_updated_at: string;
      }>`SELECT draft_updated_at FROM threads WHERE id=${threadId}`;
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
        skills: [],
        mentions: [],
      });
      assert.isAbove(Date.parse(stored.draftUpdatedAt), Date.parse(beforeEdit!.draft_updated_at));
      assert.equal(stored.updatedAt, stored.draftUpdatedAt);
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
        const folderSql = yield* SqlClient.SqlClient;
        yield* folderSql`INSERT INTO projection_folders (folder_id, title, workspace_root, space_id, created_at, updated_at)
      VALUES ('sender-folder', 'Sender folder', NULL, 'space-1', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("edit-nonempty");
        yield* createThread({
          folderId: "sender-folder",
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
          messageId: MessageId.makeUnsafe("queue"),
          text: "queued text",
          attachments: [],
          origin: { _tag: "user" as const },
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
        yield* observePublisher(publisher.threadChanges, (change) => changes.push(change.threadId));
        const sender = yield* makeThreadSender.pipe(
          Effect.provide(ProviderSessionDirectoryLive),
          Effect.provide(ThreadLanesLive),
          Effect.provideService(ServerConfig, {
            stateDir: senderStateDir,
          } as typeof ServerConfig.Service),
          Effect.provide(ManagedAttachmentRepositoryLive),
          Effect.provideService(ThreadPublisher, publisher),
          Effect.provideService(
            ProviderThreadSwitchCoordinator,
            {} as typeof ProviderThreadSwitchCoordinator.Service,
          ),
          Effect.provideService(ProviderService, {} as typeof ProviderService.Service),
        );
        const result = yield* Effect.exit(
          sender.editQueued({
            threadId,
            messageId: "queue",
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

for (const provider of ["codex", "claudeAgent"] as const) {
  for (const sameAccount of [true, false]) {
    it.effect(
      `${provider} now delegates the ${sameAccount ? "steer" : "interrupt-deliver"} admission and draft selection`,
      () =>
        Effect.gen(function* () {
          yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_folders (folder_id, title, workspace_root, space_id, created_at, updated_at) VALUES ('now-folder', 'Folder', NULL, 'space', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`;
          yield* createThread({
            id: "now-thread",
            folderId: "now-folder",
            spaceId: "space",
            title: "Now",
            provider,
            model: "model-A",
            runtimeMode: "full-access",
            createdBy: "user",
            createdAt: "2026-10-11T00:00:00.000Z",
          });
          yield* sql`UPDATE threads SET connection_id='account-A', native_state_id='native-A' WHERE id='now-thread'`;
          yield* setThreadState(
            "now-thread",
            "running",
            "old-turn",
            null,
            "2026-10-11T00:00:01.000Z",
          );
          const publisher = makeThreadPublisher();
          const order: string[] = [];
          const dispatched = yield* Deferred.make<void>();
          const selectedConnection = sameAccount ? "account-A" : "account-B";
          yield* setThreadDraft(
            publisher,
            "now-thread",
            JSON.stringify({
              prompt: "",
              attachments: [],
              files: [],
              modelSelectionByProvider: { [provider]: { provider, model: "model-B" } },
              connectionSelectionByProvider: { [provider]: selectedConnection },
            }),
            "2026-10-11T00:00:02.000Z",
          );
          const sender = yield* makeThreadSender.pipe(
            Effect.provide(ProviderSessionDirectoryLive),
            Effect.provide(ThreadLanesLive),
            Effect.provideService(ServerConfig, {
              stateDir: senderStateDir,
            } as typeof ServerConfig.Service),
            Effect.provide(ManagedAttachmentRepositoryLive),
            Effect.provideService(ThreadPublisher, publisher),
            Effect.provideService(ProviderService, {
              interruptTurn: () => Effect.die("The switch coordinator owns interruption"),
            } as unknown as typeof ProviderService.Service),
            Effect.provideService(ProviderThreadSwitchCoordinator, {
              dispatchTurnStart: ({ command }) =>
                Effect.gen(function* () {
                  order.push("dispatch");
                  assert.equal(command.connectionId, selectedConnection);
                  assert.equal(command.modelSelection!.model, "model-B");
                  assert.equal(command.dispatchMode, sameAccount ? "steer" : "interrupt-deliver");
                  yield* applyProviderEvent(publisher, {
                    type: "turn.started",
                    threadId: "now-thread",
                    turnId: "new-turn",
                    at: command.createdAt,
                  });
                  yield* settleMessage(
                    publisher,
                    {
                      type: "acknowledged",
                      threadId: command.threadId,
                      messageId: command.message.messageId,
                      turnId: "new-turn",
                    },
                    new Date().toISOString(),
                  );
                  yield* Deferred.succeed(dispatched, undefined);
                  return { turnId: TurnId.makeUnsafe("fixture-turn") };
                }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
            }),
          );
          const result = yield* sender.send({
            threadId: ThreadId.makeUnsafe("now-thread"),
            message: {
              messageId: MessageId.makeUnsafe("now-message"),
              text: "continue",
              attachments: [],
              origin: { _tag: "user" as const },
              queuedAt: "2026-10-11T00:00:02.000Z",
            },
            dispatchMode: "steer",
          });
          assert.equal(result.plan, sameAccount ? "steer" : "interrupt-deliver");
          yield* Deferred.await(dispatched);
          assert.deepStrictEqual(order, ["dispatch"]);
        }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
    );
  }
}

it.effect("removes a failed user message but never a member of an admitted retry cohort", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_folders (folder_id,title,space_id,created_at,updated_at) VALUES ('folder','Folder','space','2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z')`;
      yield* createThread({
        id: "thread",
        folderId: "folder",
        spaceId: "space",
        title: "Thread",
        provider: "codex",
        model: "model",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-12T00:00:00.000Z",
      });
      const publisher = makeThreadPublisher();
      const sender = yield* makeThreadSender.pipe(
        Effect.provide(ProviderSessionDirectoryLive),
        Effect.provide(ThreadLanesLive),
        Effect.provideService(ServerConfig, {
          stateDir: senderStateDir,
        } as typeof ServerConfig.Service),
        Effect.provide(ManagedAttachmentRepositoryLive),
        Effect.provideService(ThreadPublisher, publisher),
        Effect.provideService(
          ProviderThreadSwitchCoordinator,
          {} as typeof ProviderThreadSwitchCoordinator.Service,
        ),
        Effect.provideService(ProviderService, {} as typeof ProviderService.Service),
      );
      const message = {
        threadId: "thread",
        message: {
          messageId: MessageId.makeUnsafe("remove"),
          text: "Remove",
          attachments: [],
          origin: { _tag: "user" as const },
          queuedAt: "2026-10-12T00:00:00.000Z",
        },
        dispatchMode: "queue" as const,
        supportsSteer: true,
      };
      yield* sendMessage(
        publisher,
        {
          isRunning: () => Effect.succeed(false),
          claimAttachments: () => Effect.void,
          dispatch: () => Effect.void,
        },
        message,
      );
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "remove", error: "refused" },
        message.message.queuedAt,
      );
      assert.equal(yield* sender.queuedThread("remove"), "thread");
      assert.equal(
        (yield* sender.cancelQueued({
          threadId: ThreadId.makeUnsafe("thread"),
          messageId: "remove",
        })).removed,
        true,
      );
      assert.deepStrictEqual(yield* sql`SELECT source_id FROM thread_items WHERE kind='user'`, []);
      yield* sendMessage(
        publisher,
        {
          isRunning: () => Effect.succeed(false),
          claimAttachments: () => Effect.void,
          dispatch: () => Effect.void,
        },
        message,
      );
      assert.equal(
        (yield* sender.cancelQueued({
          threadId: ThreadId.makeUnsafe("thread"),
          messageId: "remove",
        })).removed,
        false,
      );
      assert.equal((yield* sql`SELECT 1 FROM thread_items WHERE source_id='remove'`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  ),
);
