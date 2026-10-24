import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ProviderConnectionId, ProviderInstallationId, ThreadId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Cause, Effect, Layer, Option } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../../config.ts";
import { rememberClaudeThreadAccount } from "../claudeThreadNativeState.ts";

import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ProviderTurnSelectionResolver } from "../Services/ProviderTurnSelectionResolver.ts";
import { ProviderCatalogService } from "../Services/ProviderCatalog.ts";
import {
  claudeConnectionsShareAccount,
  ProviderTurnSelectionResolverLive,
} from "./ProviderTurnSelectionResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const threadId = ThreadId.make("selection-thread");
const connectionId = ProviderConnectionId.make("selection-go");
const codexConnectionId = ProviderConnectionId.make("selection-codex-managed");
const claudeConnectionId = ProviderConnectionId.make("selection-claude-managed");
const otherClaudeConnectionId = ProviderConnectionId.make("selection-claude-other");
const installationId = ProviderInstallationId.make("selection-installation");
const activeInstallationId = ProviderInstallationId.make("selection-active-installation");
const claudeInstallationId = ProviderInstallationId.make("selection-claude-installation");
const timestamp = "2026-08-08T00:00:00.000Z";

function failedWithCode(exit: { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }) {
  const failure = Cause.findErrorOption(exit.cause);
  return Option.isSome(failure) ? (failure.value as { readonly code?: string }).code : undefined;
}

it("allows Claude subscription continuation only with the same account identity", () => {
  const account = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "same@example.com",
  };
  const other = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "other@example.com",
  };
  const apiKey = { authenticationMethodId: "api-key", providerIdentityId: null };
  assert.isTrue(claudeConnectionsShareAccount(account, account));
  assert.isFalse(claudeConnectionsShareAccount(account, other));
  assert.isFalse(claudeConnectionsShareAccount(account, apiKey));
  assert.isFalse(claudeConnectionsShareAccount(apiKey, account));
  assert.isTrue(claudeConnectionsShareAccount(apiKey, apiKey));
});

let connectionLifecycle: "active" | "terminated" = "active";
let modelAvailable = true;
let threadExists = true;
let hasSession = true;
let installationLifecycle: "active" | "retired" = "active";
let threadHarness: "opencode" | "claudeAgent" = "opencode";
let catalogScopes: { provider: string; connectionId: ProviderConnectionId | null }[] = [];
let currentClaudeIdentity = "alice@example.com";
let claudeBoundConnectionId = claudeConnectionId;

const database = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);
const dependencies = Layer.mergeAll(
  database,
  ServerConfig.layerTest(process.cwd(), { prefix: "penkra-turn-selection-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettingsService.layerTest(),
  Layer.succeed(ProviderCatalogService, {
    get: (scope: { provider: string; connectionId: ProviderConnectionId | null }) => {
      catalogScopes.push(scope);
      return Effect.succeed({
        version: 1,
        error: null,
        models: !modelAvailable
          ? []
          : scope.provider === "claudeAgent"
            ? [
                { slug: "claude-opus-4-7", name: "Opus 4.7" },
                { slug: "claude-sonnet-5", name: "Sonnet 5" },
              ]
            : [
                {
                  slug:
                    scope.provider === "codex"
                      ? "gpt-5.5"
                      : scope.connectionId === null
                        ? "opencode/big-pickle"
                        : "opencode-go/kimi-k2.5",
                  name: "Available",
                },
              ],
      });
    },
  } as never),
  Layer.succeed(ProviderInstallationRepository, {
    getActiveRecord: (harness: string) =>
      Effect.succeed(
        Option.some({
          id:
            harness === "claudeAgent"
              ? claudeInstallationId
              : harness === "codex"
                ? ProviderInstallationId.make("selection-codex-installation")
                : installationLifecycle === "retired"
                  ? activeInstallationId
                  : installationId,
        }),
      ),
    list: () =>
      Effect.succeed([
        {
          id: installationId,
          harness: "opencode",
          version: "1.18.10",
          platform: "darwin",
          architecture: "arm64",
          adapterVersion: "1",
          protocolVersion: "v1",
          lifecycle: installationLifecycle,
          healthReason: null,
          installedAt: timestamp,
          activatedAt: timestamp,
          retiredAt: null,
        },
        ...(installationLifecycle === "retired"
          ? [
              {
                id: activeInstallationId,
                harness: "opencode" as const,
                version: "1.18.20",
                platform: "darwin",
                architecture: "arm64",
                adapterVersion: "1",
                protocolVersion: "v1",
                lifecycle: "active" as const,
                healthReason: null,
                installedAt: timestamp,
                activatedAt: timestamp,
                retiredAt: null,
              },
            ]
          : []),
        {
          id: ProviderInstallationId.make("selection-codex-installation"),
          harness: "codex",
          version: "0.147.0",
          platform: "darwin",
          architecture: "arm64",
          adapterVersion: "1",
          protocolVersion: "v1",
          lifecycle: "active",
          healthReason: null,
          installedAt: timestamp,
          activatedAt: timestamp,
          retiredAt: null,
        },
        {
          id: claudeInstallationId,
          harness: "claudeAgent",
          version: "2.1.283",
          platform: "darwin",
          architecture: "arm64",
          adapterVersion: "1",
          protocolVersion: "v1",
          lifecycle: "active",
          healthReason: null,
          installedAt: timestamp,
          activatedAt: timestamp,
          retiredAt: null,
        },
      ]),
    getRecord: (id: typeof installationId) =>
      Effect.succeed(
        Option.some({
          id,
          harness: id === claudeInstallationId ? "claudeAgent" : "opencode",
          version:
            id === claudeInstallationId
              ? "2.1.283"
              : id === activeInstallationId
                ? "1.18.20"
                : "1.18.10",
          platform: "darwin",
          architecture: "arm64",
          executablePath: id === claudeInstallationId ? "/managed/claude" : "/managed/opencode",
          artifactSource: "github-release",
          artifactUrl: "https://example.invalid/opencode",
          artifactSha256: "a".repeat(64),
          adapterVersion: "1",
          protocolVersion: "v1",
          lifecycle:
            id === claudeInstallationId || id === activeInstallationId
              ? "active"
              : installationLifecycle,
          healthReason: null,
          installedAt: timestamp,
          activatedAt: timestamp,
          retiredAt: null,
        }),
      ),
    reactivate: () => Effect.die("not expected"),
  } as never),
  Layer.succeed(ProviderConnectionRepository, {
    getRecord: (id: typeof connectionId) =>
      Effect.succeed(
        Option.some({
          id,
          harness:
            id === claudeConnectionId || id === otherClaudeConnectionId
              ? "claudeAgent"
              : id === codexConnectionId
                ? "codex"
                : "opencode",
          authenticationTargetId:
            id === claudeConnectionId || id === otherClaudeConnectionId
              ? "anthropic-first-party"
              : id === codexConnectionId
                ? "openai-first-party"
                : "opencode-go",
          authenticationMethodId:
            id === claudeConnectionId || id === otherClaudeConnectionId
              ? "claude-account"
              : id === codexConnectionId
                ? "chatgpt"
                : "api-key",
          label:
            id === claudeConnectionId || id === otherClaudeConnectionId
              ? "Claude"
              : id === codexConnectionId
                ? "Personal"
                : "Go",
          credentialRef: id === connectionId ? "provider-secret:selection" : null,
          profileRef:
            id === claudeConnectionId || id === otherClaudeConnectionId || id === codexConnectionId
              ? `provider-profile:${id}`
              : null,
          providerIdentityId:
            id === claudeConnectionId
              ? currentClaudeIdentity
              : id === otherClaudeConnectionId
                ? "bob@example.com"
                : null,
          health: connectionLifecycle === "active" ? "ready" : "unavailable",
          healthReason: null,
          lastCheckedAt: timestamp,
          lifecycle: connectionLifecycle,
          terminationReason: connectionLifecycle === "terminated" ? "disconnected" : null,
          terminatedAt: connectionLifecycle === "terminated" ? timestamp : null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ),
    list: () =>
      Effect.succeed([
        {
          id: codexConnectionId,
          harness: "codex",
          authenticationTargetId: "openai-first-party",
          authenticationMethodId: "chatgpt",
          label: "Codex",
          providerIdentityId: null,
          health: connectionLifecycle === "active" ? "ready" : "unavailable",
          healthReason: null,
          lastCheckedAt: timestamp,
          lifecycle: connectionLifecycle,
          terminationReason: connectionLifecycle === "terminated" ? "disconnected" : null,
          terminatedAt: connectionLifecycle === "terminated" ? timestamp : null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
  } as never),
);

const fixtureResolver = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const resolver = yield* ProviderTurnSelectionResolver;
    return {
      ...resolver,
      resolveExisting: (input: Parameters<typeof resolver.resolveExisting>[0]) =>
        Effect.gen(function* () {
          yield* sql`INSERT OR IGNORE INTO projection_folders (folder_id,space_id,title,workspace_root,default_model_selection_json,created_at,updated_at) VALUES ('selection-folder','penkra-personal','Selection',NULL,NULL,${timestamp},${timestamp})`;
          yield* sql`DELETE FROM threads WHERE id=${input.threadId}`;
          if (threadExists)
            yield* sql`INSERT INTO threads (id,space_id,folder_id,title,provider,connection_id,model,state,runtime_mode,native_state_id,provider_session_id,created_by,created_at,updated_at) VALUES (${input.threadId},'penkra-personal','selection-folder','Selection',${threadHarness},${threadHarness === "claudeAgent" ? claudeBoundConnectionId : connectionId},${threadHarness === "claudeAgent" ? "claude-sonnet-5" : "opencode-go/kimi-k2.5"},'idle','full-access','selection-native',${hasSession ? "native-session" : null},'user',${timestamp},${timestamp})`;
          return yield* resolver.resolveExisting(input);
        }),
    };
  });

const resolverLayer = ProviderTurnSelectionResolverLive.pipe(Layer.provide(dependencies));
const layer = it.layer(Layer.mergeAll(dependencies, resolverLayer));

layer("ProviderTurnSelectionResolver", (it) => {
  it.effect("uses the sole compatible active Connection when no default was selected", () =>
    Effect.gen(function* () {
      const resolver = yield* fixtureResolver();
      const selected = yield* resolver.resolveNewThreadConnection({
        modelSelection: { provider: "codex", model: "gpt-5.5" },
      });
      assert.strictEqual(selected, codexConnectionId);
    }),
  );

  it.effect("uses the host default and never replaces an incompatible explicit account", () =>
    Effect.gen(function* () {
      const resolver = yield* fixtureResolver();
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({
        providers: { codex: { defaultConnectionId: codexConnectionId } },
      });
      assert.strictEqual(
        yield* resolver.resolveNewThreadConnection({
          modelSelection: { provider: "codex", model: "gpt-5.5" },
        }),
        codexConnectionId,
      );
      const wrongHarness = yield* Effect.exit(
        resolver.resolveNewThreadConnection({
          modelSelection: { provider: "codex", model: "gpt-5.5" },
          connectionId,
        }),
      );
      assert.strictEqual(wrongHarness._tag, "Failure");
      connectionLifecycle = "terminated";
      const terminatedDefault = yield* Effect.exit(
        resolver.resolveNewThreadConnection({
          modelSelection: { provider: "codex", model: "gpt-5.5" },
        }),
      );
      connectionLifecycle = "active";
      assert.strictEqual(terminatedDefault._tag, "Failure");
    }),
  );

  it.effect("uses null only for an explicitly adapter-authorized anonymous route", () =>
    Effect.gen(function* () {
      const resolver = yield* fixtureResolver();
      const anonymous = yield* resolver.resolveNewThreadConnection({
        modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
      });
      assert.strictEqual(anonymous, null);
      connectionLifecycle = "terminated";
      const unavailable = yield* Effect.exit(
        resolver.resolveNewThreadConnection({
          modelSelection: { provider: "codex", model: "gpt-5.5" },
        }),
      );
      connectionLifecycle = "active";
      assert.strictEqual(unavailable._tag, "Failure");
    }),
  );

  it.effect(
    "a null-session Claude thread with a previous connection can select another without materializing",
    () =>
      Effect.gen(function* () {
        threadHarness = "claudeAgent";
        try {
          const resolver = yield* fixtureResolver();
          for (const connection of [claudeConnectionId, otherClaudeConnectionId]) {
            hasSession = false;
            const result = yield* resolver.resolveExisting({
              threadId,
              modelSelection: { provider: "claudeAgent", model: "claude-sonnet-5" },
              connectionId: connection,
            });
            assert.strictEqual(result.connectionId, connection);
            assert.strictEqual(result.requiresNativeStateMaterialization, false);
            assert.strictEqual(result.providerSessionId, null);
          }
        } finally {
          threadHarness = "opencode";
          hasSession = true;
        }
      }),
  );

  it.effect("resolves explicit and omitted anonymous first selections", () =>
    Effect.gen(function* () {
      const resolver = yield* fixtureResolver();
      const explicit = yield* resolver.resolveNewThreadConnection({
        modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
        connectionId: null,
      });
      const omitted = yield* resolver.resolveNewThreadConnection({
        modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
      });
      assert.strictEqual(explicit, null);
      assert.strictEqual(omitted, null);
    }),
  );

  it.effect("requires an explicit authorized anonymous selection", () =>
    Effect.gen(function* () {
      connectionLifecycle = "active";
      catalogScopes = [];
      const resolver = yield* fixtureResolver();

      const current = yield* resolver.resolveExisting({ threadId });
      assert.strictEqual(current.changed, false);
      assert.strictEqual(current.connectionId, connectionId);
      assert.strictEqual(current.internalProviderId, "opencode-go");

      const providerMismatch = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "codex", model: "gpt-5.5" },
          connectionId: codexConnectionId,
        }),
      );
      assert.strictEqual(providerMismatch._tag, "Failure");
      if (providerMismatch._tag === "Failure") {
        assert.strictEqual(failedWithCode(providerMismatch), "provider_mismatch");
      }

      const unauthorized = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
          connectionId,
        }),
      );
      assert.strictEqual(unauthorized._tag, "Failure");
      if (unauthorized._tag === "Failure") {
        assert.strictEqual(failedWithCode(unauthorized), "connection_unauthorized");
      }

      const currentConnectionUnauthorized = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
        }),
      );
      assert.strictEqual(currentConnectionUnauthorized._tag, "Failure");
      if (currentConnectionUnauthorized._tag === "Failure") {
        assert.strictEqual(
          failedWithCode(currentConnectionUnauthorized),
          "connection_unauthorized",
        );
      }

      const anonymous = yield* resolver.resolveExisting({
        threadId,
        modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
        connectionId: null,
      });
      assert.strictEqual(anonymous.changed, true);
      assert.strictEqual(anonymous.connectionId, null);
      assert.strictEqual(anonymous.internalProviderId, "opencode");
      assert.strictEqual(anonymous.modelId, "opencode/big-pickle");
      assert.deepEqual(catalogScopes, [{ provider: "opencode", connectionId: null }]);

      connectionLifecycle = "terminated";
      const disconnected = yield* Effect.exit(resolver.resolveExisting({ threadId }));
      const unavailableExactConnection = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode-go/kimi-k2.5" },
          connectionId,
        }),
      );
      assert.strictEqual(disconnected._tag, "Failure");
      assert.strictEqual(unavailableExactConnection._tag, "Failure");
      if (unavailableExactConnection._tag === "Failure") {
        assert.strictEqual(failedWithCode(unavailableExactConnection), "connection_unavailable");
      }
      threadExists = false;
      const missingBinding = yield* Effect.exit(resolver.resolveExisting({ threadId }));
      threadExists = true;
      assert.strictEqual(missingBinding._tag, "Failure");
      if (missingBinding._tag === "Failure") {
        assert.strictEqual(failedWithCode(missingBinding), "thread_binding_missing");
      }
    }),
  );

  it.effect("selects the active installation without materializing an unchanged thread", () =>
    Effect.gen(function* () {
      installationLifecycle = "retired";
      connectionLifecycle = "active";
      threadExists = true;
      const resolver = yield* fixtureResolver();
      const selected = yield* resolver.resolveExisting({ threadId });
      assert.strictEqual(selected.changed, false);
      assert.strictEqual(selected.requiresNativeStateMaterialization, false);
      assert.strictEqual(selected.installationId, activeInstallationId);
      const switched = yield* resolver.resolveExisting({
        threadId,
        modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
        connectionId: null,
      });
      assert.strictEqual(switched.changed, true);
      assert.strictEqual(switched.installationId, activeInstallationId);
      installationLifecycle = "active";
    }),
  );

  it.effect("rejects a model that the exact selected Connection did not expose", () =>
    Effect.gen(function* () {
      connectionLifecycle = "active";
      modelAvailable = false;
      const resolver = yield* fixtureResolver();
      const unavailable = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode-go/unavailable" },
        }),
      );
      modelAvailable = true;
      assert.strictEqual(unavailable._tag, "Failure");
      if (unavailable._tag === "Failure") {
        assert.strictEqual(failedWithCode(unavailable), "model_unavailable");
      }
    }),
  );

  it.effect("accepts an SDK-supported older Claude model", () =>
    Effect.gen(function* () {
      threadHarness = "claudeAgent";
      connectionLifecycle = "active";
      modelAvailable = true;
      const resolver = yield* fixtureResolver();
      const selection = yield* resolver.resolveExisting({
        threadId,
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-7" },
      });
      assert.strictEqual(selection.modelId, "claude-opus-4-7");
      assert.strictEqual(selection.modelLabel, "Opus 4.7");
      threadHarness = "opencode";
    }),
  );

  it.effect(
    "admits an explicit Claude account switch but rejects a changed login on the bound Connection",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const resolver = yield* fixtureResolver();
        const accountThreadId = ThreadId.make("selection-claude-account-switch");
        threadHarness = "claudeAgent";
        yield* Effect.promise(() =>
          rememberClaudeThreadAccount({
            stateDir: config.stateDir,
            nativeStateId: "selection-native",
            account: {
              authenticationMethodId: "claude-account",
              providerIdentityId: "alice@example.com",
            },
          }),
        );
        try {
          const selected = yield* resolver.resolveExisting({
            threadId: accountThreadId,
            connectionId: otherClaudeConnectionId,
          });
          assert.strictEqual(selected.changed, true);
          assert.strictEqual(selected.connectionId, otherClaudeConnectionId);
          assert.strictEqual(selected.requiresNativeStateMaterialization, true);

          currentClaudeIdentity = "bob@example.com";
          const ordinaryResume = yield* Effect.exit(
            resolver.resolveExisting({ threadId: accountThreadId }),
          );
          assert.strictEqual(ordinaryResume._tag, "Failure");
          if (ordinaryResume._tag === "Failure") {
            assert.strictEqual(failedWithCode(ordinaryResume), "connection_unauthorized");
          }
        } finally {
          currentClaudeIdentity = "alice@example.com";
          threadHarness = "opencode";
        }
      }),
  );
});
