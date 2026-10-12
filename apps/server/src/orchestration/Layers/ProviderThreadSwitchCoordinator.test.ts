import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { createThreadFixture } from "../../cleanCore/threadFixtures.ts";
import { commitThreadTurnSelection } from "../../cleanCore/threadTurnSelection.ts";
import { ThreadPublisher, ThreadPublisherLive } from "../../cleanCore/ThreadPublisher.ts";
import {
  CommandId,
  FolderId,
  MessageId,
  ProviderConnectionId,
  ProviderInstallationId,
  ThreadId,
  type OrchestrationCommand,
  type ProviderKind,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { ServerConfig } from "../../config.ts";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../../managedAttachmentPrincipal.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../../provider/Services/ProviderLaunchResolver.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderNativeStateMaterializer } from "../../provider/Services/ProviderNativeStateMaterializer.ts";
import { ProviderNativeStateMaterializerLive } from "../../provider/Layers/ProviderNativeStateMaterializer.ts";
import { ProviderTurnSelectionResolverLive } from "../../provider/Layers/ProviderTurnSelectionResolver.ts";
import { providerNativeStateRoot } from "../../provider/providerNativeStatePaths.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationDispatchContext,
} from "../Services/OrchestrationEngine.ts";
import { makeProviderThreadSwitchCoordinator } from "./ProviderThreadSwitchCoordinator.ts";

const timestamp = "2026-08-08T00:00:00.000Z";
const sourceConnectionId = ProviderConnectionId.makeUnsafe("connection-personal");
const targetConnectionId = ProviderConnectionId.makeUnsafe("connection-work");
const installationId = ProviderInstallationId.makeUnsafe("installation-active");
const stateDir = mkdtempSync(path.join(tmpdir(), "penkra-canonical-switch-"));
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
const configLayer = Layer.succeed(ServerConfig, { stateDir } as never);
const database = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);
let modelDiscoveryCalls = 0;
const dependencies = Layer.mergeAll(
  database,
  configLayer,
  ThreadPublisherLive,
  ServerSettingsService.layerTest(),
  Layer.succeed(ProviderLaunchResolver, {
    resolveProfile: (input) =>
      Effect.succeed({
        binaryPath: "/provider",
        isolationKey: "discovery",
        profileRoot: "/profile",
        nativeStateRoot: "/discovery",
        connectionId: input.connectionId,
        installationId: input.installationId,
        childEnvironment: (env: NodeJS.ProcessEnv) => env,
      }),
    resolve: () => Effect.die("not used"),
  }),
  Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: (provider: ProviderKind) =>
      Effect.succeed({
        listModels: () =>
          Effect.sync(() => {
            modelDiscoveryCalls += 1;
            return {
              models:
                provider === "opencode"
                  ? [
                      { slug: "opencode-go/kimi", name: "Kimi" },
                      { slug: "opencode-go/glm", name: "GLM" },
                    ]
                  : provider === "codex"
                    ? [
                        { slug: "gpt-5.5", name: "GPT" },
                        { slug: "gpt-5.4", name: "GPT previous" },
                      ]
                    : [
                        { slug: "claude-sonnet-5", name: "Sonnet" },
                        { slug: "claude-haiku-4-5", name: "Haiku" },
                      ],
            };
          }),
      } as never),
    listProviders: () => Effect.succeed(["codex", "claudeAgent", "opencode"]),
  }),
  Layer.succeed(ProviderConnectionRepository, {
    getRecord: (id: ProviderConnectionId) =>
      Effect.succeed(
        id === sourceConnectionId || id === targetConnectionId
          ? Option.some({
              id,
              harness: currentProvider,
              authenticationTargetId:
                currentProvider === "opencode"
                  ? "opencode-go"
                  : currentProvider === "codex"
                    ? "openai-first-party"
                    : "anthropic-first-party",
              authenticationMethodId:
                currentProvider === "claudeAgent"
                  ? "claude-account"
                  : currentProvider === "codex"
                    ? "chatgpt"
                    : "api-key",
              label: id === sourceConnectionId ? "Personal" : "Work",
              credentialRef: currentProvider === "opencode" ? "secret" : null,
              profileRef: currentProvider === "opencode" ? null : "profile",
              providerIdentityId: null,
              health: "ready",
              lifecycle: "active",
              createdAt: timestamp,
              updatedAt: timestamp,
            })
          : Option.none(),
      ),
    list: () => Effect.succeed([]),
  } as never),
  Layer.succeed(ProviderInstallationRepository, {
    getActiveRecord: () => Effect.succeed(Option.some({ id: installationId })),
  } as never),
);
const resolverLayer = ProviderTurnSelectionResolverLive.pipe(Layer.provideMerge(dependencies));
const materializerLayer = ProviderNativeStateMaterializerLive.pipe(Layer.provideMerge(configLayer));
let currentProvider: ProviderKind = "opencode";
const layer = it.layer(Layer.mergeAll(resolverLayer, materializerLayer));

const modelFor = (provider: ProviderKind, alternate = false) =>
  provider === "opencode"
    ? alternate
      ? "opencode-go/glm"
      : "opencode-go/kimi"
    : provider === "codex"
      ? alternate
        ? "gpt-5.4"
        : "gpt-5.5"
      : alternate
        ? "claude-haiku-4-5"
        : "claude-sonnet-5";
const fixture = Effect.fn(function* (
  provider: ProviderKind = "opencode",
  options: { running?: boolean; native?: boolean; session?: boolean } = {},
) {
  currentProvider = provider;
  const sql = yield* SqlClient.SqlClient;
  const publisher = yield* ThreadPublisher;
  const materializer = yield* ProviderNativeStateMaterializer;
  const threadId = ThreadId.makeUnsafe(randomUUID());
  const folderId = FolderId.makeUnsafe(randomUUID());
  const nativeStateId = options.native === false ? null : randomUUID();
  const providerSessionId = options.session === false ? null : "native-session";
  yield* sql`INSERT INTO projection_folders (folder_id,space_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at)
    VALUES (${folderId},'penkra-personal','Switch',NULL,NULL,'[]',${timestamp},${timestamp})`;
  yield* createThreadFixture(sql, {
    threadId,
    folderId,
    title: "Switch",
    modelSelection: { provider, model: modelFor(provider) },
    runtimeMode: "full-access",
    connection: { kind: "selected", connectionId: sourceConnectionId },
    creator: { kind: "user" },
    createdAt: timestamp,
  });
  yield* sql`UPDATE threads SET native_state_id=${nativeStateId}, provider_session_id=${providerSessionId}, state=${options.running ? "running" : "idle"} WHERE id=${threadId}`;
  const order: string[] = [];
  const clones: Parameters<typeof materializer.clone>[0][] = [];
  const discards: string[] = [];
  let dispatchFails = false,
    responseLost = false,
    copyFails = false,
    settleNativeId: string | undefined;
  let sent: OrchestrationCommand | undefined, context: OrchestrationDispatchContext | undefined;
  const subscribed = yield* Deferred.make<void>();
  const read = () =>
    sql<{
      connectionId: string | null;
      nativeStateId: string | null;
      providerSessionId: string | null;
      model: string;
      state: string;
    }>`SELECT connection_id AS "connectionId",native_state_id AS "nativeStateId",provider_session_id AS "providerSessionId",model,state FROM threads WHERE id=${threadId}`.pipe(
      Effect.map((rows) => rows[0]!),
    );
  const settle = () =>
    Effect.gen(function* () {
      yield* sql`UPDATE threads SET state='idle', native_state_id=COALESCE(${settleNativeId ?? null},native_state_id) WHERE id=${threadId}`;
      publisher.publish({ threadId });
    });
  const coordinator = yield* makeProviderThreadSwitchCoordinator.pipe(
    Effect.provideService(ThreadPublisher, {
      ...publisher,
      subscribe: (id, callback) => {
        const unsubscribe = publisher.subscribe(id, callback);
        Effect.runSync(Deferred.succeed(subscribed, undefined));
        return unsubscribe;
      },
    }),
    Effect.provideService(ProviderService, {
      interruptTurn: () =>
        Effect.gen(function* () {
          order.push("interrupt");
          yield* settle();
        }),
      stopSession: () =>
        Effect.sync(() => {
          order.push("stop");
        }),
    } as never),
    Effect.provideService(ProviderNativeStateMaterializer, {
      clone: (input) =>
        Effect.gen(function* () {
          order.push("copy");
          clones.push(input);
          if (copyFails) return yield* Effect.fail(new Error("copy failed") as never);
          return { root: "/target", providerSessionId: input.providerSessionId };
        }),
      discard: (id) =>
        Effect.sync(() => {
          discards.push(id);
        }),
    }),
    Effect.provideService(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand, accepted: OrchestrationDispatchContext) =>
        Effect.gen(function* () {
          order.push("dispatch");
          sent = command;
          context = accepted;
          if (dispatchFails) return yield* Effect.fail(new Error("admission rejected"));
          if (accepted.acceptedTurnSelection)
            yield* sql.withTransaction(commitThreadTurnSelection(accepted.acceptedTurnSelection));
          if (responseLost) return yield* Effect.fail(new Error("response lost after commit"));
          return { sequence: 42 };
        }),
    } as never),
  );
  const command: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(randomUUID()),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(randomUUID()),
      role: "user",
      text: "Continue",
      attachments: [],
    },
    modelSelection: { provider, model: modelFor(provider) },
    connectionId: targetConnectionId,
    runtimeMode: "full-access",
    dispatchMode: "queue",
    createdAt: timestamp,
  };
  const send = (patch: Partial<typeof command> = {}) =>
    coordinator.dispatchTurnStart({
      command: { ...command, ...patch },
      attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
    });
  return {
    sql,
    threadId,
    nativeStateId,
    providerSessionId,
    order,
    clones,
    discards,
    coordinator,
    command,
    send,
    read,
    settle,
    subscribed,
    sent: () => sent,
    context: () => context,
    failDispatch: () => {
      dispatchFails = true;
    },
    loseResponse: () => {
      responseLost = true;
    },
    failCopy: () => {
      copyFails = true;
    },
    settleWith: (id: string) => {
      settleNativeId = id;
    },
    materializer,
  };
});

layer("canonical turn selection", (it) => {
  it.effect("uses the canonical account for an unchanged agent send", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.send({ connectionId: undefined, modelSelection: undefined });
      assert.strictEqual(
        (f.sent() as Extract<OrchestrationCommand, { type: "thread.turn.start" }>)?.connectionId,
        sourceConnectionId,
      );
      assert.deepStrictEqual(f.order, ["dispatch"]);
    }),
  );
  it.effect("restarts a model-only change without copying native state", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.send({
        connectionId: sourceConnectionId,
        modelSelection: { provider: "opencode", model: modelFor("opencode", true) },
      });
      assert.deepStrictEqual(f.order, ["stop", "dispatch"]);
      assert.strictEqual((yield* f.read()).model, modelFor("opencode", true));
      assert.strictEqual((yield* f.read()).nativeStateId, f.nativeStateId);
    }),
  );
  it.effect(
    "starts a previously connected thread with no provider session without materializing",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("opencode", { session: false });
        yield* f.send();
        assert.lengthOf(f.clones, 0);
        const row = yield* f.read();
        assert.strictEqual(row.connectionId, targetConnectionId);
        assert.notStrictEqual(row.nativeStateId, f.nativeStateId);
        assert.strictEqual(row.providerSessionId, null);
      }),
  );
  it.effect("starts a historical thread without native state using a fresh folder", () =>
    Effect.gen(function* () {
      const f = yield* fixture("opencode", { native: false, session: false });
      yield* f.send();
      assert.lengthOf(f.clones, 0);
      assert.isString((yield* f.read()).nativeStateId);
    }),
  );
  it.effect("copies before admission and retries without discarding committed native state", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.send();
      const first = yield* f.read();
      yield* f.send();
      assert.deepStrictEqual(f.order, ["stop", "copy", "dispatch", "dispatch"]);
      assert.strictEqual((yield* f.read()).nativeStateId, first.nativeStateId);
      assert.lengthOf(f.discards, 0);
    }),
  );
  it.effect("does not discard the admitted folder when the response is lost", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.loseResponse();
      assert.strictEqual((yield* Effect.exit(f.send()))._tag, "Failure");
      assert.lengthOf(f.discards, 0);
      assert.strictEqual((yield* f.read()).connectionId, targetConnectionId);
    }),
  );
  it.effect(
    "cleans the copied target and leaves the source owner unchanged on admission failure",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.failDispatch();
        assert.strictEqual((yield* Effect.exit(f.send()))._tag, "Failure");
        assert.lengthOf(f.discards, 1);
        assert.strictEqual((yield* f.read()).connectionId, sourceConnectionId);
        assert.strictEqual((yield* f.read()).nativeStateId, f.nativeStateId);
      }),
  );
  it.effect("leaves the source row unchanged when copying fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.failCopy();
      assert.strictEqual((yield* Effect.exit(f.send()))._tag, "Failure");
      assert.notInclude(f.order, "dispatch");
      assert.strictEqual((yield* f.read()).connectionId, sourceConnectionId);
    }),
  );
  it.effect("rejects an unavailable steering account before interrupting", () =>
    Effect.gen(function* () {
      const f = yield* fixture("opencode", { running: true });
      assert.strictEqual(
        (yield* Effect.exit(
          f.send({
            connectionId: ProviderConnectionId.makeUnsafe("missing"),
            dispatchMode: "steer",
          }),
        ))._tag,
        "Failure",
      );
      assert.notInclude(f.order, "interrupt");
      assert.strictEqual((yield* f.read()).state, "running");
    }),
  );
  it.effect("reads the native folder persisted by settlement before copying", () =>
    Effect.gen(function* () {
      const f = yield* fixture("opencode", { running: true });
      f.settleWith("settled-native");
      yield* f.send({ dispatchMode: "steer" });
      assert.strictEqual(f.clones[0]?.sourceNativeStateId, "settled-native");
      assert.deepStrictEqual(f.order, ["interrupt", "stop", "copy", "dispatch"]);
    }),
  );
  for (const provider of ["codex", "claudeAgent", "opencode"] as const) {
    it.effect(`waits for the ${provider} turn-end broadcast before a queued account switch`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(provider, { running: true });
        const fiber = yield* f.send().pipe(Effect.forkChild);
        yield* Deferred.await(f.subscribed);
        assert.deepStrictEqual(f.order, []);
        assert.strictEqual((yield* f.read()).connectionId, sourceConnectionId);
        yield* f.settle();
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(f.order, ["stop", "copy", "dispatch"]);
        assert.strictEqual((yield* f.read()).connectionId, targetConnectionId);
      }),
    );
    it.effect(`interrupts before a ${provider} now-send on another account`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(provider, { running: true });
        yield* f.send({ dispatchMode: "steer" });
        assert.deepStrictEqual(f.order, ["interrupt", "stop", "copy", "dispatch"]);
      }),
    );
  }
  it.effect("pre-authorizes a running account switch without reading a model catalog", () =>
    Effect.gen(function* () {
      const f = yield* fixture("codex", { running: true });
      const before = modelDiscoveryCalls;
      const waiting = yield* f.send().pipe(Effect.forkChild);
      yield* Deferred.await(f.subscribed);
      assert.equal(modelDiscoveryCalls - before, 0);
      yield* f.settle();
      yield* Fiber.join(waiting);
      assert.equal(modelDiscoveryCalls - before, 1);
      assert.strictEqual((yield* f.read()).connectionId, targetConnectionId);
    }),
  );

  it.effect("verifies the selection against a row changed while admission waits for idle", () =>
    Effect.gen(function* () {
      const f = yield* fixture("opencode", { running: true });
      const discoveryCallsBefore = modelDiscoveryCalls;
      const waiting = yield* f.send({ connectionId: sourceConnectionId }).pipe(Effect.forkChild);
      yield* Deferred.await(f.subscribed);
      yield* f.sql`UPDATE threads SET model=${modelFor("opencode", true)} WHERE id=${f.threadId}`;
      yield* f.settle();
      yield* Fiber.join(waiting);
      assert.equal(modelDiscoveryCalls - discoveryCallsBefore, 1);
      assert.deepStrictEqual(f.order, ["stop", "dispatch"]);
      assert.strictEqual((yield* f.read()).model, modelFor("opencode"));
    }),
  );

  it.effect("native steer keeps the running turn's account and model", () =>
    Effect.gen(function* () {
      const f = yield* fixture("codex", { running: true });
      yield* f.send({
        dispatchMode: "steer",
        connectionId: sourceConnectionId,
        modelSelection: { provider: "codex", model: modelFor("codex", true) },
      });
      assert.deepStrictEqual(f.order, ["dispatch"]);
      assert.strictEqual(f.context()?.acceptedTurnSelection, undefined);
      assert.strictEqual((yield* f.read()).model, modelFor("codex"));
    }),
  );
  it.effect(
    "switches the account for a promoted queued turn through live selection resolution",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.coordinator.dispatchQueuedTurn({
          command: {
            type: "thread.turn.dispatch-queued",
            commandId: CommandId.makeUnsafe(randomUUID()),
            threadId: f.threadId,
            messageId: MessageId.makeUnsafe(randomUUID()),
            connectionId: targetConnectionId,
            modelSelection: f.command.modelSelection,
            runtimeMode: "full-access",
            dispatchMode: "queue",
            createdAt: timestamp,
          },
          attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        });
        assert.strictEqual((yield* f.read()).connectionId, targetConnectionId);
        assert.lengthOf(f.clones, 1);
      }),
  );
  it.effect("switches the model for a promoted queued turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const discoveryCallsBefore = modelDiscoveryCalls;
      yield* f.coordinator.dispatchQueuedTurn({
        command: {
          type: "thread.turn.dispatch-queued",
          commandId: CommandId.makeUnsafe(randomUUID()),
          threadId: f.threadId,
          messageId: MessageId.makeUnsafe(randomUUID()),
          connectionId: sourceConnectionId,
          modelSelection: { provider: "opencode", model: modelFor("opencode", true) },
          runtimeMode: "full-access",
          dispatchMode: "queue",
          createdAt: timestamp,
        },
        attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
      });
      assert.strictEqual((yield* f.read()).model, modelFor("opencode", true));
      assert.lengthOf(f.clones, 0);
      assert.equal(modelDiscoveryCalls - discoveryCallsBefore, 1);
    }),
  );
  it.effect(
    "a Claude switch copies the exact conversation while leaving its source untouched",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("claudeAgent");
        const source = path.join(
          providerNativeStateRoot(stateDir, f.nativeStateId!),
          "claude",
          "project",
          `${f.providerSessionId}.jsonl`,
        );
        yield* Effect.promise(async () => {
          await mkdir(path.dirname(source), { recursive: true });
          await writeFile(source, '{"type":"user","message":{"content":"hello"}}\n');
        });
        const coordinator = yield* makeProviderThreadSwitchCoordinator.pipe(
          Effect.provideService(ProviderService, { stopSession: () => Effect.void } as never),
          Effect.provideService(OrchestrationEngineService, {
            dispatch: (_command: OrchestrationCommand, context: OrchestrationDispatchContext) =>
              Effect.gen(function* () {
                yield* f.sql.withTransaction(
                  commitThreadTurnSelection(context.acceptedTurnSelection!),
                );
                return { sequence: 42 };
              }),
          } as never),
        );
        yield* coordinator.dispatchTurnStart({
          command: f.command,
          attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        });
        const row = yield* f.read();
        const target = path.join(
          providerNativeStateRoot(stateDir, row.nativeStateId!),
          "claude",
          "project",
          `${f.providerSessionId}.jsonl`,
        );
        assert.notStrictEqual(row.nativeStateId, f.nativeStateId);
        assert.strictEqual(row.connectionId, targetConnectionId);
        assert.strictEqual(
          yield* Effect.promise(() => readFile(target, "utf8")),
          yield* Effect.promise(() => readFile(source, "utf8")),
        );
      }),
  );
});
