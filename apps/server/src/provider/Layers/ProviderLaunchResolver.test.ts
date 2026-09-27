import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "node:path";
import {
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { access, mkdir, readFile, readlink, writeFile } from "node:fs/promises";

import { ServerConfig } from "../../config.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { ProviderCredentialBroker } from "../providerCredentialBroker.ts";
import {
  providerConnectionProfileRoot,
  providerCredentialProfileRoot,
} from "../providerNativeStatePaths.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { claudeThreadProjectName, claudeThreadTranscriptPath } from "../claudeThreadNativeState.ts";
import { ProviderLaunchResolverLive } from "./ProviderLaunchResolver.ts";

const threadId = ThreadId.makeUnsafe("launch-thread");
const connectionId = ProviderConnectionId.makeUnsafe("launch-connection");
const installationId = ProviderInstallationId.makeUnsafe("launch-installation");
const retiredInstallationId = ProviderInstallationId.makeUnsafe("launch-installation-retired");
const timestamp = "2026-08-08T00:00:00.000Z";
const codexProfileRef = "provider-profile:credential-generation-two";

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
          profileRef: codexProfileRef,
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
    const environment = launch.childEnvironment({
      HOME: "/Users/operator",
      PATH: "/usr/bin",
    });

    if (process.platform === "darwin") {
      assert.strictEqual(environment.HOME, "/Users/operator");
    } else {
      assert.match(environment.HOME ?? "", /provider-connections/);
    }
    assert.match(environment.CODEX_HOME ?? "", /provider-connections/);
    assert.strictEqual(
      Path.dirname(environment.CODEX_HOME ?? ""),
      providerCredentialProfileRoot((yield* ServerConfig).stateDir, codexProfileRef),
    );
    assert.strictEqual(
      Path.dirname(environment.CODEX_SQLITE_HOME ?? ""),
      providerCredentialProfileRoot((yield* ServerConfig).stateDir, codexProfileRef),
    );
  }).pipe(
    Effect.provide(ProviderLaunchResolverLive.pipe(Layer.provide(codexDependencies))),
    Effect.provide(codexDependencies),
    Effect.provide(NodeServices.layer),
  ),
);

const claudeActiveProfileRef = "provider-profile:claude-active-profile";
const claudeSessionId = "550e8400-e29b-41d4-a716-446655440088";
const claudeDependencies = Layer.mergeAll(
  configLayer,
  Layer.succeed(ThreadProviderBindingRepository, {
    getHarnessState: () =>
      Effect.succeed(
        Option.some({
          threadId,
          harness: "claudeAgent",
          nativeStateGenerationId:
            ProviderNativeStateGenerationId.makeUnsafe("native-claude-launch"),
          providerSessionId: claudeSessionId,
          nativeStateLocatorJson: JSON.stringify({ resume: claudeSessionId }),
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
          harness: "claudeAgent",
          version: "2.1.259",
          platform: "darwin",
          architecture: "arm64",
          executablePath: "/managed/claude",
          artifactSource: "github-release",
          artifactUrl: "https://example.invalid/claude",
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
          harness: "claudeAgent",
          authenticationTargetId: "anthropic-first-party",
          authenticationMethodId: "claude-account",
          label: "Claude",
          credentialRef: null,
          profileRef: claudeActiveProfileRef,
          providerIdentityId: "person@example.com",
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
    readOnce: () => Effect.die("unused"),
  } as never),
);

it.effect("links a Claude Thread's canonical project into the selected login profile", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const activeRoot = providerConnectionProfileRoot(config.stateDir, "claude-active-profile");
    const transcript = claudeThreadTranscriptPath(config.stateDir, threadId, claudeSessionId);
    const real = `${JSON.stringify({
      type: "assistant",
      uuid: "assistant-real",
      sessionId: claudeSessionId,
    })}\n`;
    yield* Effect.promise(async () => {
      await mkdir(Path.dirname(transcript), { recursive: true });
      await writeFile(transcript, real);
    });

    const resolver = yield* ProviderLaunchResolver;
    const launch = yield* resolver.resolve({
      threadId,
      connectionId,
      installationId,
      internalProviderId: null,
    });
    const projectName = claudeThreadProjectName(threadId);
    const link = Path.join(activeRoot, "claude-config", "projects", projectName);
    assert.strictEqual(
      yield* Effect.promise(() => readFile(Path.join(link, `${claudeSessionId}.jsonl`), "utf8")),
      real,
    );
    assert.strictEqual(yield* Effect.promise(() => readlink(link)), Path.dirname(transcript));
    assert.strictEqual(launch.childEnvironment({}).CLAUDE_CODE_PROJECT_DIR_NAME, projectName);
    assert.strictEqual(
      JSON.parse(
        yield* Effect.promise(() =>
          readFile(Path.join(activeRoot, "claude-config", "settings.json"), "utf8"),
        ),
      ).cleanupPeriodDays,
      36_500,
    );
  }).pipe(
    Effect.provide(ProviderLaunchResolverLive.pipe(Layer.provide(claudeDependencies))),
    Effect.provide(claudeDependencies),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("ignores an old profile transcript so the Thread can rebuild from Penkra", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const retiredRoot = providerConnectionProfileRoot(config.stateDir, "claude-retired-profile");
    const legacy = Path.join(
      retiredRoot,
      "claude-config",
      "projects",
      "old-cwd",
      `${claudeSessionId}.jsonl`,
    );
    const canonical = claudeThreadTranscriptPath(config.stateDir, threadId, claudeSessionId);
    const bytes = '{"type":"user","message":{"role":"user","content":"legacy"}}\n';
    yield* Effect.promise(async () => {
      await mkdir(Path.dirname(legacy), { recursive: true });
      await writeFile(legacy, bytes);
    });
    const resolver = yield* ProviderLaunchResolver;
    yield* resolver.resolve({ threadId, connectionId, installationId, internalProviderId: null });
    assert.isFalse(
      yield* Effect.promise(() =>
        access(canonical).then(
          () => true,
          () => false,
        ),
      ),
    );
    assert.strictEqual(yield* Effect.promise(() => readFile(legacy, "utf8")), bytes);
  }).pipe(
    Effect.provide(ProviderLaunchResolverLive.pipe(Layer.provide(claudeDependencies))),
    Effect.provide(claudeDependencies),
    Effect.provide(NodeServices.layer),
  ),
);
