import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { ProviderCredentialBroker } from "../providerCredentialBroker.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { ProviderLaunchResolverLive } from "./ProviderLaunchResolver.ts";

const threadId = ThreadId.makeUnsafe("launch-thread");
const connectionId = ProviderConnectionId.makeUnsafe("launch-connection");
const installationId = ProviderInstallationId.makeUnsafe("launch-installation");
const retiredInstallationId = ProviderInstallationId.makeUnsafe("launch-installation-retired");
const timestamp = "2026-08-08T00:00:00.000Z";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "penkra-launch-resolver-test-",
}).pipe(Layer.provide(NodeServices.layer));
const dependencies = Layer.mergeAll(
  configLayer,
  Layer.succeed(ThreadProviderBindingRepository, {
    getHarnessState: () =>
      Effect.succeed(
        Option.some({
          threadId,
          harness: "opencode",
          nativeStateGenerationId: ProviderNativeStateGenerationId.makeUnsafe("native-launch"),
          providerSessionId: "session-launch",
          nativeStateLocatorJson: '{"session":"session-launch"}',
          lastVerifiedResumeAt: timestamp,
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ),
  } as never),
  Layer.succeed(ProviderInstallationRepository, {
    getRecord: (id: typeof installationId) =>
      Effect.succeed(
        Option.some({
          id,
          harness: "opencode",
          version: "1.18.10",
          platform: "darwin",
          architecture: "arm64",
          executablePath: "/managed/opencode",
          artifactSource: "github-release",
          artifactUrl: "https://example.invalid/opencode",
          artifactSha256: "a".repeat(64),
          adapterVersion: "1",
          protocolVersion: "v1",
          lifecycle: id === retiredInstallationId ? "retired" : "active",
          healthReason: null,
          installedAt: timestamp,
          activatedAt: timestamp,
          retiredAt: null,
        }),
      ),
  } as never),
  Layer.succeed(ProviderConnectionRepository, {
    getRecord: () =>
      Effect.succeed(
        Option.some({
          id: connectionId,
          harness: "opencode",
          authenticationTargetId: "opencode-go",
          authenticationMethodId: "api-key",
          label: "Go",
          credentialRef: "provider-secret:launch",
          profileRef: null,
          providerIdentityId: null,
          health: "ready",
          healthReason: null,
          lastCheckedAt: timestamp,
          lifecycle: "active",
          terminationReason: null,
          terminatedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ),
  } as never),
  Layer.succeed(ProviderCredentialBroker, {
    available: true,
    readOnce: () => Effect.succeed("selected-go-key"),
  } as never),
);
const resolverLayer = ProviderLaunchResolverLive.pipe(Layer.provide(dependencies));
const layer = it.layer(Layer.mergeAll(NodeServices.layer, dependencies, resolverLayer));

layer("ProviderLaunchResolver", (it) => {
  it.effect("launches only the selected OpenCode Go credential in isolated state", () =>
    Effect.gen(function* () {
      const resolver = yield* ProviderLaunchResolver;
      const launch = yield* resolver.resolve({
        threadId,
        connectionId,
        installationId,
        internalProviderId: "opencode-go",
      });
      const environment = launch.childEnvironment({
        PATH: "/usr/bin",
        HOME: "/Users/operator",
        OPENAI_API_KEY: "global-openai",
        ANTHROPIC_API_KEY: "global-anthropic",
      });

      assert.strictEqual(launch.binaryPath, "/managed/opencode");
      assert.strictEqual(environment.OPENAI_API_KEY, undefined);
      assert.strictEqual(environment.ANTHROPIC_API_KEY, undefined);
      assert.deepStrictEqual(JSON.parse(environment.OPENCODE_AUTH_CONTENT ?? ""), {
        "opencode-go": { type: "api", key: "selected-go-key" },
      });
      assert.match(environment.OPENCODE_DB ?? "", /provider-native-state/);
      assert.match(environment.HOME ?? "", /provider-connections/);
    }),
  );

  it.effect("keeps an existing thread pinned to a retained installation", () =>
    Effect.gen(function* () {
      const resolver = yield* ProviderLaunchResolver;
      const pinned = yield* resolver.resolve({
        threadId,
        connectionId,
        installationId: retiredInstallationId,
        internalProviderId: "opencode-go",
      });
      assert.strictEqual(pinned.installationId, retiredInstallationId);

      const newThreadProfile = yield* Effect.exit(
        resolver.resolveProfile({
          harness: "opencode",
          connectionId,
          installationId: retiredInstallationId,
          internalProviderId: "opencode-go",
          nativeStateIdentity: "new-thread-state",
        }),
      );
      assert.strictEqual(newThreadProfile._tag, "Failure");
    }),
  );
});

const codexDependencies = Layer.mergeAll(
  configLayer,
  Layer.succeed(ThreadProviderBindingRepository, {
    getHarnessState: () =>
      Effect.succeed(
        Option.some({
          threadId,
          harness: "codex",
          nativeStateGenerationId:
            ProviderNativeStateGenerationId.makeUnsafe("native-codex-launch"),
          providerSessionId: "session-launch",
          nativeStateLocatorJson: '{"threadId":"session-launch"}',
          lastVerifiedResumeAt: timestamp,
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ),
  } as never),
  Layer.succeed(ProviderInstallationRepository, {
    getRecord: () =>
      Effect.succeed(
        Option.some({
          id: installationId,
          harness: "codex",
          version: "1.0.0",
          platform: "darwin",
          architecture: "arm64",
          executablePath: "/managed/codex",
          artifactSource: "github-release",
          artifactUrl: "https://example.invalid/codex",
          artifactSha256: "a".repeat(64),
          adapterVersion: "1",
          protocolVersion: "v1",
          lifecycle: "active",
          healthReason: null,
          installedAt: timestamp,
          activatedAt: timestamp,
          retiredAt: null,
        }),
      ),
  } as never),
  Layer.succeed(ProviderConnectionRepository, {
    getRecord: () =>
      Effect.succeed(
        Option.some({
          id: connectionId,
          harness: "codex",
          authenticationTargetId: "openai-first-party",
          authenticationMethodId: "chatgpt",
          label: "Codex",
          credentialRef: null,
          profileRef: `provider-profile:${connectionId}`,
          providerIdentityId: null,
          health: "ready",
          healthReason: null,
          lastCheckedAt: timestamp,
          lifecycle: "active",
          terminationReason: null,
          terminatedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ),
  } as never),
  Layer.succeed(ProviderCredentialBroker, {
    available: true,
    readOnce: () => Effect.succeed("selected-openai-key"),
  } as never),
);

it.effect("keeps the real OS home for a Connection-scoped Codex keyring", () =>
  Effect.gen(function* () {
    const resolver = yield* ProviderLaunchResolver;
    const launch = yield* resolver.resolve({
      threadId,
      connectionId,
      installationId,
      internalProviderId: null,
    });
    const environment = launch.childEnvironment({ HOME: "/Users/operator", PATH: "/usr/bin" });

    assert.strictEqual(environment.HOME, "/Users/operator");
    assert.match(environment.CODEX_HOME ?? "", /provider-connections/);
    assert.match(environment.CODEX_SQLITE_HOME ?? "", /provider-native-state/);
  }).pipe(
    Effect.provide(ProviderLaunchResolverLive.pipe(Layer.provide(codexDependencies))),
    Effect.provide(codexDependencies),
    Effect.provide(NodeServices.layer),
  ),
);
