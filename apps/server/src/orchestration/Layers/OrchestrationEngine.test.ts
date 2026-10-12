import { ThreadPublisher, ThreadPublisherLive } from "../../cleanCore/ThreadPublisher.ts";
import { updateNavigation } from "../../cleanCore/navigation.ts";
import { updateThreadFixture } from "../../cleanCore/threadFixtures.ts";
import { createThreadFixture } from "../../cleanCore/threadFixtures.ts";

import {
  CommandId,
  ProviderConnectionId,
  EventId,
  MessageId,
  FolderId,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@penkra/contracts";
import { Effect, Layer, Logger, ManagedRuntime, Option, PubSub, References, Stream } from "effect";
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
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
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

const createTestSpace = () =>
  updateNavigation({
    update: {
      action: "space.create",
      spaceId: TEST_SPACE_ID,
      name: "Test",
      icon: "home",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });

const seedCommandThread = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    const folderId = FolderId.makeUnsafe(`folder-${id}`);
    yield* updateNavigation({
      update: {
        action: "folder.create",
        folderId,
        spaceId: TEST_SPACE_ID,
        title: id,
        workspaceRoot: null,
        createdAt: now(),
      },
    });
    yield* createThreadFixture(sql, {
      threadId: ThreadId.makeUnsafe(id),
      folderId,
      title: id,
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      connection: { kind: "selected", connectionId: null },
      creator: { kind: "user" },
      createdAt: now(),
    });
  });
const activityCommand = (
  id: string,
  commandId: string,
  summary: string,
): OrchestrationCommand & { type: "thread.activity.append" } => ({
  type: "thread.activity.append",
  commandId: CommandId.makeUnsafe(commandId),
  threadId: ThreadId.makeUnsafe(id),
  createdAt: now(),
  activity: {
    id: EventId.makeUnsafe(`event-${commandId}`),
    tone: "info",
    kind: "test",
    summary,
    payload: {},
    turnId: null,
    createdAt: now(),
  },
});

async function createOrchestrationSystem(options?: {
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
    Layer.provideMerge(ThreadPublisherLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(snapshotQueryLayer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(
    options?.onLog
      ? orchestrationLayer.pipe(
          Layer.provideMerge(
            Logger.layer(
              [
                Logger.make(({ message, fiber }) =>
                  options.onLog?.(
                    Array.isArray(message)
                      ? message
                          .map((entry) =>
                            typeof entry === "string" ? entry : JSON.stringify(entry),
                          )
                          .join(" ")
                      : typeof message === "string"
                        ? message
                        : JSON.stringify(message),
                    fiber.getRef(References.CurrentLogAnnotations),
                  ),
                ),
              ],
              { mergeWithExisting: false },
            ),
          ),
        )
      : orchestrationLayer,
  );
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));

  await runtime.runPromise(createTestSpace());
  const managedAttachmentRepository = await runtime.runPromise(
    Effect.service(ManagedAttachmentRepository),
  );
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  return {
    engine,
    snapshotQuery,
    sql,
    managedAttachmentRepository,
    run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | ThreadPublisher>) =>
      runtime.runPromise(effect),
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
        updateNavigation({
          update: {
            action: "folder.create",
            folderId: asFolderId("folder-slow-command-a"),
            title: "Folder A",
            workspaceRoot: null,
            spaceId: TEST_SPACE_ID,
            defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
            createdAt: now(),
          },
        }),
      );
      await system.run(
        createThreadFixture(system.sql, {
          threadId: threadA,
          folderId: asFolderId("folder-slow-command-a"),
          title: "Thread A",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          createdAt: now(),
          connection: { kind: "selected", connectionId: null },
          creator: { kind: "user" },
        }),
      );
      const slow = system.run(
        system.engine.dispatch({
          type: "thread.turn.recover",
          runtimeMode: "full-access",
          reason: "restart",
          commandId: CommandId.makeUnsafe("slow-read-11118"),
          threadId: threadA,
          connectionId: null,
          recoveryMessageId: MessageId.makeUnsafe("slow-recover-11118"),
          createdAt: now(),
        }),
      );
      await slowReadEntered;
      let unrelatedCompleted = false;
      const unrelated = system.run(
        updateNavigation({
          update: {
            action: "folder.create",
            folderId: asFolderId("folder-slow-command-b"),
            title: "Folder B",
            workspaceRoot: null,
            spaceId: TEST_SPACE_ID,
            defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
            createdAt: now(),
          },
        }),
      );
      unrelated.then(() => {
        unrelatedCompleted = true;
      });
      let sameThreadSettled = false;
      const sameThread = system
        .run(
          system.engine.dispatch({
            type: "thread.turn.recover",
            runtimeMode: "full-access",
            reason: "restart",
            commandId: CommandId.makeUnsafe("slow-read-11921"),
            threadId: threadA,
            connectionId: null,
            recoveryMessageId: MessageId.makeUnsafe("slow-recover-11921"),
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
      await system.run(seedCommandThread(system.sql, "slow-stage"));
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
        system.engine.dispatch(activityCommand("slow-stage", commandId, "Slow stage")),
      );
      await vi.waitFor(
        () =>
          expect(logs).toContainEqual({
            message: "orchestration command worker slow stage",
            annotations: expect.objectContaining({
              commandId,
              stage: "preparing-thread-detail",
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
      const system = await createOrchestrationSystem();
      const threadId = ThreadId.makeUnsafe(`thread-${completion}-interrupted-order`);
      const folderId = asFolderId(`folder-${completion}-interrupted-order`);
      const turnId = asTurnId(`turn-${completion}-interrupted-order`);
      const messageId = asMessageId(`message-${completion}-interrupted-order`);
      const createdAt = now();
      try {
        await system.run(
          updateNavigation({
            update: {
              action: "folder.create",
              folderId,
              spaceId: TEST_SPACE_ID,
              title: "Ordering",
              workspaceRoot: null,
              defaultModelSelection: null,
              createdAt,
            },
          }),
        );
        await system.run(
          createThreadFixture(system.sql, {
            threadId: threadId,
            folderId: folderId,
            title: "Ordering",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            createdAt: createdAt,
            connection: { kind: "selected", connectionId: null },
            creator: { kind: "user" },
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
        const readModel = await system.run(system.snapshotQuery.getSnapshot());
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
                runtimeMode: "full-access",
                reason: "play",
                commandId: CommandId.makeUnsafe("play-after-assistant-order"),
                threadId,
                turnId: interruptedTurnId!,
                interruptedTurnId: interruptedTurnId!,
                recoveryMessageId: asMessageId("recovery-after-assistant-order"),
                connectionId: null,
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
  it("refuses a send to an archived canonical thread without creating a turn", async () => {
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.makeUnsafe("thread-archived-engine-guard");
    const folderId = asFolderId("folder-archived-engine-guard");
    const createdAt = now();
    const queuedMessageId = asMessageId("queued-before-archive");
    try {
      await system.run(
        updateNavigation({
          update: {
            action: "folder.create",
            folderId,
            spaceId: TEST_SPACE_ID,
            title: "Archive guard",
            workspaceRoot: null,
            defaultModelSelection: null,
            createdAt,
          },
        }),
      );
      await system.run(
        createThreadFixture(system.sql, {
          threadId: threadId,
          folderId: folderId,
          title: "Archive guard",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          createdAt: createdAt,
          connection: { kind: "selected", connectionId: null },
          creator: { kind: "user" },
        }),
      );
      await system.run(
        updateThreadFixture(system.sql, {
          action: "archive",
          threadId: threadId,
          updatedAt: new Date().toISOString(),
          archivedAt: new Date().toISOString(),
        }),
      );
      const archived = (await system.run(system.snapshotQuery.getSnapshot())).threads.find(
        (thread) => thread.id === threadId,
      );
      expect(archived?.archivedAt).toBeDefined();
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
        updateThreadFixture(system.sql, {
          action: "archive",
          threadId: threadId,
          updatedAt: new Date().toISOString(),
          archivedAt: null,
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

  it("admits Play from the canonical row without a binding query after user Stop", async () => {
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.makeUnsafe("thread-play-after-user-stop");
    const folderId = asFolderId("folder-play-after-user-stop");
    const turnId = asTurnId("turn-play-after-user-stop");
    const requestedAt = "2026-09-26T21:04:38.548Z";
    const startedAt = "2026-09-26T21:04:38.903Z";
    const stoppedAt = "2026-09-26T21:04:49.812Z";
    try {
      await system.run(
        updateNavigation({
          update: {
            action: "folder.create",
            folderId,
            spaceId: TEST_SPACE_ID,
            title: "Play after Stop",
            workspaceRoot: null,
            defaultModelSelection: null,
            createdAt: requestedAt,
          },
        }),
      );
      await system.run(
        createThreadFixture(system.sql, {
          threadId: threadId,
          folderId: folderId,
          title: "Play after Stop",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          createdAt: requestedAt,
          connection: { kind: "selected", connectionId: null },
          creator: { kind: "user" },
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
            activeTurnId: null,
            lastError: null,
            updatedAt: stoppedAt,
          },
          createdAt: stoppedAt,
        }),
      );
      const thread = (await system.run(system.snapshotQuery.getSnapshot())).threads.find(
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
            runtimeMode: "approval-required",
            reason: "play",
            commandId: CommandId.makeUnsafe("cmd-play-stop-recover"),
            threadId,
            turnId,
            interruptedTurnId: turnId,
            recoveryMessageId: asMessageId("msg-play-stop-recovery"),
            connectionId: null,
            createdAt: stoppedAt,
          }),
        ),
      ).resolves.toMatchObject({ sequence: expect.any(Number) });
      const stillQueued = await system.run(system.sql<{ readonly state: string }>`
        SELECT state FROM queued_turn_promotions WHERE thread_id = ${threadId}
      `);
      expect(stillQueued).toEqual([{ state: "queued" }]);
      const recoveryEvents = Array.from(
        await system.run(Stream.runCollect(system.engine.readEvents(0))),
      );
      expect(
        recoveryEvents.find(
          (event) =>
            event.commandId === "cmd-play-stop-recover" &&
            event.type === "thread.turn-start-requested",
        ),
      ).toMatchObject({
        payload: { runtimeMode: "full-access" },
      });
    } finally {
      await system.dispose();
    }
  });

  it("rejects Play through the engine with a pending question", async () => {
    const blocker = "pending question";
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.makeUnsafe(`thread-play-${blocker}`);
    const turnId = asTurnId(`turn-play-${blocker}`);
    const createdAt = now();
    try {
      await system.run(
        updateNavigation({
          update: {
            action: "folder.create",
            folderId: asFolderId(`folder-play-${blocker}`),
            spaceId: TEST_SPACE_ID,
            title: "Play test",
            workspaceRoot: null,
            defaultModelSelection: null,
            createdAt,
          },
        }),
      );
      await system.run(
        createThreadFixture(system.sql, {
          threadId: threadId,
          folderId: asFolderId(`folder-play-${blocker}`),
          title: "Play test",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          createdAt: createdAt,
          connection: { kind: "selected", connectionId: null },
          creator: { kind: "user" },
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
              status, response_command_id, response_requested_at, created_at, resolved_at
            ) VALUES ('userInput', 'real-pending-play-question', ${threadId}, ${turnId}, NULL,
              'pending', NULL, NULL, ${createdAt}, NULL)
          `);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.recover",
            runtimeMode: "full-access",
            reason: "play",
            commandId: CommandId.makeUnsafe(`cmd-play-blocked-${blocker}`),
            threadId,
            turnId,
            interruptedTurnId: turnId,
            recoveryMessageId: asMessageId(`recovery-play-blocked-${blocker}`),
            connectionId: null,
            createdAt,
          }),
        ),
      ).rejects.toMatchObject({ code: "THREAD_CONTINUE_STALE" });
    } finally {
      await system.dispose();
    }
  });
  it("admits at most one of two concurrent Play commands for the same latest turn", async () => {
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.makeUnsafe("thread-concurrent-play");
    const folderId = asFolderId("project-concurrent-play");
    const turnId = asTurnId("turn-concurrent-play");
    const createdAt = now();
    try {
      await system.run(
        updateNavigation({
          update: {
            action: "folder.create",
            folderId,
            spaceId: TEST_SPACE_ID,
            title: "Concurrent Play",
            workspaceRoot: null,
            defaultModelSelection: null,
            createdAt,
          },
        }),
      );
      await system.run(
        createThreadFixture(system.sql, {
          threadId: threadId,
          folderId: folderId,
          title: "Concurrent Play thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          createdAt: createdAt,
          connection: { kind: "selected", connectionId: null },
          creator: { kind: "user" },
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
            runtimeMode: "full-access",
            reason: "play",
            commandId: CommandId.makeUnsafe(`cmd-concurrent-play-${index}`),
            threadId,
            turnId,
            interruptedTurnId: turnId,
            recoveryMessageId: MessageId.makeUnsafe(`message-concurrent-play-${index}`),
            connectionId: null,
            createdAt,
          }),
        );
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.recover",
            runtimeMode: "full-access",
            reason: "play",
            commandId: CommandId.makeUnsafe("cmd-concurrent-play-stale-connection"),
            threadId,
            turnId,
            interruptedTurnId: turnId,
            recoveryMessageId: MessageId.makeUnsafe("message-concurrent-play-stale-connection"),
            connectionId: ProviderConnectionId.makeUnsafe("another-account"),
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
      updateNavigation({
        update: {
          action: "folder.create",
          folderId: asFolderId("project-engine-quiesce"),
          spaceId: TEST_SPACE_ID,
          title: "Engine quiesce",
          workspaceRoot: null,
          defaultModelSelection: null,
          createdAt,
        },
      }),
    );
    await system.run(
      createThreadFixture(system.sql, {
        threadId: threadId,
        folderId: asFolderId("project-engine-quiesce"),
        title: "Engine quiesce thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      }),
    );

    await system.run(system.engine.quiesce);
    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("quiesced-start"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("quiesced-message"),
            role: "user",
            text: "rejected",
            attachments: [],
          },
          runtimeMode: "full-access",
          createdAt,
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
    await system.run(seedCommandThread(system.sql, "fingerprint"));
    const command = activityCommand("fingerprint", "cmd-fingerprint-retry", "Original identity");

    const first = await system.run(system.engine.dispatch(command));
    await expect(system.run(system.engine.dispatch({ ...command }))).resolves.toEqual(first);
    await expect(
      system.run(
        system.engine.dispatch({
          ...command,
          activity: { ...command.activity, summary: "Different command content" },
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
    const { engine, sql } = system;

    await system.run(
      updateNavigation({
        update: {
          action: "folder.create",
          folderId: asFolderId("project-1"),
          spaceId: TEST_SPACE_ID,
          title: "Project 1",
          workspaceRoot: null,
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        },
      }),
    );
    await system.run(
      createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe("thread-1"),
        folderId: asFolderId("project-1"),
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
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
    const { engine, sql } = system;
    await system.run(seedCommandThread(system.sql, "identity"));
    const command = activityCommand(
      "identity",
      "cmd-project-command-identity",
      "Original identity",
    );

    const accepted = await system.run(engine.dispatch(command));
    await expect(system.run(engine.dispatch(command))).resolves.toEqual(accepted);
    await expect(
      system.run(
        engine.dispatch({
          ...command,
          activity: { ...command.activity, summary: "Different identity" },
        }),
      ),
    ).rejects.toThrow("Command identity collision");

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    expect(events).toHaveLength(1);
    expect(
      (await system.run(system.snapshotQuery.getSnapshot())).threads[0]?.activities[0]?.summary,
    ).toBe("Original identity");
    await system.dispose();
  });

  it("claims managed attachments atomically and rejects attachment changes on an accepted retry", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine, sql } = system;
    const threadId = ThreadId.makeUnsafe("thread-managed-attachment");
    const commandId = CommandId.makeUnsafe("cmd-managed-attachment-turn");
    const messageId = asMessageId("msg-managed-attachment");
    const principal = { ownerKind: "session" as const, ownerId: "session-a" };

    await system.run(
      updateNavigation({
        update: {
          action: "folder.create",
          folderId: asFolderId("project-managed-attachment"),
          spaceId: TEST_SPACE_ID,
          title: "Managed attachment project",
          workspaceRoot: null,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt,
        },
      }),
    );
    await system.run(
      createThreadFixture(sql, {
        threadId: threadId,
        folderId: asFolderId("project-managed-attachment"),
        title: "Managed attachment thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
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
    await system.run(seedCommandThread(system.sql, "replay"));
    await system.run(system.engine.dispatch(activityCommand("replay", "replay-first", "First")));
    await system.run(system.engine.dispatch(activityCommand("replay", "replay-second", "Second")));
    const events = Array.from(await system.run(Stream.runCollect(system.engine.readEvents(0))));
    expect(events.map((event) => event.type)).toEqual([
      "thread.activity-appended",
      "thread.activity-appended",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    const later = Array.from(await system.run(Stream.runCollect(system.engine.readEvents(1))));
    expect(later.map((event) => event.sequence)).toEqual([2]);
    expect(await system.run(system.sql`SELECT * FROM provider_intent_outbox`)).toEqual([]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    await system.run(seedCommandThread(system.sql, "stream"));
    const events = await system.run(
      Effect.gen(function* () {
        const subscription = yield* system.engine.subscribeDomainEvents;
        const pubSub = yield* Stream.toQueue(subscription, { capacity: "unbounded" });
        const queue = yield* PubSub.subscribe(pubSub);
        yield* system.engine.dispatch(activityCommand("stream", "stream-first", "First"));
        yield* system.engine.dispatch(activityCommand("stream", "stream-second", "Second"));
        return [yield* PubSub.take(queue), yield* PubSub.take(queue)];
      }).pipe(Effect.scoped),
    );
    expect(events.map((event) => event.type)).toEqual([
      "thread.activity-appended",
      "thread.activity-appended",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
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
        Layer.provideMerge(ThreadPublisherLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    await runtime.runPromise(createTestSpace());
    const createdAt = now();
    await runtime.runPromise(seedCommandThread(sql, "flaky"));

    await runtime.runPromise(
      updateNavigation({
        update: {
          action: "folder.create",
          folderId: asFolderId("project-flaky"),
          spaceId: TEST_SPACE_ID,
          title: "Flaky Project",
          workspaceRoot: null,
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        },
      }),
    );

    await expect(
      runtime.runPromise(engine.dispatch(activityCommand("flaky", "cmd-flaky-1", "failed"))),
    ).rejects.toThrow("failed unexpectedly");

    const result = await runtime.runPromise(
      engine.dispatch(activityCommand("flaky", "cmd-flaky-2", "ok")),
    );

    expect(result.sequence).toBe(1);
    expect((await runtime.runPromise(engine.getCommandReadModel())).snapshotSequence).toBe(1);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
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
        Layer.provideMerge(ThreadPublisherLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    await runtime.runPromise(createTestSpace());
    const createdAt = now();

    await runtime.runPromise(
      updateNavigation({
        update: {
          action: "folder.create",
          folderId: asFolderId("project-atomic"),
          spaceId: TEST_SPACE_ID,
          title: "Atomic Project",
          workspaceRoot: null,
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        },
      }),
    );
    await runtime.runPromise(
      createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe("thread-atomic"),
        folderId: asFolderId("project-atomic"),
        title: "atomic",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
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
    expect(eventsAfterFailure).toEqual([]);
    // The failed command must not advance the in-memory model past the last
    // durable event. The projection pipeline in this test is intentionally a
    // no-op, so a database snapshot would report zero and mask this invariant.
    expect((await runtime.runPromise(engine.getCommandReadModel())).snapshotSequence).toBe(0);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(2);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
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
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: (event) => {
        if (
          shouldDieProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-project-defect-1")
        ) {
          shouldDieProjection = false;
          return Effect.die("projection defect");
        }
        return Effect.void;
      },
      projectDeferredEvent: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provideMerge(ThreadPublisherLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, defectiveProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    await runtime.runPromise(createTestSpace());
    const createdAt = now();
    await runtime.runPromise(seedCommandThread(sql, "defect"));

    await expect(
      runtime.runPromise(
        engine.dispatch(activityCommand("defect", "cmd-project-defect-1", "failed")),
      ),
    ).rejects.toThrow("failed unexpectedly");

    await expect(
      runtime.runPromise(engine.dispatch(activityCommand("defect", "cmd-project-defect-2", "ok"))),
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
      CommandId.makeUnsafe("cmd-project-defect-1"),
      CommandId.makeUnsafe("cmd-project-defect-2"),
    ]);
    expect(eventsAfterRecovery.every((event) => event.type === "thread.activity-appended")).toBe(
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
        Layer.provideMerge(ThreadPublisherLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    await runtime.runPromise(createTestSpace());
    const createdAt = now();

    await runtime.runPromise(
      updateNavigation({
        update: {
          action: "folder.create",
          folderId: asFolderId("project-sync"),
          spaceId: TEST_SPACE_ID,
          title: "Sync Project",
          workspaceRoot: null,
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        },
      }),
    );
    await runtime.runPromise(
      createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe("thread-sync"),
        folderId: asFolderId("project-sync"),
        title: "sync-before",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("cmd-thread-meta-sync-fail"),
          threadId: ThreadId.makeUnsafe("thread-sync"),
          createdAt,
          activity: {
            id: EventId.makeUnsafe("sync-activity"),
            kind: "notice",
            tone: "info",
            summary: "sync-after-failed-projection",
            payload: {},
            turnId: null,
            createdAt,
          },
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.at(-1)?.type).toBe("thread.activity-appended");
    expect(eventsAfterFailure.at(-1)?.sequence).toBe(1);

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine, sql } = system;

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
        Layer.provideMerge(ThreadPublisherLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    await runtime.runPromise(createTestSpace());
    const createdAt = now();

    await runtime.runPromise(
      updateNavigation({
        update: {
          action: "folder.create",
          folderId: asFolderId("project-deferred-recovery"),
          spaceId: TEST_SPACE_ID,
          title: "Deferred Recovery Project",
          workspaceRoot: null,
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        },
      }),
    );
    await runtime.runPromise(
      createThreadFixture(sql, {
        threadId: ThreadId.makeUnsafe("thread-deferred-recovery"),
        folderId: asFolderId("project-deferred-recovery"),
        title: "deferred-recovery",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt: createdAt,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
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

    expect(result.sequence).toBe(2);
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

  it("stores a folder directory on creation and applies updates and removal", async () => {
    const system = await createOrchestrationSystem();
    const { engine, sql } = system;
    const folderId = asFolderId("folder-with-root");
    try {
      await system.run(
        updateNavigation({
          update: {
            action: "folder.create",
            folderId,
            spaceId: TEST_SPACE_ID,
            title: "Folder",
            workspaceRoot: "/tmp/folder-root",
            defaultModelSelection: null,
            createdAt: now(),
          },
        }),
      );
      const readRoot = () =>
        system.run(
          sql<{
            workspaceRoot: string | null;
          }>`SELECT workspace_root AS "workspaceRoot" FROM projection_folders WHERE folder_id=${folderId}`,
        );
      expect(await readRoot()).toEqual([{ workspaceRoot: "/tmp/folder-root" }]);
      await system.run(
        updateNavigation({
          update: { action: "folder.update", folderId, workspaceRoot: "/tmp/new-folder-root" },
        }),
      );
      expect(await readRoot()).toEqual([{ workspaceRoot: "/tmp/new-folder-root" }]);
      await system.run(
        updateNavigation({ update: { action: "folder.update", folderId, workspaceRoot: null } }),
      );
      expect(await readRoot()).toEqual([{ workspaceRoot: null }]);
    } finally {
      await system.dispose();
    }
  });

  it("keeps the worker alive when a command throws while its pipeline is built", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const poisonedCommandId = CommandId.makeUnsafe("cmd-engine-poison");
    await system.run(seedCommandThread(system.sql, "poison"));
    fingerprintPoison.add(poisonedCommandId);

    try {
      const poisonedOutcome = await system.run(
        Effect.result(
          system.engine.dispatch(activityCommand("poison", poisonedCommandId, "Poisoned")),
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
          system.engine.dispatch(
            activityCommand("poison", "project-engine-poison-next", "After poison"),
          ),
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
