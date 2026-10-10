import { assert, it } from "@effect/vitest";
import { FolderId, MessageId, ThreadDeckId, ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ThreadProviderBindingRepository } from "../persistence/Services/ThreadProviderBindings.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeThreadSender } from "./ThreadSender.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { makeThreadPublisher, setThreadState } from "./threadStore.ts";
import { createThreadFromClient, updateThreadLifecycle } from "./threadLifecycle.ts";
import { getThread } from "./threadList.ts";

it.effect("web creation is idempotent and a send on its running thread is queued", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const publisher = makeThreadPublisher();
    const changes: string[] = [];
    publisher.subscribeAll(({ threadId }) => changes.push(threadId));
    const at = "2026-10-10T00:00:00.000Z";
    yield* sql`INSERT INTO projection_folders (folder_id, space_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at) VALUES ('folder', 'penkra-personal', 'Folder', NULL, NULL, '[]', ${at}, ${at})`;
    const input = {
      threadId: ThreadId.makeUnsafe("web-thread"),
      folderId: FolderId.makeUnsafe("folder"),
      deckId: ThreadDeckId.makeUnsafe("deck"),
      title: "Thread",
      modelSelection: { provider: "codex" as const, model: "gpt-5.5" },
      connectionId: null,
      runtimeMode: "full-access" as const,
      workingDirectory: null,
      createdAt: at,
      creator: { kind: "user" as const },
    };
    yield* createThreadFromClient(input).pipe(Effect.provideService(ThreadPublisher, publisher));
    yield* createThreadFromClient({ ...input, title: "Ignored retry" }).pipe(
      Effect.provideService(ThreadPublisher, publisher),
    );
    assert.equal((yield* sql`SELECT id FROM threads WHERE id = ${input.threadId}`).length, 1);
    assert.equal((yield* getThread(input.threadId)).title, "Thread");
    assert.deepStrictEqual(changes, [input.threadId]);
    yield* setThreadState(input.threadId, "running", "active-turn", null, at);
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
      Effect.provideService(ProviderService, {} as typeof ProviderService.Service),
    );
    const result = yield* sender.send({
      threadId: input.threadId,
      dispatchMode: "queue",
      message: {
        messageId: MessageId.makeUnsafe("queued-message"),
        text: "next",
        attachments: [],
        senderThreadId: null,
        dispatchOrigin: "user",
        queuedAt: at,
      },
    });
    assert.equal(result.delivery, "queued");
    if (result.delivery === "queued") {
      assert.equal(result.position, 1);
      assert.equal(result.queueLength, 1);
    }
    const updates = [
      { action: "rename" as const, threadId: input.threadId, title: "Renamed", updatedAt: at },
      { action: "archive" as const, threadId: input.threadId, archivedAt: at, updatedAt: at },
      { action: "archive" as const, threadId: input.threadId, archivedAt: null, updatedAt: at },
      { action: "delete" as const, threadId: input.threadId, deletedAt: at, updatedAt: at },
    ];
    for (const update of updates) {
      const before = changes.length;
      yield* updateThreadLifecycle(update).pipe(Effect.provideService(ThreadPublisher, publisher));
      yield* updateThreadLifecycle(update).pipe(Effect.provideService(ThreadPublisher, publisher));
      assert.equal(changes.length, before + 1);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);
