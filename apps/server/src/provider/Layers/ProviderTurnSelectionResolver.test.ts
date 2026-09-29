import {
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Cause, Effect, Layer, Option } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../../config.ts";
import { rememberClaudeThreadAccount } from "../claudeThreadNativeState.ts";

import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderTurnSelectionResolver } from "../Services/ProviderTurnSelectionResolver.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import {
  claudeConnectionsShareAccount,
  ProviderTurnSelectionResolverLive,
} from "./ProviderTurnSelectionResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const threadId = ThreadId.makeUnsafe("selection-thread");
const connectionId = ProviderConnectionId.makeUnsafe("selection-go");
const codexConnectionId = ProviderConnectionId.makeUnsafe("selection-codex-managed");
const claudeConnectionId = ProviderConnectionId.makeUnsafe("selection-claude-managed");
const otherClaudeConnectionId = ProviderConnectionId.makeUnsafe("selection-claude-other");
const installationId = ProviderInstallationId.makeUnsafe("selection-installation");
const activeInstallationId = ProviderInstallationId.makeUnsafe("selection-active-installation");
const claudeInstallationId = ProviderInstallationId.makeUnsafe("selection-claude-installation");
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
let hasRuntimeBinding = true;
let installationLifecycle: "active" | "retired" = "active";
let threadHarness: "opencode" | "claudeAgent" = "opencode";
let resolvedNativeStateIdentities: string[] = [];
let currentClaudeIdentity = "alice@example.com";

const dependencies = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "penkra-turn-selection-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettingsService.layerTest(),
  Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: () =>
      Effect.succeed({
        listModels: (input: { provider: string; internalProviderId?: string | null }) =>
          Effect.succeed({
            models: modelAvailable
              ? input.provider === "claudeAgent"
                ? [
                    { slug: "claude-opus-4-7", name: "Opus 4.7" },
                    { slug: "claude-sonnet-5", name: "Sonnet 5" },
                  ]
                : [
                    {
                      slug:
                        input.provider === "codex"
                          ? "gpt-5.5"
                          : input.internalProviderId === "opencode-go"
                            ? "opencode-go/kimi-k2.5"
                            : "opencode/big-pickle",
                      name: "Available",
                    },
                  ]
              : [],
          }),
      } as never),
    listProviders: () => Effect.succeed([]),
  }),
  Layer.succeed(ProviderLaunchResolver, {
    resolve: () => Effect.die("not used"),
    resolveProfile: (input) => {
      resolvedNativeStateIdentities.push(input.nativeStateIdentity);
      return Effect.succeed({
        binaryPath: "/managed/provider",
        isolationKey: `selection:${input.connectionId ?? "anonymous"}`,
        profileRoot: "/managed/profile",
        nativeStateRoot: "/managed/native",
        connectionId: input.connectionId,
        installationId: input.installationId,
        childEnvironment: (environment: NodeJS.ProcessEnv) => environment,
      });
    },
  }),
  Layer.succeed(ProjectionSnapshotQuery, {
    getThreadShellById: () =>
      Effect.succeed(
        Option.some({
          id: threadId,
          spaceId: null,
          modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
        }),
      ),
  } as never),
  Layer.succeed(ThreadProviderBindingRepository, {
    getHarnessState: () =>
      Effect.succeed(
        Option.some({
          threadId,
          harness: threadHarness,
          nativeStateGenerationId: ProviderNativeStateGenerationId.makeUnsafe("selection-native"),
          providerSessionId: "native-session",
          nativeStateLocatorJson: '{"session":"native-session"}',
          lastVerifiedResumeAt: timestamp,
          revision: 4,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ),
    getRuntimeBinding: () =>
      Effect.succeed(
        hasRuntimeBinding
          ? Option.some({
              threadId,
              connectionId: threadHarness === "claudeAgent" ? claudeConnectionId : connectionId,
              installationId:
                threadHarness === "claudeAgent" ? claudeInstallationId : installationId,
              internalProviderId: threadHarness === "claudeAgent" ? null : "opencode-go",
              modelId:
                threadHarness === "claudeAgent" ? "claude-sonnet-5" : "opencode-go/kimi-k2.5",
              revision: 7,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
          : Option.none(),
      ),
  } as never),
  Layer.succeed(ProviderInstallationRepository, {
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
          id: ProviderInstallationId.makeUnsafe("selection-codex-installation"),
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

const resolverLayer = ProviderTurnSelectionResolverLive.pipe(Layer.provide(dependencies));
const layer = it.layer(Layer.mergeAll(dependencies, resolverLayer));

layer("ProviderTurnSelectionResolver", (it) => {
  it.effect("uses the sole compatible active Connection when no default was selected", () =>
    Effect.gen(function* () {
      const resolver = yield* ProviderTurnSelectionResolver;
      const selected = yield* resolver.resolveNewThreadConnection({
        modelSelection: { provider: "codex", model: "gpt-5.5" },
      });
      assert.strictEqual(selected, codexConnectionId);
    }),
  );

  it.effect("uses the host default and never replaces an incompatible explicit account", () =>
    Effect.gen(function* () {
      const resolver = yield* ProviderTurnSelectionResolver;
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
      const resolver = yield* ProviderTurnSelectionResolver;
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

  it.effect("resolves explicit and default anonymous first bindings", () =>
    Effect.gen(function* () {
      resolvedNativeStateIdentities = [];
      const resolver = yield* ProviderTurnSelectionResolver;
      const generationId = ProviderNativeStateGenerationId.makeUnsafe("initial-generation");
      const initial = yield* resolver.resolveInitial({
        threadId,
        nativeStateGenerationId: generationId,
        modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
        connectionId: null,
        createdAt: timestamp,
      });
      assert.strictEqual(initial.selection.connectionId, null);
      assert.strictEqual(initial.selection.installationId, installationId);
      assert.strictEqual(initial.selection.internalProviderId, "opencode");
      assert.strictEqual(initial.initialization.nativeStateLocatorJson, "null");
      assert.strictEqual(initial.initialization.generation.id, generationId);

      const omitted = yield* resolver.resolveInitial({
        threadId,
        nativeStateGenerationId: generationId,
        modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
        createdAt: timestamp,
      });
      assert.strictEqual(omitted.selection.connectionId, null);
      assert.deepEqual(resolvedNativeStateIdentities, [
        "discovery:opencode:anonymous",
        "discovery:opencode:anonymous",
      ]);
      assert.notStrictEqual(resolvedNativeStateIdentities[0], generationId);
    }),
  );

  it.effect("requires an explicit anonymous selection and exact revision", () =>
    Effect.gen(function* () {
      connectionLifecycle = "active";
      resolvedNativeStateIdentities = [];
      const resolver = yield* ProviderTurnSelectionResolver;

      const current = yield* resolver.resolveExisting({ threadId });
      assert.strictEqual(current.changed, false);
      assert.strictEqual(current.connectionId, connectionId);
      assert.strictEqual(current.internalProviderId, "opencode-go");

      const providerMismatch = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "codex", model: "gpt-5.5" },
          connectionId: codexConnectionId,
          bindingRevision: 7,
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
          bindingRevision: 7,
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
          bindingRevision: 7,
        }),
      );
      assert.strictEqual(currentConnectionUnauthorized._tag, "Failure");
      if (currentConnectionUnauthorized._tag === "Failure") {
        assert.strictEqual(
          failedWithCode(currentConnectionUnauthorized),
          "connection_unauthorized",
        );
      }

      const missingRevision = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
          connectionId: null,
        }),
      );
      assert.strictEqual(missingRevision._tag, "Failure");
      if (missingRevision._tag === "Failure") {
        assert.strictEqual(failedWithCode(missingRevision), "binding_revision_required");
      }

      const stale = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
          connectionId: null,
          bindingRevision: 6,
        }),
      );
      assert.strictEqual(stale._tag, "Failure");
      if (stale._tag === "Failure") {
        assert.strictEqual(failedWithCode(stale), "binding_revision_stale");
      }

      const anonymous = yield* resolver.resolveExisting({
        threadId,
        modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
        connectionId: null,
        bindingRevision: 7,
      });
      assert.strictEqual(anonymous.changed, true);
      assert.strictEqual(anonymous.connectionId, null);
      assert.strictEqual(anonymous.internalProviderId, "opencode");
      assert.strictEqual(anonymous.modelId, "opencode/big-pickle");
      assert.deepEqual(resolvedNativeStateIdentities, ["discovery:opencode:anonymous"]);

      connectionLifecycle = "terminated";
      const disconnected = yield* Effect.exit(resolver.resolveExisting({ threadId }));
      const unavailableExactConnection = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode-go/kimi-k2.5" },
          connectionId,
          bindingRevision: 7,
        }),
      );
      assert.strictEqual(disconnected._tag, "Failure");
      assert.strictEqual(unavailableExactConnection._tag, "Failure");
      if (unavailableExactConnection._tag === "Failure") {
        assert.strictEqual(failedWithCode(unavailableExactConnection), "connection_unavailable");
      }
      hasRuntimeBinding = false;
      const missingBinding = yield* Effect.exit(resolver.resolveExisting({ threadId }));
      hasRuntimeBinding = true;
      assert.strictEqual(missingBinding._tag, "Failure");
      if (missingBinding._tag === "Failure") {
        assert.strictEqual(failedWithCode(missingBinding), "thread_binding_missing");
      }
    }),
  );

  it.effect(
    "pins an unchanged retired thread and uses the active installation for an explicit switch",
    () =>
      Effect.gen(function* () {
        installationLifecycle = "retired";
        connectionLifecycle = "active";
        hasRuntimeBinding = true;
        const resolver = yield* ProviderTurnSelectionResolver;
        const selected = yield* resolver.resolveExisting({ threadId });
        assert.strictEqual(selected.changed, false);
        assert.strictEqual(selected.requiresNativeStateMaterialization, false);
        assert.strictEqual(selected.installationId, installationId);
        const switched = yield* resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
          connectionId: null,
          bindingRevision: 7,
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
      const resolver = yield* ProviderTurnSelectionResolver;
      const unavailable = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode-go/unavailable" },
          bindingRevision: 7,
        }),
      );
      modelAvailable = true;
      assert.strictEqual(unavailable._tag, "Failure");
      if (unavailable._tag === "Failure") {
        assert.strictEqual(failedWithCode(unavailable), "model_unavailable");
      }
    }),
  );

  it.effect("accepts an SDK-supported older Claude model on a pinned thread", () =>
    Effect.gen(function* () {
      threadHarness = "claudeAgent";
      connectionLifecycle = "active";
      modelAvailable = true;
      const resolver = yield* ProviderTurnSelectionResolver;
      const selection = yield* resolver.resolveExisting({
        threadId,
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-7" },
        bindingRevision: 7,
      });
      assert.strictEqual(selection.modelId, "claude-opus-4-7");
      assert.strictEqual(selection.modelLabel, "Opus 4.7");
      threadHarness = "opencode";
    }),
  );

  it.effect(
    "admits an explicit revision-checked Claude account switch but rejects a changed login on the bound Connection",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const resolver = yield* ProviderTurnSelectionResolver;
        const accountThreadId = ThreadId.makeUnsafe("selection-claude-account-switch");
        threadHarness = "claudeAgent";
        yield* Effect.promise(() =>
          rememberClaudeThreadAccount({
            stateDir: config.stateDir,
            threadId: accountThreadId,
            account: {
              authenticationMethodId: "claude-account",
              providerIdentityId: "alice@example.com",
            },
          }),
        );
        try {
          const stale = yield* Effect.exit(
            resolver.resolveExisting({
              threadId: accountThreadId,
              connectionId: otherClaudeConnectionId,
              bindingRevision: 6,
            }),
          );
          assert.strictEqual(stale._tag, "Failure");
          if (stale._tag === "Failure") {
            assert.strictEqual(failedWithCode(stale), "binding_revision_stale");
          }
          const selected = yield* resolver.resolveExisting({
            threadId: accountThreadId,
            connectionId: otherClaudeConnectionId,
            bindingRevision: 7,
          });
          assert.strictEqual(selected.changed, true);
          assert.strictEqual(selected.connectionId, otherClaudeConnectionId);
          assert.strictEqual(
            selected.claudeAccountTransition?.target.providerIdentityId,
            "bob@example.com",
          );

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
