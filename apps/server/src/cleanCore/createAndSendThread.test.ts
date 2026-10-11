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
import { Effect, Option } from "effect";
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

it.effect("first send creates one thread and one message, including on retry", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-10-10T00:00:00.000Z";
    yield* sql`INSERT INTO projection_folders (folder_id, space_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('sender-folder', 'penkra-personal', 'Folder', NULL, '[]', ${at}, ${at})`;
    const publisher = makeThreadPublisher();
    let dispatchCount = 0;
    const expectedCwd = ensureDurableThreadWorkspace(
      ThreadId.makeUnsafe("thread-1"),
      senderStateDir,
    );
    const coordinator: typeof ProviderThreadSwitchCoordinator.Service = {
      dispatchTurnStart: ({ command, cwd }) =>
        Effect.sync(() => {
          dispatchCount += 1;
          assert.equal(cwd, expectedCwd);
          if (cwd === undefined) throw new Error("The turn must have a directory.");
          assert.equal(command.connectionId, null);
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

    const input = {
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
    const repeated = yield* send();
    assert.isTrue(first.created);
    assert.isFalse(repeated.created);
    assert.equal(first.sendResult.delivery, "started");
    assert.deepStrictEqual(repeated.sendResult, first.sendResult);
    assert.equal(dispatchCount, 1);
    assert.equal((yield* sql`SELECT id FROM threads`).length, 1);
    assert.deepStrictEqual(yield* sql`SELECT source_id, text FROM thread_items WHERE kind='user'`, [
      { source_id: "first-message", text: "hello" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);
