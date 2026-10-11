import { afterAll } from "vitest";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ServerConfig } from "../config.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { providerNativeStateRoot } from "../provider/providerNativeStatePaths.ts";
import { createThreadFixture } from "./threadFixtures.ts";
import { ProviderTurnSelectionResolver } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import { assert, it } from "@effect/vitest";
import { FolderId, MessageId, ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ThreadProviderBindingRepository } from "../persistence/Services/ThreadProviderBindings.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeThreadSender, ThreadSender } from "./ThreadSender.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { makeThreadPublisher, setThreadState, setThreadArchived } from "./threadStore.ts";
import {
  createThreadFromClient,
  updateThreadLifecycle,
  makeThreadLifecycle,
} from "./threadLifecycle.ts";
import { getThread } from "./threadList.ts";

it.effect("web creation is idempotent and a send on its running thread is queued", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const publisher = makeThreadPublisher();
    const changes: string[] = [];
    publisher.subscribeAll(({ threadId }) => changes.push(threadId));
    const sidebarChanges: import("@penkra/contracts").CleanCoreSidebarChange[] = [];
    publisher.subscribeSidebar((change) => sidebarChanges.push(change));
    const at = "2026-10-10T00:00:00.000Z";
    yield* sql`INSERT INTO projection_folders (folder_id, space_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at) VALUES ('folder', 'penkra-personal', 'Folder', NULL, NULL, '[]', ${at}, ${at})`;
    const input = {
      threadId: ThreadId.makeUnsafe("web-thread"),
      folderId: FolderId.makeUnsafe("folder"),
      title: "Thread",
      modelSelection: { provider: "codex" as const, model: "gpt-5.5" },
      connection: { kind: "selected" as const, connectionId: null },
      runtimeMode: "full-access" as const,
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
    assert.deepStrictEqual(sidebarChanges, [{ kind: "thread.created", threadId: input.threadId }]);
    yield* setThreadState(input.threadId, "running", "active-turn", null, at);
    const sender = yield* makeThreadSender.pipe(
      Effect.provideService(ServerConfig, {
        stateDir: senderStateDir,
      } as typeof ServerConfig.Service),
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
      Effect.provideService(ProviderService, {} as unknown as typeof ProviderService.Service),
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
    const archiveFailure = yield* setThreadArchived(input.threadId, at, at).pipe(Effect.flip);
    assert.include(archiveFailure.message, "still running");
    yield* setThreadState(input.threadId, "idle", null, null, at);
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
  }).pipe(
    Effect.provideService(
      ProviderTurnSelectionResolver,
      {} as typeof ProviderTurnSelectionResolver.Service,
    ),
    Effect.scoped,
    Effect.provide(NodeSqliteClient.layerMemory()),
  ),
);

it.effect(
  "fails deletion before changing or publishing the row when native-state removal fails",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const stateDir = mkdtempSync(join(tmpdir(), "penkra-delete-failure-"));
      const nativeStateId = "delete-failure-generation";
      const nativePath = providerNativeStateRoot(stateDir, nativeStateId);
      const parent = dirname(nativePath);
      mkdirSync(nativePath, { recursive: true });
      writeFileSync(join(nativePath, "state"), "native state");
      try {
        const at = "2026-10-10T00:00:00.000Z";
        yield* sql`INSERT INTO projection_folders (folder_id, space_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at) VALUES ('delete-folder', 'penkra-personal', 'Folder', NULL, NULL, '[]', ${at}, ${at})`;
        const threadId = ThreadId.makeUnsafe("delete-failure-thread");
        yield* createThreadFixture(sql, {
          threadId,
          folderId: FolderId.makeUnsafe("delete-folder"),
          title: "Delete failure",
          modelSelection: { provider: "codex", model: "gpt-5.5" },
          runtimeMode: "full-access",
          connection: { kind: "selected", connectionId: null },
          creator: { kind: "user" },
          createdAt: at,
        });
        yield* sql`UPDATE threads SET native_state_id = ${nativeStateId} WHERE id = ${threadId}`;
        const publisher = makeThreadPublisher();
        const changes: string[] = [];
        publisher.subscribeAll((change) => {
          assert.isFalse(existsSync(nativePath));
          changes.push(change.threadId);
        });
        const cleanup: string[] = [];
        const lifecycle = yield* makeThreadLifecycle.pipe(
          Effect.provideService(ThreadPublisher, publisher),
          Effect.provideService(
            ProviderTurnSelectionResolver,
            {} as typeof ProviderTurnSelectionResolver.Service,
          ),
          Effect.provideService(ThreadSender, {
            runExclusive: (_id, action) => action,
          } as typeof ThreadSender.Service),
          Effect.provideService(ProviderService, {
            stopSession: () =>
              Effect.sync(() => {
                cleanup.push("stop");
              }),
          } as unknown as typeof ProviderService.Service),
          Effect.provideService(TerminalManager, {
            close: () =>
              Effect.sync(() => {
                cleanup.push("close");
              }),
          } as unknown as typeof TerminalManager.Service),
          Effect.provideService(ServerConfig, { stateDir } as typeof ServerConfig.Service),
        );
        chmodSync(parent, 0o500);
        const update = {
          action: "delete" as const,
          threadId,
          deletedAt: "2026-10-10T00:01:00.000Z",
          updatedAt: "2026-10-10T00:01:00.000Z",
        };
        const error = yield* Effect.flip(lifecycle.update(update));
        assert.include(error.message, nativePath);
        assert.match(error.message, /EACCES|EPERM/);
        assert.instanceOf(error.cause, Error);
        assert.equal((yield* getThread(threadId)).deletedAt, null);
        assert.equal((yield* getThread(threadId)).updatedAt, at);
        assert.deepStrictEqual(changes, []);
        assert.deepStrictEqual(cleanup, ["stop", "close"]);
        chmodSync(parent, 0o700);
        yield* lifecycle.update(update);
        assert.equal((yield* getThread(threadId)).deletedAt, update.deletedAt);
        assert.deepStrictEqual(changes, [threadId]);
      } finally {
        chmodSync(parent, 0o700);
        rmSync(stateDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
const senderStateDir = mkdtempSync(join(tmpdir(), "penkra-test-thread-cwd-"));
afterAll(() => rmSync(senderStateDir, { recursive: true, force: true }));
