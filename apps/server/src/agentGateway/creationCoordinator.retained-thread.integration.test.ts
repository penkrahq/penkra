import { ThreadLanesLive } from "../cleanCore/ThreadLanes.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { settleMessage } from "../cleanCore/sendMessage";
import { afterAll } from "vitest";
import { ServerConfig } from "../config.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import { assert, it } from "@effect/vitest";
import {
  FolderId,
  MessageId,
  ThreadId,
  TurnId,
  ProviderConnectionId,
  type OrchestrationThreadShell,
} from "@penkra/contracts";
import { Deferred, Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProviderTurnSelectionResolver } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import type { ThreadReadsShape } from "../cleanCore/ThreadReads.ts";
import { makeThreadSender } from "../cleanCore/ThreadSender.ts";
import { ThreadPublisher } from "../cleanCore/ThreadPublisher.ts";
import { makeThreadPublisher, setThreadState } from "../cleanCore/threadStore.ts";
import {
  createThreadFromClient,
  updateThreadLifecycle,
  ThreadLifecycle,
} from "../cleanCore/threadLifecycle.ts";
import { findThread } from "../cleanCore/threadList.ts";
import { makeCreateThreadHandler } from "./creationCoordinator.ts";

it.effect(
  "retains a single clean-core child through launch failure, retry, and repeated admission",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-10-10T00:00:00.000Z";
      const callerId = ThreadId.makeUnsafe("caller");
      const folderId = FolderId.makeUnsafe("folder");
      const accountA = ProviderConnectionId.makeUnsafe("account-a");
      let defaultConnection = accountA;
      yield* sql`INSERT INTO projection_folders (folder_id, space_id, title, workspace_root, default_model_selection_json, created_at, updated_at) VALUES (${folderId}, 'penkra-personal', 'Folder', NULL, NULL, ${at}, ${at})`;
      const publisher = makeThreadPublisher();
      const resolver: typeof ProviderTurnSelectionResolver.Service = {
        authorizeConnection: () => Effect.die("not used in creation"),
        resolveNewThreadConnection: () => Effect.sync(() => defaultConnection),
        resolveExisting: () => Effect.die("unused existing resolver"),
      };
      const lifecycle: typeof ThreadLifecycle.Service = {
        archiveInactive: () => Effect.die("unused retention archive"),
        deleteExpired: () => Effect.die("unused retention delete"),
        get: (id) => findThread(id).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        create: (input) =>
          createThreadFromClient(input).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ThreadPublisher, publisher),
            Effect.provideService(ProviderTurnSelectionResolver, resolver),
          ),
        update: (input) =>
          updateThreadLifecycle(input).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ThreadPublisher, publisher),
          ),
      };
      yield* lifecycle.create({
        threadId: callerId,
        folderId,
        title: "Caller",
        modelSelection: { provider: "codex", model: "gpt-5.5" },
        runtimeMode: "full-access",
        createdAt: at,
        creator: { kind: "user" },
        connection: { kind: "selected", connectionId: null },
      });
      let failLaunch = true;
      let dispatches = 0;
      const failureSettled = yield* Deferred.make<void>();
      const successSettled = yield* Deferred.make<void>();
      const coordinator = {
        dispatchTurnStart: ({
          command,
        }: Parameters<typeof ProviderThreadSwitchCoordinator.Service.dispatchTurnStart>[0]) =>
          Effect.gen(function* () {
            dispatches++;
            if (failLaunch) {
              yield* settleMessage(
                publisher,
                {
                  type: "failed",
                  threadId: command.threadId,
                  messageId: command.message.messageId,
                  error: "controlled launch failure",
                },
                new Date().toISOString(),
              );
              yield* Deferred.succeed(failureSettled, undefined);
            } else {
              yield* setThreadState(command.threadId, "running", "confirmed-turn", null, at);
              publisher.publishProvider({
                type: "turn.started",
                threadId: command.threadId,
                turnId: "confirmed-turn",
                at,
              });
              yield* settleMessage(
                publisher,
                {
                  type: "acknowledged",
                  threadId: command.threadId,
                  messageId: command.message.messageId,
                  turnId: TurnId.makeUnsafe("confirmed-turn"),
                },
                new Date().toISOString(),
              );
              yield* Deferred.succeed(successSettled, undefined);
            }
            return { turnId: TurnId.makeUnsafe("confirmed-turn") };
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
      } satisfies typeof ProviderThreadSwitchCoordinator.Service;
      const newSender = () =>
        makeThreadSender.pipe(
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
      const sender = yield* newSender();
      const caller: OrchestrationThreadShell = {
        id: callerId,
        folderId,
        title: "Caller",
        modelSelection: { provider: "codex", model: "gpt-5.5" },
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        latestTurn: null,
        archivedAt: null,
        session: null,
        createdAt: at,
        updatedAt: at,
      };
      const dependencies: Parameters<typeof makeCreateThreadHandler>[0] = {
        stateDir: senderStateDir,
        lifecycle,
        sender,
        providerTurnSelectionResolver: resolver,
        providerDiscovery: {
          listModels: () =>
            Effect.succeed({ models: [{ slug: "gpt-5.5", name: "GPT" }], source: "fixture" }),
        } as unknown as ProviderDiscoveryServiceShape,
        snapshotQuery: {
          getFolderShellById: () =>
            Effect.succeed(
              Option.some({ id: folderId, spaceId: "penkra-personal", workspaceRoot: null }),
            ),
        } as unknown as ThreadReadsShape,
        loadProviderAvailabilities: Effect.succeed(
          new Map([["codex", { enabled: true, available: true, authStatus: "authenticated" }]]),
        ),
      };
      const handler = yield* makeCreateThreadHandler(dependencies);
      const input = {
        requestId: "retained-request",
        prompt: "Run the task",
        target: caller.modelSelection,
      };
      const context = {
        kind: "provider-session" as const,
        callerThreadId: callerId,
        callerTurnId: null,
        assertAuthority: () => Effect.void,
        attachmentPrincipal: { ownerKind: "session" as const, ownerId: "fixture" },
      };
      const failed = yield* handler(input, context);
      assert.notEqual(failed.isError, true);
      yield* Deferred.await(failureSettled);
      const [failedThread] = yield* sql<{
        last_error: string;
      }>`SELECT last_error FROM threads WHERE id != ${callerId}`;
      assert.equal(failedThread!.last_error, "controlled launch failure");
      const retained = yield* sql<{
        id: ThreadId;
        connectionId: string;
      }>`SELECT id, connection_id AS "connectionId" FROM threads WHERE id != ${callerId}`;
      assert.equal(retained.length, 1);
      assert.equal(retained[0]!.connectionId, accountA);
      assert.equal(
        (yield* sql`SELECT source_id FROM thread_items WHERE kind='user' AND status='failed' AND send_payload IS NOT NULL`)
          .length,
        1,
      );
      defaultConnection = ProviderConnectionId.makeUnsafe("account-b");
      failLaunch = false;
      const retry = yield* handler(input, context);
      assert.notEqual(retry.isError, true);
      const repeated = yield* handler(input, context);
      assert.deepStrictEqual(repeated, retry);
      const restartedHandler = yield* makeCreateThreadHandler({
        ...dependencies,
        sender: yield* newSender(),
      });
      assert.deepStrictEqual(yield* restartedHandler(input, context), retry);
      assert.equal(dispatches, 1);
      yield* sender.send({
        threadId: retained[0]!.id,
        dispatchMode: "queue",
        message: {
          messageId: MessageId.makeUnsafe("explicit-next-send"),
          text: "Continue the task",
          attachments: [],
          origin: { _tag: "agent", senderThreadId: callerId },
          queuedAt: at,
        },
      });
      yield* Deferred.await(successSettled);
      assert.equal(dispatches, 2);
      assert.equal((yield* sql`SELECT id FROM threads WHERE id != ${callerId}`).length, 1);
      assert.equal(
        (yield* sql`SELECT source_id FROM thread_items WHERE kind='user' AND status='sent'`).length,
        2,
      );
      assert.equal((yield* findThread(retained[0]!.id))!.connectionId, accountA);
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);
const senderStateDir = mkdtempSync(join(tmpdir(), "penkra-test-thread-cwd-"));
afterAll(() => rmSync(senderStateDir, { recursive: true, force: true }));
