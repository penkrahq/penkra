import {
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderTurnSelectionResolver } from "../Services/ProviderTurnSelectionResolver.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { ProviderTurnSelectionResolverLive } from "./ProviderTurnSelectionResolver.ts";

const threadId = ThreadId.makeUnsafe("selection-thread");
const connectionId = ProviderConnectionId.makeUnsafe("selection-go");
const codexConnectionId = ProviderConnectionId.makeUnsafe("selection-codex-managed");
const installationId = ProviderInstallationId.makeUnsafe("selection-installation");
const activeInstallationId = ProviderInstallationId.makeUnsafe("selection-active-installation");
const timestamp = "2026-08-08T00:00:00.000Z";

let connectionLifecycle: "active" | "terminated" = "active";
let modelAvailable = true;
let hasRuntimeBinding = true;
let installationLifecycle: "active" | "retired" = "active";

const dependencies = Layer.mergeAll(
  Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: () =>
      Effect.succeed({
        listModels: (input: { provider: string; internalProviderId?: string | null }) =>
          Effect.succeed({
            models: modelAvailable
              ? [
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
    resolveProfile: (input) =>
      Effect.succeed({
        binaryPath: "/managed/provider",
        isolationKey: `selection:${input.connectionId ?? "anonymous"}`,
        profileRoot: "/managed/profile",
        nativeStateRoot: "/managed/native",
        connectionId: input.connectionId,
        installationId: input.installationId,
        childEnvironment: (environment: NodeJS.ProcessEnv) => environment,
      }),
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
          harness: "opencode",
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
              connectionId,
              installationId,
              internalProviderId: "opencode-go",
              modelId: "opencode-go/kimi-k2.5",
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
      ]),
    getRecord: (id: typeof installationId) =>
      Effect.succeed(
        Option.some({
          id,
          harness: "opencode",
          version: id === activeInstallationId ? "1.18.20" : "1.18.10",
          platform: "darwin",
          architecture: "arm64",
          executablePath: "/managed/opencode",
          artifactSource: "github-release",
          artifactUrl: "https://example.invalid/opencode",
          artifactSha256: "a".repeat(64),
          adapterVersion: "1",
          protocolVersion: "v1",
          lifecycle: id === activeInstallationId ? "active" : installationLifecycle,
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
          harness: id === codexConnectionId ? "codex" : "opencode",
          authenticationTargetId: id === codexConnectionId ? "openai-first-party" : "opencode-go",
          authenticationMethodId: id === codexConnectionId ? "chatgpt" : "api-key",
          label: id === codexConnectionId ? "Personal" : "Go",
          credentialRef: id === codexConnectionId ? null : "provider-secret:selection",
          profileRef: id === codexConnectionId ? `provider-profile:${id}` : null,
          providerIdentityId: null,
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
  it.effect("uses the newest compatible active Connection for a new thread", () =>
    Effect.gen(function* () {
      const resolver = yield* ProviderTurnSelectionResolver;
      const selected = yield* resolver.resolveNewThreadConnection({
        modelSelection: { provider: "codex", model: "gpt-5.5" },
      });
      assert.strictEqual(selected, codexConnectionId);
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
    }),
  );

  it.effect("requires an explicit anonymous selection and exact revision", () =>
    Effect.gen(function* () {
      connectionLifecycle = "active";
      const resolver = yield* ProviderTurnSelectionResolver;

      const current = yield* resolver.resolveExisting({ threadId });
      assert.strictEqual(current.changed, false);
      assert.strictEqual(current.connectionId, connectionId);
      assert.strictEqual(current.internalProviderId, "opencode-go");

      const implicitAnonymous = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
          bindingRevision: 7,
        }),
      );
      assert.strictEqual(implicitAnonymous._tag, "Failure");

      const stale = yield* Effect.exit(
        resolver.resolveExisting({
          threadId,
          modelSelection: { provider: "opencode", model: "opencode/big-pickle" },
          connectionId: null,
          bindingRevision: 6,
        }),
      );
      assert.strictEqual(stale._tag, "Failure");

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

      connectionLifecycle = "terminated";
      const disconnected = yield* Effect.exit(resolver.resolveExisting({ threadId }));
      assert.strictEqual(disconnected._tag, "Failure");
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
    }),
  );
});
