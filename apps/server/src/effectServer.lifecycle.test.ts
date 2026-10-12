import { Effect, Exit, Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { closeServerRuntimePipeline, startServerRuntimeSubscriptions } from "./effectServer.ts";
import { createThread, makeThreadPublisher, upsertThreadItem } from "./cleanCore/threadStore.ts";
import { seedThreadFolderFixture } from "./cleanCore/threadFixtures.ts";
import { runMigrations } from "./persistence/Migrations.ts";
import * as NodeSqliteClient from "./persistence/NodeSqliteClient.ts";

describe("server runtime pipeline shutdown", () => {
  it("persists accepted provider terminal work before the engine stops", async () => {
    const order: string[] = [];
    let terminalAccepted = false;
    let providerCommandsSettled = false;
    let queuePromotionsQuiesced = false;
    let terminalPersisted = false;
    let attachmentsDrained = false;
    let workspaceWatcherClosed = false;
    const subscriptionsScope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      Scope.addFinalizer(
        subscriptionsScope,
        Effect.sync(() => {
          expect(terminalAccepted).toBe(true);
          terminalPersisted = true;
          order.push("reactors-drained-and-persisted");
        }),
      ),
    );

    await Effect.runPromise(
      closeServerRuntimePipeline({
        orchestrationEngine: {
          quiesce: Effect.sync(() => order.push("engine-quiesced")),
          drain: Effect.sync(() => order.push("admitted-commands-drained")),
          stop: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            expect(attachmentsDrained).toBe(true);
            expect(workspaceWatcherClosed).toBe(true);
            order.push("engine-stopped");
          }),
        },
        providerCommandReactor: {
          drain: Effect.sync(() => {
            expect(terminalAccepted).toBe(false);
            providerCommandsSettled = true;
            order.push("provider-commands-settled");
          }),
          quiesceQueuePromotions: Effect.sync(() => {
            expect(providerCommandsSettled).toBe(true);
            queuePromotionsQuiesced = true;
            order.push("queue-promotions-quiesced");
          }),
        },
        providerService: {
          closeRuntimeEvents: Effect.sync(() => {
            expect(providerCommandsSettled).toBe(true);
            expect(queuePromotionsQuiesced).toBe(true);
            terminalAccepted = true;
            order.push("provider-terminal-events-fenced");
          }),
        },
        managedAttachmentCleanup: {
          drain: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            expect(workspaceWatcherClosed).toBe(true);
            attachmentsDrained = true;
            order.push("managed-attachments-drained");
          }),
        },
        workspaceWatcher: {
          close: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            workspaceWatcherClosed = true;
            order.push("workspace-watcher-closed");
          }),
        },
        subscriptionsScope,
      }),
    );

    expect(order).toEqual([
      "engine-quiesced",
      "admitted-commands-drained",
      "provider-commands-settled",
      "queue-promotions-quiesced",
      "provider-terminal-events-fenced",
      "reactors-drained-and-persisted",
      "workspace-watcher-closed",
      "managed-attachments-drained",
      "engine-stopped",
    ]);
  });
});

describe("server runtime subscription startup", () => {
  it("cuts off unfinished turns and starts runtime observers before provider command dispatch can begin", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const subscriptionsScope = await Effect.runPromise(Scope.make("sequential"));
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations();
          yield* seedThreadFolderFixture("folder", "space");
          const at = "2026-10-11T00:00:00.000Z";
          yield* createThread({
            id: "thread",
            folderId: "folder",
            spaceId: "space",
            title: "Thread",
            provider: "codex",
            model: "gpt-5.5",
            runtimeMode: "full-access",
            createdBy: "user",
            createdAt: at,
          });
          yield* sql`UPDATE threads SET state='running', active_turn_id='turn' WHERE id='thread'`;
          yield* upsertThreadItem({
            threadId: "thread",
            sourceId: "unfinished",
            turnId: "turn",
            kind: "text",
            status: "streaming",
            text: "partial",
            createdAt: at,
            updatedAt: at,
          });
          yield* startServerRuntimeSubscriptions({
            threadPublisher: makeThreadPublisher(),
            providerRuntimeIngestion: {
              start: Effect.acquireRelease(
                Effect.gen(function* () {
                  expect(
                    yield* sql`SELECT state, active_turn_id FROM threads WHERE id='thread'`,
                  ).toEqual([{ state: "idle", active_turn_id: null }]);
                  expect(
                    yield* sql`SELECT status FROM thread_items WHERE source_id='unfinished'`,
                  ).toEqual([{ status: "interrupted" }]);
                  started.push("provider-runtime-ingestion");
                }).pipe(Effect.orDie),
                () => Effect.sync(() => stopped.push("provider-runtime-ingestion")),
              ),
            },
            providerCommandReactor: {
              start: Effect.acquireRelease(
                Effect.sync(() => {
                  expect(started).toEqual(["provider-runtime-ingestion"]);
                  started.push("provider-command-dispatch");
                }),
                () => Effect.sync(() => stopped.push("provider-command-dispatch")),
              ),
            },
            subscriptionsScope,
            startedAt: at,
          });
          expect(started).toEqual(["provider-runtime-ingestion", "provider-command-dispatch"]);
          yield* Scope.close(subscriptionsScope, Exit.void);
          expect(stopped).toEqual(["provider-command-dispatch", "provider-runtime-ingestion"]);
        }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
      );
    } finally {
      await Effect.runPromise(Scope.close(subscriptionsScope, Exit.void));
    }
  });
});
