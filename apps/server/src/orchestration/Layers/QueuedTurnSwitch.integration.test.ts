import { updateNavigation } from "../../cleanCore/navigation.ts";
import { ThreadPublisher, ThreadPublisherLive } from "../../cleanCore/ThreadPublisher.ts";
import { updateThreadFixture } from "../../cleanCore/threadFixtures.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createThreadFixture } from "../../cleanCore/threadFixtures.ts";
import {
  CommandId,
  FolderId,
  MessageId,
  ProviderConnectionId,
  ProviderInstallationId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../../config.ts";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../../managedAttachmentPrincipal.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions.ts";
import { ProviderNativeStateMaterializer } from "../../provider/Services/ProviderNativeStateMaterializer.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderTurnSelectionResolver } from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import { ProviderTurnSelectionResolutionError } from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderThreadSwitchCoordinator } from "../Services/ProviderThreadSwitchCoordinator.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderThreadSwitchCoordinatorLive } from "./ProviderThreadSwitchCoordinator.ts";

const at = "2026-09-27T00:00:00.000Z";
const installationId = ProviderInstallationId.makeUnsafe("queued-switch-installation");
const oldConnection = ProviderConnectionId.makeUnsafe("queued-switch-old");
const newConnection = ProviderConnectionId.makeUnsafe("queued-switch-new");
const oldModel = "gpt-5-codex";
const newModel = "gpt-5.6-sol";

async function makeSystem(options?: {
  readonly resolverFailure?: "provider_mismatch" | "connection_unauthorized" | "selection_failed";
  readonly failResolverOnce?: boolean;
  readonly failResolverOnCall?: number;
}) {
  const threadId = ThreadId.makeUnsafe("queued-switch-thread");
  let resolverCalls = 0;
  const services = Layer.mergeAll(
    ThreadPublisherLive,
    Layer.succeed(ProviderService, { stopSession: () => Effect.void } as never),
    Layer.succeed(ProviderNativeStateMaterializer, { discard: () => Effect.void } as never),
    Layer.succeed(ProviderTurnSelectionResolver, {
      resolveExisting: (input: any) =>
        Effect.gen(function* () {
          const call = ++resolverCalls;
          if (
            options?.resolverFailure &&
            (options.failResolverOnCall === call ||
              (options.failResolverOnCall === undefined &&
                (!options.failResolverOnce || call === 1)))
          ) {
            return yield* Effect.fail(
              new ProviderTurnSelectionResolutionError({
                code: options.resolverFailure,
                detail:
                  options.resolverFailure === "connection_unauthorized"
                    ? "This thread's Claude conversation belongs to a different Claude account. Use a Connection signed in to that account, or start a new thread."
                    : options.resolverFailure === "provider_mismatch"
                      ? "This thread uses a different provider. To use another provider, start a new thread."
                      : "Could not read the selected Connection.",
                ...(options.resolverFailure === "selection_failed"
                  ? { cause: new Error("I/O unavailable") }
                  : {}),
              }),
            );
          }
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            connectionId: ProviderConnectionId | null;
            modelId: string;
            nativeStateId: string | null;
            providerSessionId: string | null;
          }>`SELECT connection_id AS "connectionId",model AS "modelId",native_state_id AS "nativeStateId",provider_session_id AS "providerSessionId" FROM threads WHERE id=${threadId}`;
          const current = rows[0]!;
          const connectionId =
            input.connectionId === undefined ? current.connectionId : input.connectionId;
          const modelId = input.modelSelection?.model ?? current.modelId;
          return {
            threadId,
            harness: "codex",
            connectionId,
            connectionLabel: connectionId === null ? null : "Test",
            previousConnectionId: current.connectionId,
            previousModelId: current.modelId,
            installationId,
            internalProviderId: null,
            modelId,
            modelLabel: modelId,
            nativeStateId: current.nativeStateId,
            providerSessionId: current.providerSessionId,
            changed: connectionId !== current.connectionId || modelId !== current.modelId,
            requiresNativeStateMaterialization: false,
          };
        }),
    } as never),
  );
  const engineLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(ThreadPublisherLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "penkra-queued-switch-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(services),
  );
  const runtime = ManagedRuntime.make(
    ProviderThreadSwitchCoordinatorLive.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(services),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getThreadShellById: () => Effect.succeed(Option.none()),
        } as never),
      ),
    ),
  );
  return {
    threadId,
    sql: await runtime.runPromise(Effect.service(SqlClient.SqlClient)),
    run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | ThreadPublisher>) =>
      runtime.runPromise(effect),
    engine: await runtime.runPromise(Effect.service(OrchestrationEngineService)),
    coordinator: await runtime.runPromise(Effect.service(ProviderThreadSwitchCoordinator)),
    queue: await runtime.runPromise(Effect.service(QueuedTurnPromotionRepository)),
    selection: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql<{
            connectionId: string | null;
            modelId: string;
          }>`SELECT connection_id AS "connectionId",model AS "modelId" FROM threads WHERE id=${threadId}`)[0]!;
        }),
      ),
    dispose: () => runtime.dispose(),
  };
}

const queuedCommand = (threadId: ThreadId) => ({
  type: "thread.turn.dispatch-queued" as const,
  commandId: CommandId.makeUnsafe("queued-promote"),
  threadId,
  turnId: TurnId.makeUnsafe("queued-switch-turn"),
  messageId: MessageId.makeUnsafe("queued-switch-message"),
  modelSelection: { provider: "codex" as const, model: oldModel },
  connectionId: oldConnection,
  bindingRevision: 1,
  runtimeMode: "full-access" as const,
  dispatchMode: "queue" as const,
  createdAt: at,
});

async function seedThreadForAdmission(s: Awaited<ReturnType<typeof makeSystem>>) {
  const folderId = FolderId.makeUnsafe("queued-switch-folder");
  const spaceId = SpaceId.makeUnsafe("queued-switch-space");
  await s.run(
    updateNavigation({
      update: { action: "space.create", spaceId, name: "Test", icon: "home", createdAt: at },
    }),
  );
  await s.run(
    updateNavigation({
      update: {
        action: "folder.create",
        folderId,
        spaceId,
        title: "Test",
        workspaceRoot: null,
        defaultModelSelection: null,
        createdAt: at,
      },
    }),
  );
  await s.run(
    createThreadFixture(s.sql, {
      threadId: s.threadId,
      folderId: folderId,
      title: "Test",
      modelSelection: { provider: "codex", model: oldModel },
      runtimeMode: "full-access",
      createdAt: at,
      connection: { kind: "selected", connectionId: oldConnection },
      creator: { kind: "user" },
    }),
  );
}

describe("queued selection through real admission", () => {
  it.each(["connection_unauthorized", "provider_mismatch"] as const)(
    "preserves the %s resolver refusal for a queued admission",
    async (code) => {
      const s = await makeSystem({ resolverFailure: code });
      try {
        await seedThreadForAdmission(s);
        await expect(
          s.run(
            s.coordinator.dispatchQueuedTurn({
              command: queuedCommand(s.threadId),
              attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
            }),
          ),
        ).rejects.toMatchObject({ code });
      } finally {
        await s.dispose();
      }
    },
  );

  it("allows a transient selection lookup to be retried", async () => {
    const s = await makeSystem({ resolverFailure: "selection_failed", failResolverOnce: true });
    try {
      await seedThreadForAdmission(s);
      const command = queuedCommand(s.threadId);
      await expect(
        s.run(
          s.coordinator.dispatchQueuedTurn({
            command,
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          }),
        ),
      ).rejects.toMatchObject({ code: "selection_failed" });
      await expect(
        s.run(
          s.coordinator.dispatchQueuedTurn({
            command,
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          }),
        ),
      ).resolves.toHaveProperty("sequence");
    } finally {
      await s.dispose();
    }
  });

  it.each(["model", "connection", "unchanged", "anonymous"] as const)(
    "promotes with %s selection",
    async (kind) => {
      const s = await makeSystem();
      const folderId = FolderId.makeUnsafe("queued-switch-folder");
      const messageId = MessageId.makeUnsafe("queued-switch-message");
      const turnId = TurnId.makeUnsafe("queued-switch-turn");
      try {
        await s.run(
          updateNavigation({
            update: {
              action: "space.create",
              spaceId: SpaceId.makeUnsafe("queued-space"),
              name: "Test",
              icon: "home",
              createdAt: at,
            },
          }),
        );
        await s.run(
          updateNavigation({
            update: {
              action: "folder.create",
              folderId,
              spaceId: SpaceId.makeUnsafe("queued-space"),
              title: "Test",
              workspaceRoot: null,
              defaultModelSelection: null,
              createdAt: at,
            },
          }),
        );
        await s.run(
          createThreadFixture(s.sql, {
            threadId: s.threadId,
            folderId: folderId,
            title: "Test",
            modelSelection: { provider: "codex", model: oldModel },
            runtimeMode: "full-access",
            createdAt: at,
            connection: { kind: "selected", connectionId: oldConnection },
            creator: { kind: "user" },
          }),
        );
        await s.run(
          s.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("queued-running"),
            threadId: s.threadId,
            session: {
              threadId: s.threadId,
              status: "running",
              providerName: "codex",
              activeTurnId: TurnId.makeUnsafe("predecessor"),
              lastError: null,
              updatedAt: at,
            },
            createdAt: at,
          }),
        );
        const queued = await s.run(
          s.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("queued-source"),
            threadId: s.threadId,
            turnId,
            message: { messageId, role: "user", text: "Continue", attachments: [] },
            modelSelection: { provider: "codex", model: oldModel },
            connectionId: oldConnection,
            bindingRevision: 1,
            runtimeMode: "full-access",
            dispatchMode: "queue",
            createdAt: at,
          }),
        );
        await s.run(
          s.queue.enqueue({
            queuedEventSequence: queued.sequence,
            threadId: s.threadId,
            messageId,
            dispatchMode: "queue",
            createdAt: at,
          }),
        );
        await s.run(
          s.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("queued-ready"),
            threadId: s.threadId,
            session: {
              threadId: s.threadId,
              status: "ready",
              providerName: "codex",
              activeTurnId: null,
              lastError: null,
              updatedAt: at,
            },
            createdAt: at,
          }),
        );
        const desiredConnection =
          kind === "connection" ? newConnection : kind === "anonymous" ? null : oldConnection;
        const desiredModel = kind === "model" ? newModel : oldModel;
        if (kind !== "unchanged")
          await s.run(
            updateThreadFixture(
              s.sql,
              kind === "model"
                ? {
                    action: "model",
                    threadId: s.threadId,
                    modelSelection: { provider: "codex", model: desiredModel },
                    connection: { kind: "keep" },
                    updatedAt: "2026-08-09T00:00:00.000Z",
                  }
                : {
                    action: "connection",
                    threadId: s.threadId,
                    connectionId: desiredConnection,
                    updatedAt: "2026-08-09T00:00:00.000Z",
                  },
            ),
          );
        const claimed = await s.run(
          s.queue.claimNext({
            threadId: s.threadId,
            claimOwner: "test",
            claimedAt: at,
            claimExpiresAt: "2026-09-28T00:00:00.000Z",
          }),
        );
        expect(Option.isSome(claimed)).toBe(true);
        const result = await s.run(
          s.coordinator.dispatchQueuedTurn({
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
            command: {
              type: "thread.turn.dispatch-queued",
              commandId: CommandId.makeUnsafe("queued-promote"),
              threadId: s.threadId,
              turnId,
              messageId,
              modelSelection: { provider: "codex", model: desiredModel },
              connectionId: desiredConnection,
              runtimeMode: "full-access",
              dispatchMode: "queue",
              createdAt: at,
            },
          }),
        );
        expect(result.sequence).toBeGreaterThan(queued.sequence);
        await s.run(
          s.queue.markPromoted({
            queuedEventSequence: queued.sequence,
            claimOwner: "test",
            promotedAt: at,
          }),
        );
        const events = await s.run(
          Stream.runCollect(s.engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
        );
        expect(
          events.find(
            (event) =>
              event.type === "thread.turn-start-requested" && event.commandId === "queued-promote",
          ),
        ).toMatchObject({
          payload: {
            messageId,
            connectionId: desiredConnection,
          },
        });
        expect(await s.selection()).toMatchObject({
          connectionId: desiredConnection,
          modelId: desiredModel,
        });
        expect(await s.run(s.queue.hasPendingMessage({ threadId: s.threadId, messageId }))).toBe(
          false,
        );
        expect(Option.getOrThrow(await s.run(s.queue.getBySequence(queued.sequence))).state).toBe(
          "promoted",
        );
      } finally {
        await s.dispose();
      }
    },
  );
});
