import { singletonThreadDeckId } from "@penkra/contracts";
import {
  CommandId,
  EventId,
  MessageId,
  FolderId,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@penkra/contracts";
import { Effect, Layer, Logger, ManagedRuntime, Option, Queue, References, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
import { recoverRestartInterruptedTurns } from "../restartTurnRecovery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { canContinueLatestTurn } from "@penkra/shared/turnContinuation";

/**
 * Command ids whose fingerprinting throws synchronously, standing in for any
 * synchronous defect raised while the worker builds a command's pipeline.
 */
const fingerprintPoison = vi.hoisted(() => new Set<string>());

vi.mock("../commandFingerprint.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commandFingerprint.ts")>();
  return {
    ...actual,
    fingerprintOrchestrationCommand: (command: OrchestrationCommand) => {
      if (fingerprintPoison.has(command.commandId)) {
        throw new TypeError("poisoned command fingerprint");
      }
      return actual.fingerprintOrchestrationCommand(command);
    },
  };
});

const asFolderId = (value: string): FolderId => FolderId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);

const makeThreadEventReadMethods = (
  events: ReadonlyArray<OrchestrationEvent>,
): Pick<OrchestrationEventStoreShape, "getThreadHighWaterSequence" | "readThreadEvents"> => ({
  getThreadHighWaterSequence: (threadId) =>
    Effect.succeed(
      events
        .filter((event) => event.aggregateKind === "thread" && event.aggregateId === threadId)
        .at(-1)?.sequence ?? 0,
    ),
  readThreadEvents: (input) =>
    Effect.succeed(
      events
        .filter(
          (event) =>
            event.aggregateKind === "thread" &&
            event.aggregateId === input.threadId &&
            event.sequence <= input.throughSequenceInclusive &&
            event.sequence < (input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER) &&
            (input.eventTypes === undefined || input.eventTypes.includes(event.type)),
        )
        .toSorted((left, right) => right.sequence - left.sequence)
        .slice(0, input.limit),
    ),
});
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

const TestServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "penkra-orchestration-engine-test-",
});

const TEST_SPACE_ID = SpaceId.makeUnsafe("space-orchestration-engine-test");

const createTestSpace = (engine: OrchestrationEngineShape) =>
  engine.dispatch({
    type: "space.create",
    commandId: CommandId.makeUnsafe("cmd-space-orchestration-engine-test"),
    spaceId: TEST_SPACE_ID,
    name: "Test",
    icon: "home",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

async function createOrchestrationSystem(options?: {
  readonly withRuntimeBinding?: boolean;
  readonly onLog?: (message: string, annotations: Record<string, unknown>) => void;
  readonly beforeThreadDetail?: (threadId: ThreadId) => Effect.Effect<void>;
}) {
  const ServerConfigLayer = TestServerConfigLayer;
  const snapshotQueryLayer = options?.beforeThreadDetail
    ? Layer.effect(
        ProjectionSnapshotQuery,
        Effect.map(Effect.service(ProjectionSnapshotQuery), (query) => ({
          ...query,
          getThreadDetailById: (threadId) =>
            options.beforeThreadDetail!(threadId).pipe(
              Effect.andThen(query.getThreadDetailById(threadId)),
            ),
        })),
      ).pipe(Layer.provide(OrchestrationProjectionSnapshotQueryLive))
    : OrchestrationProjectionSnapshotQueryLive;
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(snapshotQueryLayer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const configuredLayer = options?.withRuntimeBinding
    ? orchestrationLayer.pipe(
        Layer.provideMerge(
          Layer.succeed(ThreadProviderBindingRepository, {
            getRuntimeBinding: (threadId: ThreadId) =>
              Effect.succeed(
                Option.some({
                  threadId,
                  connectionId: null,
                  installationId: "test-installation",
                  internalProviderId: null,
                  modelId: "gpt-5-codex",
                  revision: 0,
                  createdAt: now(),
                  updatedAt: now(),
                }),
              ),
          } as never),
        ),
      )
    : orchestrationLayer;
  const runtime = ManagedRuntime.make(
    options?.onLog
      ? configuredLayer.pipe(
          Layer.provideMerge(
            Logger.layer(
              [
                Logger.make(({ message, fiber }) =>
                  options.onLog?.(String(message), fiber.getRef(References.CurrentLogAnnotations)),
                ),
              ],
              { mergeWithExisting: false },
            ),
          ),
        )
      : configuredLayer,
  );
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  await runtime.runPromise(createTestSpace(engine));
  const managedAttachmentRepository = await runtime.runPromise(
    Effect.service(ManagedAttachmentRepository),
  );
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  return {
    engine,
    sql,
    managedAttachmentRepository,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return new Date().toISOString();
}

describe("OrchestrationEngine", () => {
  it("commits an unrelated command while another thread detail read is slow", async () => {
    const threadA = ThreadId.makeUnsafe("thread-slow-command-a");
    let releaseSlowRead!: () => void;
    const slowReadReleased = new Promise<void>((resolve) => {
      releaseSlowRead = resolve;
    });
    let signalSlowReadEntered!: () => void;
    const slowReadEntered = new Promise<void>((resolve) => {
      signalSlowReadEntered = resolve;
    });
    const system = await createOrchestrationSystem({
      beforeThreadDetail: (threadId) =>
        threadId === threadA
          ? Effect.promise(() => {
              signalSlowReadEntered();
              return slowReadReleased;
            })
          : Effect.void,
    });
    try {
      await system.run(
        system.engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("cmd-slow-command-folder-a"),
          folderId: asFolderId("folder-slow-command-a"),
          title: "Folder A",
          workspaceRoot: null,
          spaceId: TEST_SPACE_ID,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-slow-command-thread-a"),
          threadId: threadA,
          deckId: singletonThreadDeckId(threadA),
          folderId: asFolderId("folder-slow-command-a"),
          title: "Thread A",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          workingDirectory: null,
          createdAt: now(),
        }),
      );
      const slow = system.run(
        system.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-slow-command-archive-a"),
          threadId: threadA,
          createdAt: now(),
        }),
      );
      await slowReadEntered;
      let unrelatedCompleted = false;
      const unrelated = system.run(
        system.engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("cmd-slow-command-folder-b"),
          folderId: asFolderId("folder-slow-command-b"),
          title: "Folder B",
          workspaceRoot: null,
          spaceId: TEST_SPACE_ID,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt: now(),
        }),
      );
      unrelated.then(() => {
        unrelatedCompleted = true;
      });
      let sameThreadSettled = false;
      const sameThread = system
        .run(
          system.engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.makeUnsafe("cmd-slow-command-archive-a-again"),
            threadId: threadA,
            createdAt: now(),
          }),
        )
        .then(
          () => {
            sameThreadSettled = true;
          },
          () => {
            sameThreadSettled = true;
          },
        );
      await vi.waitFor(() => expect(unrelatedCompleted).toBe(true), { timeout: 2_000 });
      expect(sameThreadSettled).toBe(false);
      releaseSlowRead();
      await Promise.all([slow, unrelated, sameThread]);
      expect(unrelatedCompleted).toBe(true);
      expect(sameThreadSettled).toBe(true);
    } finally {
      releaseSlowRead();
      await system.dispose();
    }
  }, 10_000);

  it("identifies the active command stage when SQLite holds the worker for five seconds", async () => {
    const logs: Array<{ message: string; annotations: Record<string, unknown> }> = [];
    const system = await createOrchestrationSystem({
      onLog: (message, annotations) => logs.push({ message, annotations }),
    });
    let releaseTransaction!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    try {
      const holder = system.run(
        system.sql.withTransaction(
          Effect.promise(() => {
            signalAcquired();
            return release;
          }),
        ),
      );
      await acquired;
      const commandId = CommandId.makeUnsafe("cmd-slow-worker-stage");
      const pending = system.run(
        system.engine.dispatch({
          type: "folder.create",
          commandId,
          folderId: asFolderId("folder-slow-worker-stage"),
          title: "Slow worker stage",
          workspaceRoot: null,
          spaceId: TEST_SPACE_ID,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt: now(),
        }),
      );
      await vi.waitFor(
        () =>
          expect(logs).toContainEqual({
            message: "orchestration command worker slow stage",
            annotations: expect.objectContaining({
              commandId,
              stage: "receipt-lookup",
            }),
          }),
        { timeout: 7_000 },
      );
      releaseTransaction();
      await Promise.all([holder, pending]);
      expect(logs).toContainEqual({
        message: "sqlite transaction held connection",
        annotations: expect.objectContaining({
          ownerFiberId: expect.any(Number),
          holdMs: expect.any(Number),
        }),
      });
    } finally {
      releaseTransaction();
      await system.dispose();
    }
  }, 10_000);

  it.each(["assistant", "delivery"] as const)(
    "projects a %s completion before an interrupted session as interrupted",
    async (completion) => {
      const system = await createOrchestrationSystem({ withRuntimeBinding: true });
      const threadId = ThreadId.makeUnsafe(`thread-${completion}-interrupted-order`);
      const folderId = asFolderId(`folder-${completion}-interrupted-order`);
      const turnId = asTurnId(`turn-${completion}-interrupted-order`);
      const messageId = asMessageId(`message-${completion}-interrupted-order`);
      const createdAt = now();
      try {
        await system.run(
          system.engine.dispatch({
            type: "folder.create",
            commandId: CommandId.makeUnsafe(`folder-${completion}-order`),
            folderId,
            spaceId: TEST_SPACE_ID,
            title: "Ordering",
            workspaceRoot: null,
            defaultModelSelection: null,
            createdAt,
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`thread-${completion}-order`),
            threadId,
            deckId: singletonThreadDeckId(threadId),
            folderId,
            title: "Ordering",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            createdAt,
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`start-${completion}-order`),
            threadId,
            message: { messageId, role: "user", text: "Work", attachments: [] },
            runtimeMode: "full-access",
            createdAt,
          }),
        );
        const session = {
          threadId,
          providerName: "codex" as const,
          runtimeMode: "full-access" as const,
          activeTurnId: turnId,
          lastError: null,
          updatedAt: createdAt,
        };
        await system.run(
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(`running-${completion}-order`),
            threadId,
            session: { ...session, status: "running" },
            createdAt,
          }),
        );
        if (completion === "assistant") {
          await system.run(
            system.engine.dispatch({
              type: "thread.message.assistant.complete",
              commandId: CommandId.makeUnsafe("assistant-complete-order"),
              threadId,
              messageId: asMessageId("assistant-order"),
              turnId,
              finalText: "Partial reply",
              createdAt,
            }),
          );
        } else {
          await system.run(
            system.engine.dispatch({
              type: "thread.message.delivery.set",
              commandId: CommandId.makeUnsafe("delivery-complete-order"),
              threadId,
              messageId,
              turnId,
              state: "accepted",
              terminalState: "completed",
              terminalCompletedAt: createdAt,
              createdAt,
            }),
          );
        }
        await system.run(
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(`interrupted-${completion}-order`),
            threadId,
            session: { ...session, status: "interrupted", activeTurnId: null },
            createdAt,
          }),
        );
        const turns = await system.run(
          system.sql<{
            readonly state: string;
          }>`SELECT state FROM projection_turns WHERE thread_id = ${threadId} ORDER BY requested_at DESC`,
        );
        expect(turns[0]?.state).toBe("interrupted");
        const readModel = await system.run(system.engine.getReadModel());
        expect(readModel.threads.find((thread) => thread.id === threadId)?.latestTurn?.state).toBe(
          "interrupted",
        );
        if (completion === "assistant") {
          const interruptedTurnId = readModel.threads.find((thread) => thread.id === threadId)
            ?.latestTurn?.turnId;
          expect(interruptedTurnId).toBeDefined();
          await expect(
            system.run(
              system.engine.dispatch({
                type: "thread.turn.recover",
                reason: "play",
                commandId: CommandId.makeUnsafe("play-after-assistant-order"),
                threadId,
                turnId: interruptedTurnId!,
                interruptedTurnId: interruptedTurnId!,
                recoveryMessageId: asMessageId("recovery-after-assistant-order"),
                connectionId: null,
                bindingRevision: 0,
                createdAt,
              }),
            ),
          ).resolves.toMatchObject({ sequence: expect.any(Number) });
        }
      } finally {
        await system.dispose();
      }
    },
  );
  it("refuses a send to an archived thread without creating a turn, and drops queued rows on archive", async () => {
    const system = await createOrchestrationSystem({ withRuntimeBinding: true });
    const threadId = ThreadId.makeUnsafe("thread-archived-engine-guard");
    const folderId = asFolderId("folder-archived-engine-guard");
    const createdAt = now();
    const queuedMessageId = asMessageId("queued-before-archive");
    try {
      await system.run(
        system.engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("archive-folder"),
          folderId,
          spaceId: TEST_SPACE_ID,
          title: "Archive guard",
          workspaceRoot: null,
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("archive-thread"),
          threadId,
          deckId: singletonThreadDeckId(threadId),
          folderId,
          title: "Archive guard",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          createdAt,
        }),
      );
      const imported = await system.run(
        system.engine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe("archive-import"),
          threadId,
          messages: [
            {
              messageId: queuedMessageId,
              role: "user",
              text: "queued",
              createdAt,
              updatedAt: createdAt,
            },
          ],
          createdAt,
        }),
      );
      await system.run(system.sql`
        INSERT INTO queued_turn_promotions (
          queued_event_sequence, thread_id, message_id, dispatch_mode, state,
          attempt_count, created_at, updated_at, action_kind, action_event_id
        ) VALUES (${imported.sequence}, ${threadId}, ${queuedMessageId}, 'queue', 'queued', 0, ${createdAt}, ${createdAt}, 'cancel', 'stale-action')
      `);
      await system.run(
        system.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("archive-command"),
          threadId,
        }),
      );
      const archived = (await system.run(system.engine.getReadModel())).threads.find(
        (thread) => thread.id === threadId,
      );
      expect(archived?.archivedAt).toBeDefined();
      const queueRows = await system.run(
        system.sql<{
          readonly state: string;
          readonly updatedAt: string;
          readonly actionKind: string | null;
          readonly actionEventId: string | null;
        }>`SELECT state, updated_at AS "updatedAt", action_kind AS "actionKind", action_event_id AS "actionEventId" FROM queued_turn_promotions WHERE thread_id = ${threadId}`,
      );
      expect(queueRows).toMatchObject([
        {
          state: "cancelled",
          updatedAt: archived?.archivedAt,
          actionKind: null,
          actionEventId: null,
        },
      ]);
      const messages = await system.run(
        system.sql<{
          readonly messageId: string;
        }>`SELECT message_id AS "messageId" FROM projection_thread_messages WHERE thread_id = ${threadId} AND message_id = ${queuedMessageId}`,
      );
      expect(messages).toHaveLength(0);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("send-archived-command"),
            threadId,
            message: {
              messageId: asMessageId("send-archived-message"),
              role: "user",
              text: "Continue",
              attachments: [],
            },
            runtimeMode: "full-access",
            createdAt,
          }),
        ),
      ).rejects.toMatchObject({ code: "thread_archived" });
      const turns = await system.run(
        system.sql<{
          readonly turnId: string;
        }>`SELECT turn_id AS "turnId" FROM projection_turns WHERE thread_id = ${threadId}`,
      );
      expect(turns).toHaveLength(0);
      await system.run(
        system.engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe("unarchive-after-queue-drop"),
          threadId,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("send-after-unarchive"),
          threadId,
          message: {
            messageId: asMessageId("new-after-unarchive"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          createdAt,
        }),
      );
      const acceptedTurns = await system.run(system.sql<{ readonly state: string }>`
        SELECT state FROM projection_turns WHERE thread_id = ${threadId}
      `);
      expect(acceptedTurns).toMatchObject([{ state: "running" }]);
    } finally {
      await system.dispose();
    }
  });

  it("refuses archive during a provider turn and quietly skips an archived restart recovery", async () => {
    const system = await createOrchestrationSystem({ withRuntimeBinding: true });
    const threadId = ThreadId.makeUnsafe("thread-archive-running-engine");
    const folderId = asFolderId("folder-archive-running-engine");
    const turnId = asTurnId("turn-archive-running-engine");
    const createdAt = now();
    try {
      await system.run(
        system.engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("running-folder"),
          folderId,
          spaceId: TEST_SPACE_ID,
          title: "Running guard",
          workspaceRoot: null,
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("running-thread"),
          threadId,
          deckId: singletonThreadDeckId(threadId),
          folderId,
          title: "Running guard",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          createdAt,
        }),
      );
      const session = {
        threadId,
        providerName: "codex" as const,
        runtimeMode: "full-access" as const,
        activeTurnId: turnId,
        lastError: null,
        updatedAt: createdAt,
      };
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("running-session"),
          threadId,
          session: { ...session, status: "running" },
          createdAt,
        }),
      );
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.makeUnsafe("archive-running"),
            threadId,
          }),
        ),
      ).rejects.toMatchObject({ code: "thread_running" });
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("stopped-session"),
          threadId,
          session: { ...session, status: "stopped", activeTurnId: null },
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("archive-stopped"),
          threadId,
        }),
      );
      await system.run(
        system.sql`INSERT OR REPLACE INTO restart_turn_recoveries (thread_id, turn_id, requested_at, updated_at) VALUES (${threadId}, ${turnId}, ${createdAt}, ${createdAt})`,
      );
      await system.run(
        recoverRestartInterruptedTurns.pipe(
          Effect.provideService(OrchestrationEngineService, system.engine),
          Effect.provideService(SqlClient.SqlClient, system.sql),
        ),
      );
      const recoveries = await system.run(
        system.sql`SELECT thread_id FROM restart_turn_recoveries WHERE thread_id = ${threadId}`,
      );
      expect(recoveries).toHaveLength(0);
    } finally {
      await system.dispose();
    }
  });
  it("admits Play after a started turn is interrupted by user Stop", async () => {
    const system = await createOrchestrationSystem({ withRuntimeBinding: true });
    const threadId = ThreadId.makeUnsafe("thread-play-after-user-stop");
    const folderId = asFolderId("folder-play-after-user-stop");
    const turnId = asTurnId("turn-play-after-user-stop");
    const requestedAt = "2026-09-26T21:04:38.548Z";
    const startedAt = "2026-09-26T21:04:38.903Z";
    const stoppedAt = "2026-09-26T21:04:49.812Z";
    try {
      await system.run(
        system.engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("cmd-play-stop-folder"),
          folderId,
          spaceId: TEST_SPACE_ID,
          title: "Play after Stop",
          workspaceRoot: null,
          defaultModelSelection: null,
          createdAt: requestedAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-play-stop-thread"),
          threadId,
          deckId: singletonThreadDeckId(threadId),
          folderId,
          title: "Play after Stop",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          createdAt: requestedAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-play-stop-start"),
          threadId,
          turnId,
          message: {
            messageId: asMessageId("msg-play-stop"),
            role: "user",
            text: "Finish the task",
            attachments: [],
          },
          runtimeMode: "full-access",
          connectionId: null,
          bindingRevision: 0,
          createdAt: requestedAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-play-stop-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: startedAt,
          },
          createdAt: startedAt,
        }),
      );
      const queued = await system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-play-stop-queued"),
          threadId,
          message: {
            messageId: asMessageId("msg-play-stop-queued"),
            role: "user",
            text: "Follow up after this turn",
            attachments: [],
          },
          runtimeMode: "full-access",
          connectionId: null,
          bindingRevision: 0,
          createdAt: stoppedAt,
        }),
      );
      await system.run(system.sql`
        INSERT INTO queued_turn_promotions (
          queued_event_sequence, thread_id, message_id, dispatch_mode, state,
          claim_owner, claimed_at, claim_expires_at, attempt_count, created_at, updated_at, promoted_at
        ) VALUES (${queued.sequence}, ${threadId}, ${asMessageId("msg-play-stop-queued")}, 'queue', 'queued', NULL, NULL, NULL, 0, ${stoppedAt}, ${stoppedAt}, NULL)
      `);
      await system.run(
        system.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-play-stop-interrupt"),
          threadId,
          turnId,
          createdAt: stoppedAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-play-stop-terminal"),
          threadId,
          session: {
            threadId,
            status: "interrupted",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: stoppedAt,
          },
          createdAt: stoppedAt,
        }),
      );
      const thread = (await system.run(system.engine.getReadModel())).threads.find(
        (candidate) => candidate.id === threadId,
      )!;
      expect(thread.latestTurn).toMatchObject({ turnId, state: "interrupted" });
      for (const dispatchMode of ["queue", "steer"] as const) {
        await expect(
          system.run(
            system.engine.dispatch({
              type: "thread.turn.dispatch-queued",
              commandId: CommandId.makeUnsafe(`cmd-stopped-dispatch-${dispatchMode}`),
              threadId,
              turnId: asTurnId(`turn-stopped-dispatch-${dispatchMode}`),
              messageId: asMessageId("msg-play-stop-queued"),
              dispatchMode,
              runtimeMode: "full-access",
              createdAt: stoppedAt,
            }),
          ),
        ).rejects.toMatchObject({ code: "queued_turn_stopped" });
      }
      expect(
        canContinueLatestTurn(
          { ...thread, queuedMessageIds: [asMessageId("msg-play-stop-queued")] },
          turnId,
        ),
      ).toBe(true);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.recover",
            reason: "play",
            commandId: CommandId.makeUnsafe("cmd-play-stop-recover"),
            threadId,
            turnId,
            interruptedTurnId: turnId,
            recoveryMessageId: asMessageId("msg-play-stop-recovery"),
            connectionId: null,
            bindingRevision: 0,
            createdAt: stoppedAt,
          }),
        ),
      ).resolves.toMatchObject({ sequence: expect.any(Number) });
      const stillQueued = await system.run(system.sql<{ readonly state: string }>`
        SELECT state FROM queued_turn_promotions WHERE thread_id = ${threadId}
      `);
      expect(stillQueued).toEqual([{ state: "queued" }]);
    } finally {
      await system.dispose();
    }
  });

  it("rejects Play through the engine with a pending approval", async () => {
    const blocker = "pending approval";
    const system = await createOrchestrationSystem({ withRuntimeBinding: true });
    const threadId = ThreadId.makeUnsafe(`thread-play-${blocker}`);
    const turnId = asTurnId(`turn-play-${blocker}`);
    const createdAt = now();
    try {
      await system.run(
        system.engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe(`cmd-play-folder-${blocker}`),
          folderId: asFolderId(`folder-play-${blocker}`),
          spaceId: TEST_SPACE_ID,
          title: "Play test",
          workspaceRoot: null,
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`cmd-play-thread-${blocker}`),
          threadId,
          deckId: singletonThreadDeckId(threadId),
          folderId: asFolderId(`folder-play-${blocker}`),
          title: "Play test",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          createdAt,
        }),
      );
      const session = {
        threadId,
        providerName: "codex" as const,
        runtimeMode: "full-access" as const,
        activeTurnId: turnId,
        lastError: null,
        updatedAt: createdAt,
      };
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(`cmd-play-running-${blocker}`),
          threadId,
          session: { ...session, status: "running" },
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(`cmd-play-stopped-${blocker}`),
          threadId,
          session: { ...session, status: "stopped", activeTurnId: null },
          createdAt,
        }),
      );
      await system.run(system.sql`
            INSERT INTO projection_pending_interactions (
              interaction_kind, request_id, thread_id, turn_id, lifecycle_generation,
              status, decision, response_command_id, response_requested_at, created_at, resolved_at
            ) VALUES ('approval', 'real-pending-play-approval', ${threadId}, ${turnId}, NULL,
              'pending', NULL, NULL, NULL, ${createdAt}, NULL)
          `);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.recover",
            reason: "play",
            commandId: CommandId.makeUnsafe(`cmd-play-blocked-${blocker}`),
            threadId,
            turnId,
            interruptedTurnId: turnId,
            recoveryMessageId: asMessageId(`recovery-play-blocked-${blocker}`),
            connectionId: null,
            bindingRevision: 0,
            createdAt,
          }),
        ),
      ).rejects.toMatchObject({ code: "THREAD_CONTINUE_STALE" });
    } finally {
      await system.dispose();
    }
  });
  it("admits at most one of two concurrent Play commands for the same latest turn", async () => {
    const system = await createOrchestrationSystem({ withRuntimeBinding: true });
    const threadId = ThreadId.makeUnsafe("thread-concurrent-play");
    const folderId = asFolderId("project-concurrent-play");
    const turnId = asTurnId("turn-concurrent-play");
    const createdAt = now();
    try {
      await system.run(
        system.engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("cmd-concurrent-play-folder"),
          folderId,
          spaceId: TEST_SPACE_ID,
          title: "Concurrent Play",
          workspaceRoot: null,
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-concurrent-play-thread"),
          threadId,
          deckId: singletonThreadDeckId(threadId),
          folderId,
          title: "Concurrent Play thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          createdAt,
        }),
      );
      const session = {
        threadId,
        providerName: "codex" as const,
        runtimeMode: "full-access" as const,
        activeTurnId: turnId,
        lastError: null,
        updatedAt: createdAt,
      };
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-concurrent-play-running"),
          threadId,
          session: { ...session, status: "running" },
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-concurrent-play-stopped"),
          threadId,
          session: { ...session, status: "stopped", activeTurnId: null },
          createdAt,
        }),
      );
      const play = (index: number) =>
        system.run(
          system.engine.dispatch({
            type: "thread.turn.recover",
            reason: "play",
            commandId: CommandId.makeUnsafe(`cmd-concurrent-play-${index}`),
            threadId,
            turnId,
            interruptedTurnId: turnId,
            recoveryMessageId: MessageId.makeUnsafe(`message-concurrent-play-${index}`),
            connectionId: null,
            bindingRevision: 0,
            createdAt,
          }),
        );
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.recover",
            reason: "play",
            commandId: CommandId.makeUnsafe("cmd-concurrent-play-stale-binding"),
            threadId,
            turnId,
            interruptedTurnId: turnId,
            recoveryMessageId: MessageId.makeUnsafe("message-concurrent-play-stale-binding"),
            connectionId: null,
            bindingRevision: 1,
            createdAt,
          }),
        ),
      ).rejects.toMatchObject({ code: "THREAD_CONTINUE_STALE" });
      const results = await Promise.allSettled([play(1), play(2)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const readModel = await system.run(system.engine.getCommandReadModel());
      expect(
        readModel.threads.find((thread) => thread.id === threadId)?.pendingTurnStartMessageId,
      ).not.toBeNull();
    } finally {
      await system.dispose();
    }
  });

  it("quiesces normal admission while draining reserved lifecycle commands", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const threadId = ThreadId.makeUnsafe("thread-engine-quiesce");

    await system.run(
      system.engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-engine-quiesce-project"),
        folderId: asFolderId("project-engine-quiesce"),
        spaceId: TEST_SPACE_ID,
        title: "Engine quiesce",
        workspaceRoot: null,
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-engine-quiesce-thread"),
        threadId,
        deckId: singletonThreadDeckId(threadId),
        folderId: asFolderId("project-engine-quiesce"),
        title: "Engine quiesce thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await system.run(system.engine.quiesce);
    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.update",
          commandId: CommandId.makeUnsafe("cmd-engine-quiesce-normal"),
          threadId,
          title: "Rejected after quiesce",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandAdmissionError",
      reason: "stopped",
    });

    // A turn start takes the priority `user` lane, but priority is not
    // admissibility: the WebSocket keeps serving while the engine quiesces, and
    // starting a provider turn here would spawn a session the shutdown fences
    // moments later, orphaning the turn.
    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-engine-quiesce-turn-start"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("msg-engine-quiesce-turn-start"),
            role: "user",
            text: "Rejected after quiesce",
            attachments: [],
          },
          runtimeMode: "approval-required",
          createdAt,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandAdmissionError",
      reason: "stopped",
    });

    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("cmd-engine-quiesce-control"),
          threadId,
          createdAt,
        }),
      ),
    ).resolves.toMatchObject({ sequence: expect.any(Number) });
    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("cmd-engine-quiesce-provider-terminal"),
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-engine-quiesce-provider-terminal"),
            tone: "info",
            kind: "turn.completed",
            summary: "Provider turn completed during shutdown",
            payload: {},
            turnId: null,
            createdAt,
          },
          createdAt,
        }),
      ),
    ).resolves.toMatchObject({ sequence: expect.any(Number) });
    await system.run(system.engine.drain);
    await system.run(system.engine.stop);

    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-engine-stopped-control"),
          threadId,
          createdAt,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandAdmissionError",
      reason: "stopped",
    });

    await system.dispose();
  });

  it("returns the original result for an equal retry and rejects unequal command-ID reuse", async () => {
    const system = await createOrchestrationSystem();
    const command = {
      type: "folder.create" as const,
      kind: "folder" as const,
      commandId: CommandId.makeUnsafe("cmd-fingerprint-retry"),
      folderId: asFolderId("project-fingerprint-retry"),
      spaceId: TEST_SPACE_ID,
      title: "Fingerprint project",
      workspaceRoot: null,
      defaultModelSelection: null,
      createdAt: "2026-07-14T00:00:00.000Z",
    };

    const first = await system.run(system.engine.dispatch(command));
    await expect(system.run(system.engine.dispatch({ ...command }))).resolves.toEqual(first);
    await expect(
      system.run(
        system.engine.dispatch({
          ...command,
          title: "Different command content",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandIdentityCollisionError",
      commandId: command.commandId,
    });

    const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
    expect(
      Array.from(events).filter((event) => event.commandId === command.commandId),
    ).toHaveLength(1);
    await system.dispose();
  });

  it("returns deterministic read models for repeated reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-project-1-create"),
        folderId: asFolderId("project-1"),
        spaceId: TEST_SPACE_ID,
        title: "Project 1",
        workspaceRoot: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-1-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        deckId: singletonThreadDeckId(ThreadId.makeUnsafe("thread-1")),
        folderId: asFolderId("project-1"),
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.run(engine.getCommandReadModel());
    const readModelB = await system.run(engine.getCommandReadModel());
    // Reads are an O(1) view of the engine-owned command model. Returning a
    // distinct object here means a caller rehydrated the projection database.
    expect(readModelB).toBe(readModelA);
    await system.dispose();
  });

  it("returns the original sequence for equal retries and rejects unequal command-id reuse", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const command = {
      type: "folder.create" as const,
      kind: "folder" as const,
      commandId: CommandId.makeUnsafe("cmd-project-command-identity"),
      folderId: asFolderId("project-command-identity"),
      spaceId: TEST_SPACE_ID,
      title: "Original identity",
      workspaceRoot: null,
      defaultModelSelection: null,
      createdAt: now(),
    };

    const accepted = await system.run(engine.dispatch(command));
    await expect(system.run(engine.dispatch(command))).resolves.toEqual(accepted);
    await expect(
      system.run(engine.dispatch({ ...command, title: "Different identity" })),
    ).rejects.toThrow("Command identity collision");

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    expect(events).toHaveLength(2);
    expect((await system.run(engine.getReadModel())).folders[0]?.title).toBe("Original identity");
    await system.dispose();
  });

  it("claims managed attachments atomically and rejects attachment changes on an accepted retry", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const threadId = ThreadId.makeUnsafe("thread-managed-attachment");
    const commandId = CommandId.makeUnsafe("cmd-managed-attachment-turn");
    const messageId = asMessageId("msg-managed-attachment");
    const principal = { ownerKind: "session" as const, ownerId: "session-a" };

    await system.run(
      engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-managed-attachment-project"),
        folderId: asFolderId("project-managed-attachment"),
        spaceId: TEST_SPACE_ID,
        title: "Managed attachment project",
        workspaceRoot: null,
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-managed-attachment-thread"),
        threadId,
        deckId: singletonThreadDeckId(threadId),
        folderId: asFolderId("project-managed-attachment"),
        title: "Managed attachment thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const repository = system.managedAttachmentRepository;
    const stage = async (attachmentId: string) => {
      const reserved = await system.run(
        repository.reserve({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          kind: "image",
          originalName: `${attachmentId}.png`,
          mimeType: "image/png",
          reservedBytes: 1,
          relativePath: `objects/aa/${attachmentId}.png`,
          now: createdAt,
        }),
      );
      expect(reserved.status).toBe("reserved");
      await system.run(
        repository.finalizeStaged({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          sizeBytes: 1,
          sha256: "a".repeat(64),
          stagingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          now: createdAt,
        }),
      );
    };
    const firstAttachmentId = "att_v2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const secondAttachmentId = "att_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await stage(firstAttachmentId);
    await stage(secondAttachmentId);

    const command = {
      type: "thread.turn.start" as const,
      commandId,
      threadId,
      message: {
        messageId,
        role: "user" as const,
        text: "inspect",
        attachments: [
          {
            type: "image" as const,
            id: firstAttachmentId,
            name: "client-value-is-not-authoritative.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ],
      },
      runtimeMode: "approval-required" as const,
      createdAt,
    };
    const accepted = await system.run(engine.dispatch(command, { attachmentPrincipal: principal }));
    await expect(
      system.run(engine.dispatch(command, { attachmentPrincipal: principal })),
    ).resolves.toEqual(accepted);

    const editResendClaim = await system.run(
      repository.claimForAcceptedTurn({
        attachmentIds: [firstAttachmentId],
        ownerThreadId: threadId,
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
        commandId: "cmd-attachment-edit-resend",
        messageId,
        now: new Date().toISOString(),
      }),
    );
    expect(editResendClaim.status).toBe("claimed");
    await expect(
      system.run(engine.dispatch(command, { attachmentPrincipal: principal })),
    ).resolves.toEqual(accepted);

    await expect(
      system.run(
        engine.dispatch(
          {
            ...command,
            message: {
              ...command.message,
              attachments: [{ ...command.message.attachments[0]!, id: secondAttachmentId }],
            },
          },
          { attachmentPrincipal: principal },
        ),
      ),
    ).rejects.toThrow("Command identity collision");

    const claimed = await system.run(repository.findClaimedForCommand({ commandId }));
    expect(claimed.map((attachment) => attachment.attachmentId)).toEqual([firstAttachmentId]);
    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-project-replay-create"),
        folderId: asFolderId("project-replay"),
        spaceId: TEST_SPACE_ID,
        title: "Replay Project",
        workspaceRoot: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-replay-create"),
        threadId: ThreadId.makeUnsafe("thread-replay"),
        deckId: singletonThreadDeckId(ThreadId.makeUnsafe("thread-replay")),
        folderId: asFolderId("project-replay"),
        title: "replay",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-replay-delete"),
        threadId: ThreadId.makeUnsafe("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "space.created",
      "folder.created",
      "thread.created",
      "thread.deleted",
    ]);
    const outboxJobs = await system.run(
      system.sql<{ readonly eventSequence: number; readonly eventType: string }>`
        SELECT event_sequence AS "eventSequence", event_type AS "eventType"
        FROM provider_intent_outbox ORDER BY event_sequence
      `,
    );
    expect(outboxJobs).toEqual([
      { eventSequence: events[2]!.sequence, eventType: "thread.created" },
      { eventSequence: events[3]!.sequence, eventType: "thread.deleted" },
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-project-stream-create"),
        folderId: asFolderId("project-stream"),
        spaceId: TEST_SPACE_ID,
        title: "Stream Project",
        workspaceRoot: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-stream-thread-create"),
          threadId: ThreadId.makeUnsafe("thread-stream"),
          deckId: singletonThreadDeckId(ThreadId.makeUnsafe("thread-stream")),
          folderId: asFolderId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.update",
          commandId: CommandId.makeUnsafe("cmd-stream-thread-update"),
          threadId: ThreadId.makeUnsafe("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.updated"]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.makeUnsafe("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      getHighWaterSequence() {
        return Effect.succeed(events.at(-1)?.sequence ?? 0);
      },
      ...makeThreadEventReadMethods(events),
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    await runtime.runPromise(createTestSpace(engine));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-project-flaky-create"),
        folderId: asFolderId("project-flaky"),
        spaceId: TEST_SPACE_ID,
        title: "Flaky Project",
        workspaceRoot: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-flaky-1"),
          threadId: ThreadId.makeUnsafe("thread-flaky-fail"),
          deckId: singletonThreadDeckId(ThreadId.makeUnsafe("thread-flaky-fail")),
          folderId: asFolderId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          createdAt,
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-flaky-2"),
        threadId: ThreadId.makeUnsafe("thread-flaky-ok"),
        deckId: singletonThreadDeckId(ThreadId.makeUnsafe("thread-flaky-ok")),
        folderId: asFolderId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    expect(result.sequence).toBe(3);
    expect((await runtime.runPromise(engine.getCommandReadModel())).snapshotSequence).toBe(3);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      folderMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
      projectDeferredEvent: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    await runtime.runPromise(createTestSpace(engine));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-project-atomic-create"),
        folderId: asFolderId("project-atomic"),
        spaceId: TEST_SPACE_ID,
        title: "Atomic Project",
        workspaceRoot: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-atomic-create"),
        threadId: ThreadId.makeUnsafe("thread-atomic"),
        deckId: singletonThreadDeckId(ThreadId.makeUnsafe("thread-atomic")),
        folderId: asFolderId("project-atomic"),
        title: "atomic",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.makeUnsafe("cmd-turn-start-atomic"),
      threadId: ThreadId.makeUnsafe("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "failed unexpectedly",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "space.created",
      "folder.created",
      "thread.created",
    ]);
    // The failed command must not advance the in-memory model past the last
    // durable event. The projection pipeline in this test is intentionally a
    // no-op, so a database snapshot would report zero and mask this invariant.
    expect((await runtime.runPromise(engine.getCommandReadModel())).snapshotSequence).toBe(3);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(5);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "space.created",
      "folder.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("keeps processing later commands after an unexpected worker defect", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      getHighWaterSequence() {
        return Effect.succeed(events.at(-1)?.sequence ?? 0);
      },
      ...makeThreadEventReadMethods(events),
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldDieProjection = true;
    const defectiveProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      folderMetadataEvent: (event) => {
        if (
          shouldDieProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-project-defect-1")
        ) {
          shouldDieProjection = false;
          return Effect.die("projection defect");
        }
        return Effect.void;
      },
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
      projectDeferredEvent: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, defectiveProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    await runtime.runPromise(createTestSpace(engine));
    const createdAt = now();

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("cmd-project-defect-1"),
          folderId: asFolderId("project-defect-1"),
          spaceId: TEST_SPACE_ID,
          title: "Defective Project",
          workspaceRoot: null,
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("cmd-project-defect-2"),
          folderId: asFolderId("project-defect-2"),
          spaceId: TEST_SPACE_ID,
          title: "Recovered Project",
          workspaceRoot: null,
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        sequence: expect.any(Number),
      }),
    );

    const eventsAfterRecovery = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRecovery.map((event) => event.commandId)).toEqual([
      CommandId.makeUnsafe("cmd-space-orchestration-engine-test"),
      CommandId.makeUnsafe("cmd-project-defect-1"),
      CommandId.makeUnsafe("cmd-project-defect-2"),
    ]);
    expect(eventsAfterRecovery.slice(1).every((event) => event.type === "folder.created")).toBe(
      true,
    );

    await runtime.dispose();
  });

  it("reconciles in-memory state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      getHighWaterSequence() {
        return Effect.succeed(events.at(-1)?.sequence ?? 0);
      },
      ...makeThreadEventReadMethods(events),
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      folderMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-thread-meta-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
      projectDeferredEvent: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    await runtime.runPromise(createTestSpace(engine));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-project-sync-create"),
        folderId: asFolderId("project-sync"),
        spaceId: TEST_SPACE_ID,
        title: "Sync Project",
        workspaceRoot: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-sync-create"),
        threadId: ThreadId.makeUnsafe("thread-sync"),
        deckId: singletonThreadDeckId(ThreadId.makeUnsafe("thread-sync")),
        folderId: asFolderId("project-sync"),
        title: "sync-before",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.update",
          commandId: CommandId.makeUnsafe("cmd-thread-meta-sync-fail"),
          threadId: ThreadId.makeUnsafe("thread-sync"),
          title: "sync-after-failed-projection",
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.at(-1)?.type).toBe("thread.updated");
    expect(eventsAfterFailure.at(-1)?.sequence).toBe(4);

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-invariant-missing-thread"),
          threadId: ThreadId.makeUnsafe("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("retries deferred projection catch-up while idle until it recovers", async () => {
    let bootstrapCalls = 0;
    let deferredCalls = 0;
    let resolveRecoveryBootstrap: (() => void) | null = null;
    const recoveryBootstrap = new Promise<void>((resolve) => {
      resolveRecoveryBootstrap = resolve;
    });

    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.suspend(() => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 2 || bootstrapCalls === 3) {
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.deferredProjectionBootstrap",
              detail: "deferred projection bootstrap failed transiently",
            }),
          );
        }
        if (bootstrapCalls === 4) {
          resolveRecoveryBootstrap?.();
        }
        return Effect.void;
      }),
      folderMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
      projectDeferredEvent: () => {
        deferredCalls += 1;
        if (deferredCalls === 1) {
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.deferredProjection",
              detail: "deferred projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    await runtime.runPromise(createTestSpace(engine));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-project-deferred-recovery"),
        folderId: asFolderId("project-deferred-recovery"),
        spaceId: TEST_SPACE_ID,
        title: "Deferred Recovery Project",
        workspaceRoot: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-deferred-recovery"),
        threadId: ThreadId.makeUnsafe("thread-deferred-recovery"),
        deckId: singletonThreadDeckId(ThreadId.makeUnsafe("thread-deferred-recovery")),
        folderId: asFolderId("project-deferred-recovery"),
        title: "deferred-recovery",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-deferred-recovery"),
        threadId: ThreadId.makeUnsafe("thread-deferred-recovery"),
        message: {
          messageId: asMessageId("msg-deferred-recovery"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await recoveryBootstrap;

    expect(result.sequence).toBe(5);
    expect(deferredCalls).toBeGreaterThanOrEqual(1);
    expect(bootstrapCalls).toBe(4);
    await vi.waitFor(async () => {
      expect(await runtime.runPromise(engine.getProjectionCatchUpStatus)).toEqual({
        state: "healthy",
        inFlight: false,
        retryAttempts: 0,
        lastFailure: null,
      });
    });

    await runtime.dispose();
  });

  it("restores the repair backup when rebuilt projectors do not reach the captured fence", async () => {
    const nonAdvancingProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      folderMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
      projectDeferredEvent: () => Effect.void,
    };
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(
          Layer.succeed(OrchestrationProjectionPipeline, nonAdvancingProjectionPipeline),
        ),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    await runtime.runPromise(createTestSpace(engine));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-project-repair-fence"),
        folderId: asFolderId("project-repair-fence"),
        spaceId: TEST_SPACE_ID,
        title: "Repair Fence Project",
        workspaceRoot: null,
        defaultModelSelection: null,
        createdAt,
      }),
    );
    const beforeRepair = await runtime.runPromise(engine.getReadModel());

    await expect(runtime.runPromise(engine.repairState())).rejects.toThrow(
      "did not reach captured event fence 2",
    );
    await expect(runtime.runPromise(engine.getReadModel())).resolves.toEqual(beforeRepair);

    await runtime.dispose();
  });

  it("rejects physical roots on ordinary folders", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("cmd-folder-with-root"),
          folderId: asFolderId("folder-with-root"),
          spaceId: TEST_SPACE_ID,
          title: "Folder",
          workspaceRoot: "/tmp/folder-root",
          defaultModelSelection: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("Folders are virtual containers");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "folder.create",
        commandId: CommandId.makeUnsafe("cmd-project-duplicate-create"),
        folderId: asFolderId("project-duplicate"),
        spaceId: TEST_SPACE_ID,
        title: "Duplicate Project",
        workspaceRoot: null,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-duplicate-1"),
        threadId: ThreadId.makeUnsafe("thread-duplicate"),
        deckId: singletonThreadDeckId(ThreadId.makeUnsafe("thread-duplicate")),
        folderId: asFolderId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-duplicate-2"),
          threadId: ThreadId.makeUnsafe("thread-duplicate"),
          deckId: singletonThreadDeckId(ThreadId.makeUnsafe("thread-duplicate")),
          folderId: asFolderId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });

  it("keeps the worker alive when a command throws while its pipeline is built", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const poisonedCommandId = CommandId.makeUnsafe("cmd-engine-poison");
    fingerprintPoison.add(poisonedCommandId);

    try {
      const poisonedOutcome = await system.run(
        Effect.result(
          system.engine.dispatch({
            type: "folder.create",
            commandId: poisonedCommandId,
            folderId: asFolderId("project-engine-poison"),
            spaceId: TEST_SPACE_ID,
            title: "Poisoned",
            workspaceRoot: null,
            defaultModelSelection: null,
            createdAt,
          }),
        ).pipe(Effect.timeoutOption("5 seconds")),
      );

      // The defect fails this command immediately instead of leaving the caller to
      // wait out the dispatch timeout.
      expect(Option.isSome(poisonedOutcome)).toBe(true);
      const outcome = Option.getOrThrow(poisonedOutcome);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.failure).toMatchObject({
          _tag: "OrchestrationCommandInternalError",
        });
      }

      // The worker survived: the next command still runs.
      await expect(
        system.run(
          system.engine.dispatch({
            type: "folder.create",
            commandId: CommandId.makeUnsafe("cmd-engine-poison-next"),
            folderId: asFolderId("project-engine-poison-next"),
            spaceId: TEST_SPACE_ID,
            title: "After poison",
            workspaceRoot: null,
            defaultModelSelection: null,
            createdAt,
          }),
        ),
      ).resolves.toMatchObject({ sequence: expect.any(Number) });

      // The poisoned envelope was still finished, so `outstanding` did not leak.
      const drained = await system.run(
        Effect.timeoutOption(system.engine.drain, "5 seconds").pipe(Effect.map(Option.isSome)),
      );
      expect(drained).toBe(true);
    } finally {
      fingerprintPoison.delete(poisonedCommandId);
      await system.dispose();
    }
  });
});
