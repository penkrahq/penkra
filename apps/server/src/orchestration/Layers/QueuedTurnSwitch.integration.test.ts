import {
  singletonThreadDeckId,
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
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderNativeForkOperationRepository } from "../../persistence/Services/ProviderNativeForkOperations.ts";
import { ProviderThreadSwitchOperationRepository } from "../../persistence/Services/ProviderThreadSwitchOperations.ts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { ProviderLaunchResolver } from "../../provider/Services/ProviderLaunchResolver.ts";
import { ProviderNativeContinuationVerifier } from "../../provider/Services/ProviderNativeContinuationVerifier.ts";
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
  readonly commitFault?: { readonly target: "binding" | "journal"; readonly errcode: number };
  readonly bindingCasConflict?: boolean;
}) {
  const threadId = ThreadId.makeUnsafe("queued-switch-thread");
  let resolverCalls = 0;
  let binding = {
    threadId,
    connectionId: oldConnection as typeof oldConnection | typeof newConnection | null,
    installationId,
    internalProviderId: null,
    modelId: oldModel,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
  let operation: any;
  const services = Layer.mergeAll(
    Layer.succeed(ThreadProviderBindingRepository, {
      getHarnessState: () =>
        Effect.succeed(Option.some({ threadId, harness: "codex", revision: 0 })),
      getRuntimeBinding: () => Effect.sync(() => Option.some(binding)),
      updateRuntimeBindingInCurrentTransaction: (input: any) =>
        options?.commitFault?.target === "binding"
          ? Effect.fail(
              new PersistenceSqlError({
                operation:
                  "ThreadProviderBindingRepository.updateRuntimeBindingInCurrentTransaction",
                detail: "SQLite commit failed",
                cause: { errcode: options.commitFault.errcode },
              }),
            )
          : Effect.sync(() => {
              if (options?.bindingCasConflict) return Option.none();
              if (binding.revision !== input.expectedRevision) return Option.none();
              binding = {
                ...binding,
                connectionId: input.connectionId,
                modelId: input.modelId,
                revision: binding.revision + 1,
                updatedAt: input.updatedAt,
              };
              return Option.some(binding);
            }),
    } as never),
    Layer.succeed(ProviderThreadSwitchOperationRepository, {
      get: () => Effect.sync(() => Option.fromNullishOr(operation)),
      begin: (input: any) => Effect.sync(() => (operation = input)),
      markInterruptedWithSettledSelection: (input: any) =>
        Effect.sync(() => {
          operation = { ...operation, state: "interrupted", selectionJson: input.selectionJson };
          return Option.some(operation);
        }),
      transition: (input: any) =>
        Effect.sync(() => {
          operation = { ...operation, ...input };
          return Option.some(operation);
        }),
      markCommittedInCurrentTransaction: () =>
        options?.commitFault?.target === "journal"
          ? Effect.fail(
              new PersistenceSqlError({
                operation:
                  "ProviderThreadSwitchOperationRepository.markCommittedInCurrentTransaction",
                detail: "SQLite commit failed",
                cause: { errcode: options.commitFault.errcode },
              }),
            )
          : Effect.sync(() => {
              operation = { ...operation, state: "committed" };
              return Option.some(operation);
            }),
      listOpen: () => Effect.succeed([]),
    } as never),
    Layer.succeed(ProviderNativeForkOperationRepository, {
      get: () => Effect.succeed(Option.none()),
      listOpen: () => Effect.succeed([]),
    } as never),
    Layer.succeed(ProviderService, { listSessions: () => Effect.succeed([]) } as never),
    Layer.succeed(ProviderLaunchResolver, {} as never),
    Layer.succeed(ProviderNativeContinuationVerifier, {} as never),
    Layer.succeed(ProviderNativeStateMaterializer, {} as never),
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
          const connectionId =
            input.connectionId === undefined ? binding.connectionId : input.connectionId;
          const modelId = input.modelSelection?.model ?? binding.modelId;
          return {
            threadId,
            harness: "codex",
            connectionId,
            connectionLabel: connectionId === null ? null : "Test",
            previousConnectionId: binding.connectionId,
            previousModelId: binding.modelId,
            previousInstallationId: installationId,
            installationId,
            internalProviderId: null,
            modelId,
            modelLabel: modelId,
            stateRevision: 0,
            bindingRevision: binding.revision,
            changed: connectionId !== binding.connectionId || modelId !== binding.modelId,
            requiresNativeStateMaterialization: false,
          };
        }),
    } as never),
  );
  const engineLayer = OrchestrationEngineLive.pipe(
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
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    engine: await runtime.runPromise(Effect.service(OrchestrationEngineService)),
    coordinator: await runtime.runPromise(Effect.service(ProviderThreadSwitchCoordinator)),
    queue: await runtime.runPromise(Effect.service(QueuedTurnPromotionRepository)),
    binding: () => binding,
    operation: () => operation,
    resolverCalls: () => resolverCalls,
    setOperation: (value: any) => {
      operation = value;
    },
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
    s.engine.dispatch({
      type: "space.create",
      commandId: CommandId.makeUnsafe("queued-space"),
      spaceId,
      name: "Test",
      icon: "home",
      createdAt: at,
    }),
  );
  await s.run(
    s.engine.dispatch({
      type: "folder.create",
      commandId: CommandId.makeUnsafe("queued-folder"),
      folderId,
      spaceId,
      title: "Test",
      workspaceRoot: null,
      defaultModelSelection: null,
      createdAt: at,
    }),
  );
  await s.run(
    s.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("queued-thread"),
      threadId: s.threadId,
      deckId: singletonThreadDeckId(s.threadId),
      folderId,
      title: "Test",
      modelSelection: { provider: "codex", model: oldModel },
      runtimeMode: "full-access",
      createdAt: at,
    }),
  );
}

describe("queued selection through real admission", () => {
  it.each([
    ["binding", 5, "provider_switch_commit_retryable"],
    ["binding", 6, "provider_switch_commit_retryable"],
    ["binding", 10, "provider_switch_commit_retryable"],
    ["binding", 19, "provider_switch_commit_failed"],
    ["journal", 5, "provider_switch_commit_retryable"],
    ["journal", 6, "provider_switch_commit_retryable"],
    ["journal", 10, "provider_switch_commit_retryable"],
    ["journal", 19, "provider_switch_commit_failed"],
  ] as const)("classifies %s commit SQLite result %i", async (target, errcode, code) => {
    const s = await makeSystem({ commitFault: { target, errcode } });
    try {
      await seedThreadForAdmission(s);
      const command = { ...queuedCommand(s.threadId), connectionId: newConnection };
      const failure = await s
        .run(
          s.coordinator.dispatchQueuedTurn({
            command,
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          }),
        )
        .catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ cause: { code } });
      expect(s.operation()?.state).toBe(errcode === 19 ? "failed" : "verified");
    } finally {
      await s.dispose();
    }
  });

  it("also preserves the direct turn-start switch journal on transient SQLite I/O", async () => {
    const s = await makeSystem({ commitFault: { target: "binding", errcode: 10 } });
    try {
      await seedThreadForAdmission(s);
      const queued = queuedCommand(s.threadId);
      await expect(
        s.run(
          s.coordinator.dispatchTurnStart({
            command: {
              type: "thread.turn.start",
              commandId: queued.commandId,
              threadId: s.threadId,
              turnId: queued.turnId,
              message: {
                messageId: queued.messageId,
                role: "user",
                text: "Continue",
                attachments: [],
              },
              modelSelection: queued.modelSelection,
              connectionId: newConnection,
              bindingRevision: queued.bindingRevision,
              runtimeMode: queued.runtimeMode,
              dispatchMode: queued.dispatchMode,
              createdAt: queued.createdAt,
            },
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: "provider_switch_commit_retryable" } });
      expect(s.operation()?.state).toBe("verified");
    } finally {
      await s.dispose();
    }
  });

  it("treats a binding compare-and-swap refusal as terminal", async () => {
    const s = await makeSystem({ bindingCasConflict: true });
    try {
      await seedThreadForAdmission(s);
      const command = { ...queuedCommand(s.threadId), connectionId: newConnection };
      await expect(
        s.run(
          s.coordinator.dispatchQueuedTurn({
            command,
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: "provider_binding_stale" } });
      expect(s.operation()?.state).toBe("failed");
    } finally {
      await s.dispose();
    }
  });
  it.each(["connection_unauthorized", "provider_mismatch"] as const)(
    "preserves the %s resolver refusal for a queued admission",
    async (code) => {
      const s = await makeSystem({ resolverFailure: code });
      try {
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

  it("identifies a failed persisted switch without inspecting its reason text", async () => {
    const s = await makeSystem();
    try {
      const command = queuedCommand(s.threadId);
      s.setOperation({
        id: `provider-switch:${command.commandId}`,
        state: "failed",
        commandJson: JSON.stringify(command),
        selectionJson: JSON.stringify({
          threadId: s.threadId,
          harness: "codex",
          connectionId: oldConnection,
          connectionLabel: "Test",
          previousConnectionId: oldConnection,
          previousModelId: oldModel,
          previousInstallationId: installationId,
          installationId,
          internalProviderId: null,
          modelId: oldModel,
          modelLabel: oldModel,
          stateRevision: 0,
          bindingRevision: 1,
          changed: false,
          requiresNativeStateMaterialization: false,
        }),
        failureReason: "A verified provider switch may only accompany a thread turn start.",
      });
      await expect(
        s.run(
          s.coordinator.dispatchQueuedTurn({
            command,
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          }),
        ),
      ).rejects.toMatchObject({
        code: "switch_operation_failed",
        detail: "A verified provider switch may only accompany a thread turn start.",
      });
    } finally {
      await s.dispose();
    }
  });

  it("allows a transient selection lookup to be retried", async () => {
    const s = await makeSystem({ resolverFailure: "selection_failed", failResolverOnce: true });
    try {
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
      ).rejects.not.toMatchObject({ code: "switch_operation_failed" });
    } finally {
      await s.dispose();
    }
  });

  it("keeps an open switch journal retryable after a transient settled-source lookup", async () => {
    const s = await makeSystem({ resolverFailure: "selection_failed", failResolverOnCall: 2 });
    try {
      const command = { ...queuedCommand(s.threadId), connectionId: newConnection };
      await expect(
        s.run(
          s.coordinator.dispatchQueuedTurn({
            command,
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          }),
        ),
      ).rejects.toMatchObject({ code: "selection_failed" });
      expect(s.operation()?.state).toBe("pending");
      await expect(
        s.run(
          s.coordinator.dispatchQueuedTurn({
            command,
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          }),
        ),
      ).rejects.not.toMatchObject({ code: "switch_operation_failed" });
      expect(s.resolverCalls()).toBe(3);
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
          s.engine.dispatch({
            type: "space.create",
            commandId: CommandId.makeUnsafe("queued-space"),
            spaceId: SpaceId.makeUnsafe("queued-space"),
            name: "Test",
            icon: "home",
            createdAt: at,
          }),
        );
        await s.run(
          s.engine.dispatch({
            type: "folder.create",
            commandId: CommandId.makeUnsafe("queued-folder"),
            folderId,
            spaceId: SpaceId.makeUnsafe("queued-space"),
            title: "Test",
            workspaceRoot: null,
            defaultModelSelection: null,
            createdAt: at,
          }),
        );
        await s.run(
          s.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("queued-thread"),
            threadId: s.threadId,
            deckId: singletonThreadDeckId(s.threadId),
            folderId,
            title: "Test",
            modelSelection: { provider: "codex", model: oldModel },
            runtimeMode: "full-access",
            createdAt: at,
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
              runtimeMode: "full-access",
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
              runtimeMode: "full-access",
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
            s.engine.dispatch({
              type: "thread.update",
              commandId: CommandId.makeUnsafe(`queued-update-${kind}`),
              threadId: s.threadId,
              ...(kind === "model"
                ? { modelSelection: { provider: "codex", model: desiredModel } }
                : { connectionId: desiredConnection }),
            }),
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
              bindingRevision: s.binding().revision,
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
            bindingRevision: kind === "unchanged" ? 1 : 2,
          },
        });
        expect(s.binding()).toMatchObject({
          connectionId: desiredConnection,
          modelId: desiredModel,
          revision: kind === "unchanged" ? 1 : 2,
        });
        expect(s.operation()?.state).toBe(kind === "unchanged" ? undefined : "committed");
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
