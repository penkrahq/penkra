import {
  CommandId,
  FolderId,
  ProviderConnectionId,
  ProviderInstallationId,
  SpaceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type PenkraCreateThreadInput,
} from "@penkra/contracts";
import { assert, it as effectIt } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { expect, vi } from "vitest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../config.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import { makeCreateThreadHandler, type GatewayCreationContext } from "./creationCoordinator.ts";
import { makeAgentCreationIds, stableGatewayDigest } from "./creationUtils.ts";
import type { AgentGatewayProviderAvailability } from "./targetResolver.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import {
  ProviderAdapterValidationError,
  type ProviderAdapterError,
  ProviderValidationError,
} from "../provider/Errors.ts";
import { ProviderTurnSelectionResolver } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import { ProviderTurnSelectionResolverLive } from "../provider/Layers/ProviderTurnSelectionResolver.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import {
  ProviderLaunchResolver,
  type ProviderLaunchResolverShape,
} from "../provider/Services/ProviderLaunchResolver.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import {
  ProviderNativeContinuationVerifier,
  type ProviderNativeContinuationVerifierShape,
} from "../provider/Services/ProviderNativeContinuationVerifier.ts";
import {
  ProviderNativeStateMaterializer,
  type ProviderNativeStateMaterializerShape,
} from "../provider/Services/ProviderNativeStateMaterializer.ts";
import { ProviderConnectionRepositoryLive } from "../persistence/Layers/ProviderConnections.ts";
import { ProviderInstallationRepositoryLive } from "../persistence/Layers/ProviderInstallations.ts";
import { ProviderNativeForkOperationRepositoryLive } from "../persistence/Layers/ProviderNativeForkOperations.ts";
import { AgentGatewayCreationAdmissionRepositoryLive } from "../persistence/Layers/AgentGatewayCreationAdmissions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AgentGatewayCreationAdmissionRepository } from "../persistence/Services/AgentGatewayCreationAdmissions.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ThreadProviderBindingRepository } from "../persistence/Services/ThreadProviderBindings.ts";
import { ThreadDiagnosticsQuery } from "../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import { ThreadDiagnosticsQueryLive } from "../diagnostics/Layers/ThreadDiagnosticsQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderThreadSwitchCoordinatorLive } from "../orchestration/Layers/ProviderThreadSwitchCoordinator.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const NOW_A = "2026-09-07T06:00:00.000Z";
const NOW_B = "2026-09-07T06:00:01.000Z";
const SPACE_ID = SpaceId.makeUnsafe("retained-space");
const FOLDER_ID = FolderId.makeUnsafe("retained-folder");
const CALLER_THREAD_ID = ThreadId.makeUnsafe("retained-caller");
const CALLER_TURN_ID = TurnId.makeUnsafe("retained-caller-turn");
const ACCOUNT_A = ProviderConnectionId.makeUnsafe("retained-account-a");
const ACCOUNT_B = ProviderConnectionId.makeUnsafe("retained-account-b");
const INSTALLATION_ID = ProviderInstallationId.makeUnsafe("retained-installation");
const TARGET: ModelSelection = { provider: "codex", model: "gpt-5.5" };
const INPUT: PenkraCreateThreadInput = {
  requestId: "retained-thread-request",
  prompt: "retry the retained thread",
  target: TARGET,
};

const CALLER: OrchestrationThreadShell = {
  id: CALLER_THREAD_ID,
  folderId: FOLDER_ID,
  title: "Retained caller",
  modelSelection: TARGET,
  runtimeMode: "full-access",
  isPinned: false,
  parentThreadId: null,
  subagentAgentId: null,
  subagentNickname: null,
  subagentRole: null,
  forkSourceThreadId: null,
  latestTurn: null,
  latestUserMessageAt: null,
  createdAt: NOW_A,
  updatedAt: NOW_A,
  archivedAt: null,
  session: null,
};

const operationId = `gateway:create:${stableGatewayDigest({
  principalKind: "provider-session",
  principalId: CALLER_THREAD_ID,
  callerTurnId: CALLER_TURN_ID,
  requestId: INPUT.requestId,
})}`;
const ids = makeAgentCreationIds(operationId, 0);
const childTurnId = TurnId.makeUnsafe(`turn:${ids.turnStartCommandId}`);

let catalogFailure = true;
let catalogCalls = 0;
let catalogFailureCause: ProviderAdapterValidationError | null = null;

const fixtureAdapter: ProviderAdapterShape<ProviderAdapterError> = {
  provider: "codex",
  capabilities: { sessionModelSwitch: "unsupported" },
  startSession: () => Effect.die("fixture adapter startSession is not used"),
  sendTurn: () => Effect.die("fixture adapter sendTurn is not used"),
  interruptTurn: () => Effect.die("fixture adapter interruptTurn is not used"),
  respondToRequest: () => Effect.die("fixture adapter respondToRequest is not used"),
  respondToUserInput: () => Effect.die("fixture adapter respondToUserInput is not used"),
  stopSession: () => Effect.die("fixture adapter stopSession is not used"),
  listSessions: () => Effect.succeed([]),
  hasSession: () => Effect.succeed(false),
  readThread: () => Effect.die("fixture adapter readThread is not used"),
  rollbackThread: () => Effect.die("fixture adapter rollbackThread is not used"),
  stopAll: () => Effect.die("fixture adapter stopAll is not used"),
  drainRuntimeEvents: Effect.void,
  streamEvents: Stream.empty,
  listModels: () => {
    catalogCalls += 1;
    if (catalogFailure) {
      catalogFailure = false;
      const failure = new ProviderAdapterValidationError({
        provider: "codex",
        operation: "listModels",
        issue: "controlled fail-once catalog",
      });
      catalogFailureCause = failure;
      return Effect.fail(failure);
    }
    return Effect.succeed({
      models: [{ slug: TARGET.model, name: "GPT-5.5 fixture" }],
      source: "controlled-retry",
    });
  },
};

const fixtureLaunchResolver: ProviderLaunchResolverShape = {
  resolveProfile: (input) =>
    Effect.succeed({
      binaryPath: "/fixture/codex",
      isolationKey: `fixture:${input.connectionId ?? "anonymous"}`,
      profileRoot: "/fixture/profile",
      nativeStateRoot: "/fixture/native",
      connectionId: input.connectionId,
      installationId: input.installationId,
      childEnvironment: (environment: NodeJS.ProcessEnv) => environment,
    }),
  resolve: () => Effect.die("fixture launch resolve is not used by initial admission"),
};

const fixtureProvider: ProviderServiceShape = {
  startSession: () => Effect.die("fixture provider startSession is not used"),
  sendTurn: () => Effect.die("fixture provider sendTurn is not used"),
  steerTurn: () => Effect.die("fixture provider steerTurn is not used"),
  startReview: () => Effect.die("fixture provider startReview is not used"),
  interruptTurn: () => Effect.die("fixture provider interruptTurn is not used"),
  stopTask: () => Effect.die("fixture provider stopTask is not used"),
  backgroundTask: () => Effect.die("fixture provider backgroundTask is not used"),
  steerSubagent: () => Effect.die("fixture provider steerSubagent is not used"),
  respondToRequest: () => Effect.die("fixture provider respondToRequest is not used"),
  respondToUserInput: () => Effect.die("fixture provider respondToUserInput is not used"),
  stopSession: () => Effect.die("fixture provider stopSession is not used"),
  listSessions: () => Effect.succeed([]),
  getCapabilities: () => Effect.die("fixture provider getCapabilities is not used"),
  rollbackConversation: () => Effect.die("fixture provider rollbackConversation is not used"),
  compactThread: () => Effect.die("fixture provider compactThread is not used"),
  closeRuntimeEvents: Effect.void,
  streamEvents: Stream.empty,
};

const fixtureVerifier: ProviderNativeContinuationVerifierShape = {
  verifySwitch: () => Effect.die("fixture verifier is not used for initial admission"),
};

const fixtureMaterializer: ProviderNativeStateMaterializerShape = {
  clone: () => Effect.die("fixture materializer clone is not used for initial admission"),
  discard: () => Effect.die("fixture materializer discard is not used for initial admission"),
  finalize: () => Effect.die("fixture materializer finalize is not used for initial admission"),
};

const fixtureGatewayDiscovery: ProviderDiscoveryServiceShape = {
  getComposerCapabilities: () => Effect.die("fixture gateway capabilities are not used"),
  getCapabilityHealth: () => Effect.die("fixture gateway health is not used"),
  listCommands: () => Effect.die("fixture gateway commands are not used"),
  listSkills: () => Effect.die("fixture gateway skills are not used"),
  listPlugins: () => Effect.die("fixture gateway plugins are not used"),
  readPlugin: () => Effect.die("fixture gateway plugin reads are not used"),
  listModels: () =>
    Effect.succeed({
      models: [{ slug: TARGET.model, name: "GPT-5.5 gateway fixture" }],
      source: "gateway-fixture",
    }),
  listAgents: () => Effect.die("fixture gateway agents are not used"),
};

const context: GatewayCreationContext = {
  kind: "provider-session",
  callerThreadId: CALLER_THREAD_ID,
  callerTurnId: CALLER_TURN_ID,
  assertAuthority: () => Effect.void,
  attachmentPrincipal: { ownerKind: "session", ownerId: "retained-session" },
};

const baseLayer = Layer.mergeAll(
  OrchestrationLayerLive,
  AgentGatewayCreationAdmissionRepositoryLive,
  ProviderConnectionRepositoryLive,
  ProviderInstallationRepositoryLive,
  ProviderNativeForkOperationRepositoryLive,
  ServerSettingsService.layerTest({
    providers: { codex: { defaultConnectionId: ACCOUNT_A } },
  }),
  Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: () => Effect.succeed(fixtureAdapter),
    listProviders: () => Effect.succeed(["codex"] as const),
  }),
  Layer.succeed(ProviderLaunchResolver, fixtureLaunchResolver),
  Layer.succeed(ProviderService, fixtureProvider),
  Layer.succeed(ProviderNativeContinuationVerifier, fixtureVerifier),
  Layer.succeed(ProviderNativeStateMaterializer, fixtureMaterializer),
  ThreadDiagnosticsQueryLive,
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const selectionLayer = ProviderTurnSelectionResolverLive.pipe(Layer.provide(baseLayer));
const switchLayer = ProviderThreadSwitchCoordinatorLive.pipe(
  Layer.provide(Layer.mergeAll(baseLayer, selectionLayer)),
);
const retainedThreadLayer = Layer.mergeAll(baseLayer, selectionLayer, switchLayer);

effectIt.layer(retainedThreadLayer)("retained Thread creation integration", (it) => {
  it.effect(
    "retains the accepted child on post-create model failure and retries the same plan once",
    () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      return Effect.gen(function* () {
        catalogFailure = true;
        catalogCalls = 0;
        const sql = yield* SqlClient.SqlClient;
        const engine = yield* OrchestrationEngineService;
        const admissions = yield* AgentGatewayCreationAdmissionRepository;
        const commandReceipts = yield* OrchestrationCommandReceiptRepository;
        const eventStore = yield* OrchestrationEventStore;
        const bindings = yield* ThreadProviderBindingRepository;
        const diagnostics = yield* ThreadDiagnosticsQuery;
        const projections = yield* ProjectionSnapshotQuery;
        const resolver = yield* ProviderTurnSelectionResolver;
        const switchCoordinator = yield* ProviderThreadSwitchCoordinator;

        yield* sql`
          INSERT INTO provider_installations (
            installation_id, harness_kind, version, platform, architecture, executable_path,
            artifact_source, artifact_url, artifact_sha256, adapter_version, protocol_version,
            lifecycle, installed_at, activated_at
          ) VALUES (${INSTALLATION_ID}, 'codex', 'fixture', 'test', 'test', '/fixture/codex',
            'test', 'https://example.invalid/codex', ${"a".repeat(64)}, '1', '1',
            'active', ${NOW_A}, ${NOW_A})
        `;
        for (const [id, label, profileRef] of [
          [ACCOUNT_A, "Account A", "test-profile-a"],
          [ACCOUNT_B, "Account B", "test-profile-b"],
        ] as const) {
          yield* sql`
            INSERT INTO provider_connections (
              connection_id, harness_kind, authentication_target_id, authentication_method_id,
              label, profile_ref, lifecycle, created_at, updated_at
            ) VALUES (${id}, 'codex', 'openai-first-party', 'chatgpt', ${label}, ${profileRef},
              'active', ${NOW_A}, ${NOW_A})
          `;
        }

        yield* engine.dispatch({
          type: "space.create",
          commandId: CommandId.makeUnsafe("retained-space-create"),
          spaceId: SPACE_ID,
          name: "Retained",
          icon: "home",
          createdAt: NOW_A,
        });
        yield* engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("retained-folder-create"),
          folderId: FOLDER_ID,
          spaceId: SPACE_ID,
          title: "Retained folder",
          workspaceRoot: null,
          defaultModelSelection: null,
          createdAt: NOW_A,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("retained-caller-create"),
          threadId: CALLER_THREAD_ID,
          folderId: FOLDER_ID,
          title: CALLER.title,
          modelSelection: TARGET,
          runtimeMode: "full-access",
          createdAt: NOW_A,
        });

        const availabilities: ReadonlyMap<"codex", AgentGatewayProviderAvailability> = new Map([
          ["codex", { enabled: true, available: true, authStatus: "authenticated" }],
        ]);
        const dependencies = {
          diagnostics,
          admissions,
          commandReceipts,
          loadExistingBinding: (threadId: ThreadId) => bindings.getRuntimeBinding(threadId),
          snapshotQuery: projections,
          orchestrationEngine: engine,
          providerDiscovery: fixtureGatewayDiscovery,
          providerTurnSelectionResolver: resolver,
          providerThreadSwitchCoordinator: switchCoordinator,
          loadProviderAvailabilities: Effect.succeed(availabilities),
          requireThreadShell: (threadId: string) =>
            projections.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
              Effect.mapError((cause) => new ToolInputError(errorText(cause))),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new ToolInputError("missing fixture thread")),
                  onSome: Effect.succeed,
                }),
              ),
            ),
        } satisfies Parameters<typeof makeCreateThreadHandler>[0];

        vi.setSystemTime(new Date(NOW_A));
        const handler = yield* makeCreateThreadHandler(dependencies);
        const first = yield* handler(INPUT, context);
        assert.isTrue(first.isError);
        const firstText = first.content[0];
        assert.isTrue(firstText?.type === "text");
        if (firstText?.type === "text") {
          assert.include(
            firstText.text,
            "Could not verify the selected model for this Connection.",
          );
          const firstPayload = JSON.parse(firstText.text) as {
            error?: {
              details?: {
                provenance?: Record<string, unknown>;
                diagnosticStatus?: string;
              };
            };
          };
          assert.deepInclude(firstPayload.error?.details?.provenance, {
            source: "provider-adapter",
            errorKind: "ProviderAdapterValidationError",
            provider: "codex",
            operation: "listModels",
            operationTruncated: false,
            method: null,
            methodTruncated: false,
            detail: "controlled fail-once catalog",
            detailTruncated: false,
            causeDepth: 2,
            causeTruncated: false,
          });
          assert.strictEqual(firstPayload.error?.details?.diagnosticStatus, "retained");
        }
        assert.instanceOf(catalogFailureCause, ProviderAdapterValidationError);
        assert.strictEqual(catalogFailureCause?.operation, "listModels");
        assert.strictEqual(catalogFailureCause?.issue, "controlled fail-once catalog");

        const childAfterFailure = Option.getOrThrow(
          yield* projections.getThreadShellById(ids.threadId),
        );
        assert.isNull(childAfterFailure.latestTurn);
        assert.isNull(childAfterFailure.session);
        assert.isTrue(
          Option.isSome(
            yield* commandReceipts.getByCommandId({ commandId: ids.threadCreateCommandId }),
          ),
        );
        assert.isTrue(
          Option.isNone(
            yield* commandReceipts.getByCommandId({ commandId: ids.turnStartCommandId }),
          ),
        );
        assert.isTrue(Option.isNone(yield* bindings.getRuntimeBinding(ids.threadId)));
        assert.strictEqual(catalogCalls, 1);
        const failureDiagnostics = yield* diagnostics.listOperationalDiagnostics({
          threadId: ids.threadId,
          limit: 10,
        });
        const failureDiagnostic = failureDiagnostics.find(
          (diagnostic) => diagnostic.code === "AGENT_GATEWAY_THREAD_CREATE_FAILED",
        );
        assert.isDefined(failureDiagnostic);
        assert.deepInclude(failureDiagnostic?.detail, {
          operationId,
          requestId: INPUT.requestId,
          phase: "thread.create",
          provenanceSource: "provider-adapter",
          provenanceErrorKind: "ProviderAdapterValidationError",
          provenanceProvider: "codex",
          provenanceOperation: "listModels",
          provenanceOperationTruncated: false,
          provenanceMethod: null,
          provenanceMethodTruncated: false,
          provenanceDetail: "controlled fail-once catalog",
          provenanceDetailTruncated: false,
          provenanceCauseDepth: 2,
          provenanceCauseTruncated: false,
        });

        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({
          providers: { codex: { defaultConnectionId: ACCOUNT_B } },
        });
        vi.setSystemTime(new Date(NOW_B));
        const retry = yield* handler(INPUT, context);
        expect(retry.isError, JSON.stringify(retry)).not.toBe(true);

        const resultText = retry.content[0];
        assert.isTrue(resultText?.type === "text");
        if (resultText?.type === "text") {
          assert.include(resultText.text, String(ACCOUNT_A));
          assert.notInclude(resultText.text, String(ACCOUNT_B));
        }
        const childAfterRetry = Option.getOrThrow(
          yield* projections.getThreadShellById(ids.threadId),
        );
        assert.isNotNull(childAfterRetry.latestTurn);
        assert.strictEqual(childAfterRetry.latestTurn?.turnId, childTurnId);
        const binding = Option.getOrThrow(yield* bindings.getRuntimeBinding(ids.threadId));
        assert.strictEqual(binding.connectionId, ACCOUNT_A);
        assert.strictEqual(binding.revision, 0);
        assert.strictEqual(
          Option.getOrThrow(
            yield* commandReceipts.getByCommandId({ commandId: ids.turnStartCommandId }),
          ).status,
          "accepted",
        );

        const highWater = yield* eventStore.getThreadHighWaterSequence(ids.threadId);
        const events = yield* eventStore.readThreadEvents({
          threadId: ids.threadId,
          throughSequenceInclusive: highWater,
          limit: 50,
        });
        assert.strictEqual(events.filter((event) => event.type === "thread.created").length, 1);
        assert.strictEqual(
          events.filter((event) => event.type === "thread.turn-start-requested").length,
          1,
        );
        const admission = Option.getOrThrow(yield* admissions.get(operationId));
        assert.include(admission.threadCreateCommandJson, NOW_A);
        assert.include(admission.turnStartCommandJson, NOW_A);
        assert.notInclude(admission.threadCreateCommandJson, NOW_B);
        assert.notInclude(admission.turnStartCommandJson, NOW_B);
        assert.include(admission.resultJson, String(ACCOUNT_A));
        assert.notInclude(admission.resultJson, String(ACCOUNT_B));
        assert.strictEqual(catalogCalls, 2);
      }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
    },
  );
});
