import { settleMessage } from "./sendMessage";
import { ensureDurableThreadWorkspace } from "../scratchWorkspaces.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { ServerConfig } from "../config.ts";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ThreadId,
  FolderId,
  type CleanCoreCreateAndSendThreadInput,
} from "@penkra/contracts";
import { Deferred, Effect, Option } from "effect";
import { makeThreadSender, ThreadSender } from "./ThreadSender.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { makeThreadPublisher } from "./threadStore.ts";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

import { ProviderTurnSelectionResolver } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import { createAndSendThread } from "./createAndSendThread.ts";

const senderStateDir = mkdtempSync(join(tmpdir(), "penkra-draft-sender-"));
afterAll(() => rmSync(senderStateDir, { recursive: true, force: true }));

for (const nativeFails of [false, true]) {
  it.effect(
    nativeFails
      ? "first + send restores its serialized draft on native failure"
      : "first send creates one thread and one message, including on retry",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-10-10T00:00:00.000Z";
        yield* sql`INSERT INTO projection_folders (folder_id, space_id, title, workspace_root, created_at, updated_at)
      VALUES ('sender-folder', 'penkra-personal', 'Folder', NULL, ${at}, ${at})`;
        const publisher = makeThreadPublisher();
        let dispatchCount = 0;
        const dispatched = yield* Deferred.make<void>();
        const expectedCwd = ensureDurableThreadWorkspace(
          ThreadId.makeUnsafe("thread-1"),
          senderStateDir,
        );
        const coordinator: typeof ProviderThreadSwitchCoordinator.Service = {
          dispatchTurnStart: ({ command, cwd }) =>
            Effect.gen(function* () {
              dispatchCount += 1;
              assert.equal(cwd, expectedCwd);
              if (cwd === undefined) throw new Error("The turn must have a directory.");
              assert.equal(command.connectionId, null);
              assert.isTrue(command.commandId.length > 0);
              if (nativeFails) {
                yield* settleMessage(
                  publisher,
                  {
                    type: "failed",
                    threadId: command.threadId,
                    messageId: command.message.messageId,
                    error: "First send refused",
                  },
                  new Date().toISOString(),
                );
                yield* Deferred.succeed(dispatched, undefined);
                return { sequence: 1 };
              }
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
              yield* Deferred.succeed(dispatched, undefined);
              return { sequence: 1 };
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
          dispatchQueuedTurn: () => Effect.die("no old queue"),
        };
        const sender = yield* makeThreadSender.pipe(
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

        const originalDraft = JSON.stringify({
          prompt: "original first prompt",
          attachments: [],
          files: [],
          pastedTexts: [{ id: "first-paste", createdAt: at, text: "first context".repeat(10_000) }],
        });
        const input = {
          draft: originalDraft,
          thread: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            folderId: FolderId.makeUnsafe("sender-folder"),
            title: "Hello",
            modelSelection: { provider: "codex", model: "gpt-5.5" },
            connection: { kind: "selected", connectionId: null },
            runtimeMode: "full-access",
            createdAt: at,
            creator: { kind: "user" },
          },
          dispatchMode: "queue",
          message: {
            messageId: MessageId.makeUnsafe("first-message"),
            text: "hello",
            attachments: [],
            senderThreadId: null,
            dispatchOrigin: "user",
            queuedAt: at,
          },
        } satisfies CleanCoreCreateAndSendThreadInput;
        const send = () =>
          createAndSendThread(input).pipe(
            Effect.provideService(ThreadPublisher, publisher),
            Effect.provideService(ThreadSender, sender),
            Effect.provideService(ProviderTurnSelectionResolver, {
              resolveNewThreadConnection: () => Effect.succeed(null),
            } as unknown as typeof ProviderTurnSelectionResolver.Service),
          );
        const first = yield* send();
        if (nativeFails) {
          yield* Deferred.await(dispatched);
          assert.isTrue(first.created);
          assert.equal(first.sendResult.plan, "deliver");
          assert.deepStrictEqual(yield* sql`SELECT draft,last_error FROM threads`, [
            { draft: originalDraft, last_error: "First send refused" },
          ]);
          assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items WHERE kind='user'`, []);
          return;
        }
        const repeated = yield* send();
        assert.isTrue(first.created);
        assert.isFalse(repeated.created);
        assert.equal(first.sendResult.plan, "deliver");
        assert.deepStrictEqual(repeated.sendResult, first.sendResult);
        yield* Deferred.await(dispatched);
        assert.equal(dispatchCount, 1);
        assert.equal((yield* sql`SELECT id FROM threads`).length, 1);
        assert.deepStrictEqual(
          yield* sql`SELECT source_id, text FROM thread_items WHERE kind='user'`,
          [{ source_id: "first-message", text: "hello" }],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
  );
}
