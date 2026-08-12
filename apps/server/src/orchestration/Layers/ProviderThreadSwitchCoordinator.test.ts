import {
  CommandId,
  MessageId,
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
  type OrchestrationCommand,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../../managedAttachmentPrincipal.ts";
import {
  ProviderNativeForkOperationRepository,
  type ProviderNativeForkOperationRecord,
} from "../../persistence/Services/ProviderNativeForkOperations.ts";
import {
  ProviderThreadSwitchOperationRepository,
  type ProviderThreadSwitchOperationRecord,
} from "../../persistence/Services/ProviderThreadSwitchOperations.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderLaunchResolver } from "../../provider/Services/ProviderLaunchResolver.ts";
import { ProviderNativeContinuationVerifier } from "../../provider/Services/ProviderNativeContinuationVerifier.ts";
import { ProviderNativeStateMaterializer } from "../../provider/Services/ProviderNativeStateMaterializer.ts";
import {
  ProviderTurnSelectionResolver,
  type ResolvedProviderTurnSelection,
} from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderThreadSwitchCoordinator } from "../Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderThreadSwitchCoordinatorLive } from "./ProviderThreadSwitchCoordinator.ts";

const timestamp = "2026-08-08T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("switch-thread");
const sourceConnectionId = ProviderConnectionId.makeUnsafe("connection-personal");
const targetConnectionId = ProviderConnectionId.makeUnsafe("connection-work");
const installationId = ProviderInstallationId.makeUnsafe("installation-opencode");
const forkSourceThreadId = ThreadId.makeUnsafe("fork-source-thread");

const command = {
  type: "thread.turn.start",
  commandId: CommandId.makeUnsafe("command-switch"),
  threadId,
  message: {
    messageId: MessageId.makeUnsafe("message-switch"),
    role: "user",
    text: "Continue",
    attachments: [],
  },
  modelSelection: { provider: "opencode", model: "opencode-go/kimi-k2.5" },
  connectionId: targetConnectionId,
  bindingRevision: 4,
  runtimeMode: "full-access",
  dispatchMode: "queue",
  createdAt: timestamp,
} satisfies Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const selection: ResolvedProviderTurnSelection = {
  threadId,
  harness: "opencode",
  connectionId: targetConnectionId,
  connectionLabel: "Work",
  previousConnectionId: sourceConnectionId,
  previousModelId: "opencode-go/kimi-k2.5",
  installationId,
  internalProviderId: "opencode-go",
  modelId: "opencode-go/kimi-k2.5",
  modelLabel: "Kimi K2.5",
  stateRevision: 2,
  bindingRevision: 4,
  changed: true,
  requiresNativeStateMaterialization: true,
};

let operation: ProviderThreadSwitchOperationRecord | undefined;
let nativeForkOperation: ProviderNativeForkOperationRecord | undefined;
const currentNativeForkOperation = () => nativeForkOperation;
let projectedForkSourceThreadId: ThreadId | null = null;
let projectedHistoricalThread = false;
let projectionSettlementReadCount = 0;
let projectedRunningReadsRemaining = 0;
const currentOperation = () => operation;
let activeTurn = true;
let discardCount = 0;
let dispatchCount = 0;
let failAfterCommit = false;
let hasBinding = true;
let modelOnlySelection = false;
let acceptedProviderSwitchContext: unknown;
let initialContext: unknown;
let dispatchedCommand: OrchestrationCommand | undefined;
const currentDispatchedCommand = () => dispatchedCommand;
let unchangedSelection = false;
let resolvedStateRevision = 2;
let advanceStateRevisionOnInterrupt = false;
let verifiedStateRevision: number | undefined;
const order: string[] = [];

const dependencies = Layer.mergeAll(
  Layer.succeed(ProjectionSnapshotQuery, {
    getThreadShellById: () =>
      Effect.sync(() => {
        if (projectedForkSourceThreadId !== null) {
          return Option.some({ forkSourceThreadId: projectedForkSourceThreadId });
        }
        if (projectedHistoricalThread) {
          return Option.some({
            forkSourceThreadId: null,
            latestTurnId: "historical-turn",
            latestUserMessageAt: timestamp,
          });
        }
        projectionSettlementReadCount += 1;
        if (projectedRunningReadsRemaining > 0) {
          projectedRunningReadsRemaining -= 1;
          return Option.some({
            session: { status: "running", activeTurnId: "projected-turn" },
          });
        }
        return Option.none();
      }),
  } as never),
  Layer.succeed(ProviderLaunchResolver, {
    resolveProfile: () =>
      Effect.succeed({
        binaryPath: "/managed/opencode",
        isolationKey: "fork-isolation",
        profileRoot: "/managed/profile",
        nativeStateRoot: "/managed/native",
        connectionId: null,
        installationId,
        childEnvironment: (environment: NodeJS.ProcessEnv) => environment,
      }),
    resolve: () => Effect.die("not expected"),
  }),
  Layer.succeed(ProviderNativeForkOperationRepository, {
    begin: (input: ProviderNativeForkOperationRecord) =>
      Effect.sync(() => {
        nativeForkOperation = input;
        order.push("fork-journal");
        return input;
      }),
    get: () =>
      Effect.succeed(nativeForkOperation ? Option.some(nativeForkOperation) : Option.none()),
    listOpen: () => Effect.succeed([]),
    transition: (input: {
      state: ProviderNativeForkOperationRecord["state"];
      failureReason: string | null;
      forkResultJson?: string | null;
      updatedAt: string;
    }) =>
      Effect.sync(() => {
        if (!nativeForkOperation) return Option.none();
        order.push(input.state);
        nativeForkOperation = {
          ...nativeForkOperation,
          state: input.state,
          failureReason: input.failureReason,
          forkResultJson: input.forkResultJson ?? nativeForkOperation.forkResultJson,
          updatedAt: input.updatedAt,
        };
        return Option.some(nativeForkOperation);
      }),
    markCommittedInCurrentTransaction: (input: { id: string; updatedAt: string }) =>
      Effect.sync(() => {
        if (!nativeForkOperation || nativeForkOperation.id !== input.id) return Option.none();
        order.push("committed");
        nativeForkOperation = {
          ...nativeForkOperation,
          state: "committed",
          failureReason: null,
          updatedAt: input.updatedAt,
        };
        return Option.some(nativeForkOperation);
      }),
  }),
  Layer.succeed(ThreadProviderBindingRepository, {
    getHarnessState: (requestedThreadId: ThreadId) =>
      Effect.succeed(
        hasBinding || requestedThreadId === forkSourceThreadId
          ? Option.some({
              threadId: requestedThreadId,
              harness: "opencode",
              nativeStateGenerationId:
                ProviderNativeStateGenerationId.makeUnsafe("source-generation"),
              providerSessionId: "native-session",
              nativeStateLocatorJson: '{"openCodeSessionId":"native-session"}',
              lastVerifiedResumeAt: timestamp,
              revision: 2,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
          : Option.none(),
      ),
    getRuntimeBinding: (requestedThreadId: ThreadId) =>
      Effect.succeed(
        hasBinding || requestedThreadId === forkSourceThreadId
          ? Option.some({
              threadId: requestedThreadId,
              connectionId: sourceConnectionId,
              installationId,
              internalProviderId: "opencode-go",
              modelId: "opencode-go/kimi-k2.5",
              revision: 4,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
          : Option.none(),
      ),
  } as never),
  Layer.succeed(ProviderTurnSelectionResolver, {
    resolveNewThreadConnection: () => Effect.die("not expected"),
    resolveInitial: (input: { nativeStateGenerationId: ProviderNativeStateGenerationId }) =>
      Effect.succeed({
        selection: {
          ...selection,
          connectionId: null,
          previousConnectionId: null,
          previousModelId: null,
          stateRevision: 0,
          bindingRevision: 0,
          changed: false,
          requiresNativeStateMaterialization: false,
        },
        initialization: {
          generation: {
            id: input.nativeStateGenerationId,
            ownerThreadId: threadId,
            harness: "opencode",
            adapterSchemaVersion: "managed-native-state-v1",
            stateManifestJson: "{}",
            createdAt: timestamp,
          },
          threadId,
          providerSessionId: null,
          nativeStateLocatorJson: "null",
          connectionId: null,
          installationId,
          internalProviderId: "opencode",
          modelId: "opencode/big-pickle",
          modelLabel: "Big Pickle",
          createdAt: timestamp,
        },
      }),
    resolveExisting: () =>
      Effect.succeed(
        unchangedSelection
          ? {
              ...selection,
              stateRevision: resolvedStateRevision,
              connectionId: sourceConnectionId,
              previousConnectionId: sourceConnectionId,
              changed: false,
              requiresNativeStateMaterialization: false,
            }
          : modelOnlySelection
            ? {
                ...selection,
                stateRevision: resolvedStateRevision,
                connectionId: sourceConnectionId,
                previousConnectionId: sourceConnectionId,
                previousModelId: "opencode-go/kimi-k2.5",
                modelId: "opencode-go/glm-5.1",
                modelLabel: "GLM-5.1",
                requiresNativeStateMaterialization: false,
              }
            : { ...selection, stateRevision: resolvedStateRevision },
      ),
  }),
  Layer.succeed(ProviderThreadSwitchOperationRepository, {
    begin: (input: ProviderThreadSwitchOperationRecord) =>
      Effect.sync(() => {
        order.push("journal");
        operation = input;
        return input;
      }),
    get: () => Effect.succeed(operation ? Option.some(operation) : Option.none()),
    listOpen: () => Effect.sync(() => (operation ? [operation] : [])),
    markInterruptedWithSettledSelection: (input: {
      sourceStateRevision: number;
      sourceBindingRevision: number;
      selectionJson: string;
      updatedAt: string;
    }) =>
      Effect.sync(() => {
        if (!operation) return Option.none();
        order.push("interrupted");
        operation = {
          ...operation,
          state: "interrupted",
          sourceStateRevision: input.sourceStateRevision,
          sourceBindingRevision: input.sourceBindingRevision,
          selectionJson: input.selectionJson,
          updatedAt: input.updatedAt,
        };
        return Option.some(operation);
      }),
    transition: (input: {
      state: ProviderThreadSwitchOperationRecord["state"];
      failureReason: string | null;
      verificationJson?: string | null;
      updatedAt: string;
    }) =>
      Effect.sync(() => {
        if (!operation) return Option.none();
        order.push(input.state);
        operation = {
          ...operation,
          state: input.state,
          failureReason: input.failureReason,
          verificationJson: input.verificationJson ?? operation.verificationJson,
          updatedAt: input.updatedAt,
        };
        return Option.some(operation);
      }),
    markCommittedInCurrentTransaction: () =>
      Effect.succeed(operation ? Option.some(operation) : Option.none()),
  } as never),
  Layer.succeed(ProviderService, {
    listSessions: () =>
      Effect.succeed(
        activeTurn
          ? [
              {
                threadId,
                status: "running",
                activeTurnId: "turn-active",
              },
            ]
          : [],
      ),
    interruptTurn: () =>
      Effect.sync(() => {
        order.push("interrupt");
        activeTurn = false;
        if (advanceStateRevisionOnInterrupt) resolvedStateRevision += 1;
      }),
    forkThread: (input: { threadId: ThreadId }) =>
      Effect.sync(() => {
        order.push("fork-provider");
        return {
          threadId: input.threadId,
          resumeCursor: { openCodeSessionId: "forked-native-session", cwd: "/workspace" },
        };
      }),
    stopSession: () => Effect.void,
  } as never),
  Layer.succeed(ProviderNativeContinuationVerifier, {
    verifySwitch: (input: { selection: ResolvedProviderTurnSelection }) =>
      Effect.sync(() => {
        order.push("verify");
        verifiedStateRevision = input.selection.stateRevision;
        return {
          generationId: ProviderNativeStateGenerationId.makeUnsafe(
            `provider-switch-generation:${command.commandId}`,
          ),
          adapterSchemaVersion: "managed-native-state-v1",
          stateManifestJson: "{}",
          providerSessionId: "native-session",
          nativeStateLocatorJson: '{"openCodeSessionId":"native-session"}',
          verifiedAt: timestamp,
        };
      }),
  }),
  Layer.succeed(ProviderNativeStateMaterializer, {
    clone: () =>
      Effect.sync(() => {
        order.push("fork-clone");
        return "/target";
      }),
    discard: () =>
      Effect.sync(() => {
        discardCount += 1;
        if (projectedForkSourceThreadId !== null) order.push("fork-discard-empty");
      }),
    finalize: () => Effect.void,
  }),
  Layer.succeed(OrchestrationEngineService, {
    dispatch: (
      dispatched: OrchestrationCommand,
      context?: {
        acceptedProviderSwitch?: unknown;
        acceptedInitialProviderBinding?: unknown;
        acceptedInitialProviderForkOperationId?: string;
      },
    ) =>
      Effect.gen(function* () {
        dispatchCount += 1;
        dispatchedCommand = dispatched;
        order.push("dispatch");
        initialContext = context?.acceptedInitialProviderBinding;
        acceptedProviderSwitchContext = context?.acceptedProviderSwitch;
        if (context?.acceptedInitialProviderForkOperationId && nativeForkOperation) {
          order.push("committed");
          nativeForkOperation = {
            ...nativeForkOperation,
            state: "committed",
            failureReason: null,
            updatedAt: timestamp,
          };
        }
        if (context?.acceptedProviderSwitch && operation) {
          operation = { ...operation, state: "committed", updatedAt: timestamp };
        }
        if (failAfterCommit) return yield* Effect.fail(new Error("response lost after commit"));
        return { sequence: 42 };
      }),
  } as never),
);

const layer = it.layer(
  Layer.mergeAll(
    dependencies,
    ProviderThreadSwitchCoordinatorLive.pipe(Layer.provide(dependencies)),
  ),
);

layer("ProviderThreadSwitchCoordinator", (it) => {
  it.effect("adds the exact durable binding to an unchanged agent send", () =>
    Effect.gen(function* () {
      hasBinding = true;
      operation = undefined;
      unchangedSelection = true;
      dispatchedCommand = undefined;
      const coordinator = yield* ProviderThreadSwitchCoordinator;
      yield* coordinator.dispatchTurnStart({
        command: {
          ...command,
          commandId: CommandId.makeUnsafe("command-unchanged"),
          connectionId: undefined,
          bindingRevision: undefined,
          modelSelection: undefined,
        },
        attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
      });
      const sent = currentDispatchedCommand();
      assert.strictEqual(sent?.type, "thread.turn.start");
      if (sent?.type === "thread.turn.start") {
        assert.strictEqual(sent.connectionId, sourceConnectionId);
        assert.strictEqual(sent.bindingRevision, 4);
      }
      unchangedSelection = false;
    }),
  );

  it.effect("journals a model-only change without cloning or verifying native state", () =>
    Effect.gen(function* () {
      hasBinding = true;
      activeTurn = false;
      operation = undefined;
      modelOnlySelection = true;
      acceptedProviderSwitchContext = undefined;
      order.length = 0;
      const coordinator = yield* ProviderThreadSwitchCoordinator;

      const result = yield* coordinator.dispatchTurnStart({
        command: {
          ...command,
          commandId: CommandId.makeUnsafe("command-model-only"),
          connectionId: sourceConnectionId,
          bindingRevision: 4,
          modelSelection: { provider: "opencode", model: "opencode-go/glm-5.1" },
        },
        attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
      });

      assert.strictEqual(result.sequence, 42);
      assert.deepStrictEqual(order, ["journal", "interrupted", "verified", "dispatch"]);
      assert.notInclude(order, "verify");
      assert.strictEqual(currentOperation()?.targetNativeStateGenerationId, null);
      const sent = currentDispatchedCommand();
      assert.strictEqual(sent?.type, "thread.turn.start");
      if (sent?.type === "thread.turn.start") {
        assert.strictEqual(sent.bindingRevision, 5);
        assert.strictEqual(sent.modelSelection?.model, "opencode-go/glm-5.1");
      }
      assert.strictEqual(
        (acceptedProviderSwitchContext as { commit: { kind: string } }).commit.kind,
        "runtime-binding",
      );
      modelOnlySelection = false;
    }),
  );

  it.effect("resolves and commits the default initial binding with the first message", () =>
    Effect.gen(function* () {
      hasBinding = false;
      projectedHistoricalThread = false;
      operation = undefined;
      initialContext = undefined;
      failAfterCommit = false;
      order.length = 0;
      const coordinator = yield* ProviderThreadSwitchCoordinator;
      const result = yield* coordinator.dispatchTurnStart({
        command: {
          ...command,
          commandId: CommandId.makeUnsafe("command-initial"),
          modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
          connectionId: undefined,
          bindingRevision: 0,
        },
        attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
      });
      assert.strictEqual(result.sequence, 42);
      assert.strictEqual(
        (initialContext as { nativeStateLocatorJson: string }).nativeStateLocatorJson,
        "null",
      );
      const sent = currentDispatchedCommand();
      assert.strictEqual(sent?.type, "thread.turn.start");
      if (sent?.type === "thread.turn.start") {
        assert.strictEqual(sent.connectionId, null);
        assert.strictEqual(sent.bindingRevision, 0);
      }
      assert.deepStrictEqual(order, ["dispatch"]);
    }),
  );

  it.effect("requires a new Thread when an existing transcript has no managed binding", () =>
    Effect.gen(function* () {
      hasBinding = false;
      projectedHistoricalThread = true;
      operation = undefined;
      const coordinator = yield* ProviderThreadSwitchCoordinator;
      const result = yield* Effect.exit(
        coordinator.dispatchTurnStart({
          command: {
            ...command,
            commandId: CommandId.makeUnsafe("command-pre-connections-thread"),
            modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
            connectionId: null,
            bindingRevision: 0,
          },
          attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        }),
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(String(result.cause), /Start a new Thread/);
      }
      projectedHistoricalThread = false;
    }),
  );

  it.effect(
    "journals before interruption, verifies, commits, and retries without destructive cleanup",
    () =>
      Effect.gen(function* () {
        hasBinding = true;
        operation = undefined;
        activeTurn = true;
        discardCount = 0;
        dispatchCount = 0;
        failAfterCommit = false;
        order.length = 0;
        const coordinator = yield* ProviderThreadSwitchCoordinator;

        const steeredCommand = { ...command, dispatchMode: "steer" as const };
        const first = yield* coordinator.dispatchTurnStart({
          command: steeredCommand,
          attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          cwd: "/workspace",
        });
        assert.strictEqual(first.sequence, 42);
        assert.deepStrictEqual(order.slice(0, 6), [
          "journal",
          "interrupt",
          "interrupted",
          "verify",
          "verified",
          "dispatch",
        ]);
        assert.strictEqual(currentOperation()?.state, "committed");
        assert.strictEqual(currentOperation()?.cwd, "/workspace");

        order.length = 0;
        const retry = yield* coordinator.dispatchTurnStart({
          command: steeredCommand,
          attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          cwd: "/different-client-value",
        });
        assert.strictEqual(retry.sequence, 42);
        assert.deepStrictEqual(order, ["dispatch"]);
        assert.strictEqual(discardCount, 0);

        operation = undefined;
        activeTurn = false;
        order.length = 0;
        failAfterCommit = true;
        const uncertain = yield* Effect.exit(
          coordinator.dispatchTurnStart({
            command: { ...command, commandId: CommandId.makeUnsafe("command-uncertain") },
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
            cwd: "/workspace",
          }),
        );
        assert.strictEqual(uncertain._tag, "Failure");
        assert.strictEqual(currentOperation()?.state, "committed");
        assert.strictEqual(discardCount, 0);
        assert.strictEqual(dispatchCount, 4);
      }),
  );

  it.effect("keeps the active turn running while a queued Connection switch waits", () =>
    Effect.gen(function* () {
      hasBinding = true;
      operation = undefined;
      activeTurn = true;
      projectionSettlementReadCount = 0;
      failAfterCommit = false;
      order.length = 0;
      dispatchedCommand = undefined;
      const coordinator = yield* ProviderThreadSwitchCoordinator;

      const switchFiber = yield* coordinator
        .dispatchTurnStart({
          command: {
            ...command,
            commandId: CommandId.makeUnsafe("command-queued-switch"),
            dispatchMode: "queue",
          },
          attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");

      assert.notInclude(order, "interrupt");
      assert.deepStrictEqual(order, ["journal"]);
      activeTurn = false;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(switchFiber);

      assert.notInclude(order, "interrupt");
      assert.deepStrictEqual(order.slice(0, 5), [
        "journal",
        "interrupted",
        "verify",
        "verified",
        "dispatch",
      ]);
      const sent = currentDispatchedCommand();
      assert.strictEqual(sent?.type, "thread.turn.start");
      if (sent?.type === "thread.turn.start") {
        assert.strictEqual(sent.dispatchMode, "queue");
        assert.strictEqual(sent.connectionId, targetConnectionId);
      }
    }),
  );

  it.effect("settles a live turn before accepting a steered Connection switch", () =>
    Effect.gen(function* () {
      hasBinding = true;
      operation = undefined;
      activeTurn = true;
      projectionSettlementReadCount = 0;
      failAfterCommit = false;
      order.length = 0;
      dispatchedCommand = undefined;
      const coordinator = yield* ProviderThreadSwitchCoordinator;

      yield* coordinator.dispatchTurnStart({
        command: {
          ...command,
          commandId: CommandId.makeUnsafe("command-steered-switch"),
          dispatchMode: "steer",
        },
        attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
      });

      assert.deepStrictEqual(order.slice(0, 6), [
        "journal",
        "interrupt",
        "interrupted",
        "verify",
        "verified",
        "dispatch",
      ]);
      assert.strictEqual(projectionSettlementReadCount, 1);
      const sent = currentDispatchedCommand();
      assert.strictEqual(sent?.type, "thread.turn.start");
      if (sent?.type === "thread.turn.start") {
        assert.strictEqual(sent.dispatchMode, "steer");
        assert.strictEqual(sent.connectionId, targetConnectionId);
        assert.strictEqual(sent.bindingRevision, 5);
      }
    }),
  );

  it.effect("pins a steered switch to the native state persisted by settlement", () =>
    Effect.gen(function* () {
      hasBinding = true;
      operation = undefined;
      activeTurn = true;
      resolvedStateRevision = 2;
      advanceStateRevisionOnInterrupt = true;
      verifiedStateRevision = undefined;
      order.length = 0;
      const coordinator = yield* ProviderThreadSwitchCoordinator;

      yield* coordinator.dispatchTurnStart({
        command: {
          ...command,
          commandId: CommandId.makeUnsafe("command-steered-settled-source"),
          dispatchMode: "steer",
        },
        attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
      });

      assert.strictEqual(currentOperation()?.sourceStateRevision, 3);
      assert.strictEqual(verifiedStateRevision, 3);
      assert.deepStrictEqual(order.slice(0, 6), [
        "journal",
        "interrupt",
        "interrupted",
        "verify",
        "verified",
        "dispatch",
      ]);
      advanceStateRevisionOnInterrupt = false;
      resolvedStateRevision = 2;
    }),
  );

  it.effect("waits for a processless durable turn to settle before switching", () =>
    Effect.gen(function* () {
      hasBinding = true;
      operation = undefined;
      activeTurn = false;
      projectedRunningReadsRemaining = 1;
      projectionSettlementReadCount = 0;
      order.length = 0;
      const coordinator = yield* ProviderThreadSwitchCoordinator;

      const switchFiber = yield* coordinator
        .dispatchTurnStart({
          command: {
            ...command,
            commandId: CommandId.makeUnsafe("command-projection-settlement"),
          },
          attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("50 millis");
      yield* Fiber.join(switchFiber);

      assert.isAtLeast(projectionSettlementReadCount, 2);
      assert.notInclude(order, "interrupt");
      assert.deepStrictEqual(order.slice(0, 4), ["journal", "interrupted", "verify", "verified"]);
    }),
  );

  it.effect("recovers a pending switch against the exact settled native source", () =>
    Effect.gen(function* () {
      hasBinding = true;
      activeTurn = false;
      resolvedStateRevision = 3;
      order.length = 0;
      const recoveryCommand = {
        ...command,
        commandId: CommandId.makeUnsafe("command-recover-settled-source"),
        dispatchMode: "steer" as const,
      };
      operation = {
        id: "provider-switch:command-recover-settled-source",
        threadId,
        commandId: recoveryCommand.commandId,
        kind: "native-state",
        state: "pending",
        sourceStateRevision: 2,
        sourceBindingRevision: 4,
        targetNativeStateGenerationId: ProviderNativeStateGenerationId.makeUnsafe(
          "provider-switch-generation:command-recover-settled-source",
        ),
        selectionJson: JSON.stringify(selection),
        commandJson: JSON.stringify(recoveryCommand),
        cwd: null,
        verificationJson: null,
        failureReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const coordinator = yield* ProviderThreadSwitchCoordinator;

      yield* coordinator.recoverOpen;

      assert.strictEqual(currentOperation()?.sourceStateRevision, 3);
      assert.strictEqual(currentOperation()?.state, "committed");
      assert.deepStrictEqual(order.slice(0, 4), ["interrupted", "verify", "verified", "dispatch"]);
      resolvedStateRevision = 2;
      operation = undefined;
    }),
  );

  it.effect("clones, natively forks, verifies, and commits the first turn crash-safely", () =>
    Effect.gen(function* () {
      hasBinding = false;
      operation = undefined;
      nativeForkOperation = undefined;
      projectedForkSourceThreadId = forkSourceThreadId;
      initialContext = undefined;
      failAfterCommit = false;
      discardCount = 0;
      order.length = 0;
      const coordinator = yield* ProviderThreadSwitchCoordinator;
      const result = yield* coordinator.dispatchTurnStart({
        command: {
          ...command,
          commandId: CommandId.makeUnsafe("command-native-fork"),
          modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
          connectionId: null,
          bindingRevision: 0,
        },
        attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        cwd: "/workspace",
      });

      assert.strictEqual(result.sequence, 42);
      assert.strictEqual(currentNativeForkOperation()?.state, "committed");
      assert.strictEqual(
        (initialContext as { providerSessionId: string }).providerSessionId,
        "forked-native-session",
      );
      const sent = currentDispatchedCommand();
      assert.strictEqual(sent?.type, "thread.turn.start");
      if (sent?.type === "thread.turn.start") {
        assert.strictEqual(sent.connectionId, null);
        assert.strictEqual(sent.bindingRevision, 0);
      }
      assert.deepStrictEqual(order, [
        "fork-journal",
        "fork-discard-empty",
        "fork-clone",
        "materialized",
        "fork-provider",
        "forked",
        "dispatch",
        "committed",
      ]);
      projectedForkSourceThreadId = null;
    }),
  );
});
