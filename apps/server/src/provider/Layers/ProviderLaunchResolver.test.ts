import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "node:path";
import {
  type ProviderKind,
  ProviderConnectionId,
  ProviderInstallationId,
  ThreadId,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { access, mkdir, readFile, readlink, writeFile } from "node:fs/promises";

import { ServerConfig } from "../../config.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createThread } from "../../cleanCore/threadStore.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { ProviderCredentialBroker } from "../providerCredentialBroker.ts";
import {
  providerConnectionProfileRoot,
  providerCredentialProfileRoot,
} from "../providerNativeStatePaths.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import {
  claudeThreadProjectName,
  claudeThreadTranscriptPath,
  readClaudeThreadAccount,
} from "../claudeThreadNativeState.ts";
import { ProviderLaunchResolverLive } from "./ProviderLaunchResolver.ts";
import { ProviderNativeStateMaterializer } from "../Services/ProviderNativeStateMaterializer.ts";
import { ProviderNativeStateMaterializerLive } from "./ProviderNativeStateMaterializer.ts";

const threadId = ThreadId.makeUnsafe("launch-thread");
const connectionId = ProviderConnectionId.makeUnsafe("launch-connection");
const installationId = ProviderInstallationId.makeUnsafe("launch-installation");
const retiredInstallationId = ProviderInstallationId.makeUnsafe("launch-installation-retired");
const nextInstallationId = ProviderInstallationId.makeUnsafe("launch-installation-new");
let activeLaunchInstallationId = installationId;
const qaFixtureInstallationId = ProviderInstallationId.makeUnsafe("launch-qa-fixture");
const timestamp = "2026-08-08T00:00:00.000Z";
const codexProfileRef = "provider-profile:credential-generation-two";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "penkra-launch-resolver-test-",
}).pipe(Layer.provide(NodeServices.layer));
const nativeThreadFixture = (
  provider: ProviderKind,
  nativeStateId: string,
  providerSessionId: string,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("launch-folder", "launch-space");
      yield* createThread({
        id: threadId,
        provider,
        folderId: "launch-folder",
        spaceId: "launch-space",
        title: "Launch",
        model: "launch-model",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: timestamp,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET connection_id=${connectionId}, native_state_id=${nativeStateId}, provider_session_id=${providerSessionId} WHERE id=${threadId}`;
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const dependencies = Layer.mergeAll(
  configLayer,
  nativeThreadFixture("opencode", "native-launch", "session-launch"),
  Layer.succeed(ProviderInstallationRepository, {
    getActiveRecord: () => Effect.succeed(Option.some({ id: activeLaunchInstallationId })),
    getRecord: (id: typeof installationId) =>
      Effect.succeed(
        Option.some({
          id,
          harness: "opencode",
          version: "1.18.10",
          platform: "darwin",
          architecture: "arm64",
          executablePath: id === nextInstallationId ? "/managed/opencode-new" : "/managed/opencode",
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

  it.effect("launches the active installation and rejects a retained discovery profile", () =>
    Effect.gen(function* () {
      const resolver = yield* ProviderLaunchResolver;
      const launch = yield* resolver.resolve({
        threadId,
        connectionId,
        internalProviderId: "opencode-go",
      });
      assert.strictEqual(launch.installationId, installationId);

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
  it.effect("the next process launch reads the newly active installation", () =>
    Effect.gen(function* () {
      const resolver = yield* ProviderLaunchResolver;
      const first = yield* resolver.resolve({
        threadId,
        connectionId,
        internalProviderId: "opencode-go",
      });
      activeLaunchInstallationId = nextInstallationId;
      try {
        const next = yield* resolver.resolve({
          threadId,
          connectionId,
          internalProviderId: "opencode-go",
        });
        assert.strictEqual(first.installationId, installationId);
        assert.strictEqual(first.binaryPath, "/managed/opencode");
        assert.strictEqual(next.installationId, nextInstallationId);
        assert.strictEqual(next.binaryPath, "/managed/opencode-new");
        assert.strictEqual(next.nativeStateRoot, first.nativeStateRoot);
        assert.notStrictEqual(next.isolationKey, first.isolationKey);
      } finally {
        activeLaunchInstallationId = installationId;
      }
    }),
  );
});

const codexDependencies = Layer.mergeAll(
  configLayer,
  nativeThreadFixture("codex", "native-codex-launch", "session-launch"),
  Layer.succeed(ProviderInstallationRepository, {
    getActiveRecord: () => Effect.succeed(Option.some({ id: installationId })),
    getRecord: (id: typeof installationId) =>
      Effect.succeed(
        Option.some({
          id,
          harness: "codex",
          version: "1.0.0",
          platform: "darwin",
          architecture: "arm64",
          executablePath: "/managed/codex",
          artifactSource: id === qaFixtureInstallationId ? "qa-fixture" : "github-release",
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

it.effect("rejects a QA fixture installation in an ordinary server profile", () =>
  Effect.gen(function* () {
    const resolver = yield* ProviderLaunchResolver;
    const result = yield* Effect.exit(
      resolver.resolveProfile({
        harness: "codex",
        connectionId,
        installationId: qaFixtureInstallationId,
        internalProviderId: null,
        nativeStateIdentity: "qa-fixture-attempt",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.match(String(result.cause), /QA fixture installation is unavailable/);
    }
  }).pipe(
    Effect.provide(ProviderLaunchResolverLive.pipe(Layer.provide(codexDependencies))),
    Effect.provide(codexDependencies),
    Effect.provide(NodeServices.layer),
  ),
);

const claudeActiveProfileRef = "provider-profile:claude-active-profile";
const claudeOtherConnectionId = ProviderConnectionId.makeUnsafe("launch-claude-other-connection");
const claudeSessionId = "550e8400-e29b-41d4-a716-446655440088";
const claudeDependencies = Layer.mergeAll(
  configLayer,
  nativeThreadFixture("claudeAgent", "native-claude-launch", claudeSessionId),
  Layer.succeed(ProviderInstallationRepository, {
    getActiveRecord: () => Effect.succeed(Option.some({ id: installationId })),
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
    getRecord: (id: typeof connectionId) =>
      Effect.succeed(
        Option.some({
          id,
          harness: "claudeAgent",
          authenticationTargetId: "anthropic-first-party",
          authenticationMethodId: "claude-account",
          label: "Claude",
          credentialRef: null,
          profileRef:
            id === claudeOtherConnectionId
              ? "provider-profile:claude-other-profile"
              : claudeActiveProfileRef,
          providerIdentityId:
            id === claudeOtherConnectionId ? "other@example.com" : "person@example.com",
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
    const transcript = claudeThreadTranscriptPath(
      config.stateDir,
      "native-claude-launch",
      claudeSessionId,
    );
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
    const canonical = claudeThreadTranscriptPath(
      config.stateDir,
      "native-claude-launch",
      claudeSessionId,
    );
    const bytes = '{"type":"user","message":{"role":"user","content":"legacy"}}\n';
    yield* Effect.promise(async () => {
      await mkdir(Path.dirname(legacy), { recursive: true });
      await writeFile(legacy, bytes);
    });
    const resolver = yield* ProviderLaunchResolver;
    yield* resolver.resolve({ threadId, connectionId, internalProviderId: null });
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

it.effect(
  "a new Claude connection resumes the copied native folder and leaves the old folder untouched",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const resolver = yield* ProviderLaunchResolver;
      const materializer = yield* ProviderNativeStateMaterializer;
      const source = "native-claude-launch";
      const target = "native-claude-account-switch";
      const transcript = claudeThreadTranscriptPath(config.stateDir, source, claudeSessionId);
      const text = '{"type":"user","message":{"content":"exact source conversation"}}\n';
      yield* resolver.resolve({ threadId, connectionId, internalProviderId: null });
      yield* Effect.promise(() => writeFile(transcript, text));
      const sourceOwner = yield* Effect.promise(() =>
        readClaudeThreadAccount(config.stateDir, source),
      );
      yield* materializer.clone({
        harness: "claudeAgent",
        providerSessionId: claudeSessionId,
        sourceNativeStateId: source,
        targetNativeStateId: target,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET connection_id=${claudeOtherConnectionId}, native_state_id=${target} WHERE id=${threadId}`;
      const launch = yield* resolver.resolve({
        threadId,
        connectionId: claudeOtherConnectionId,
        internalProviderId: null,
      });
      const link = Path.join(
        launch.profileRoot,
        "claude-config",
        "projects",
        claudeThreadProjectName(threadId),
      );
      const copiedTranscript = claudeThreadTranscriptPath(config.stateDir, target, claudeSessionId);
      assert.strictEqual(
        yield* Effect.promise(() => readlink(link)),
        Path.dirname(copiedTranscript),
      );
      assert.strictEqual(
        yield* Effect.promise(() => readFile(Path.join(link, `${claudeSessionId}.jsonl`), "utf8")),
        text,
      );
      assert.strictEqual(launch.connectionId, claudeOtherConnectionId);
      assert.strictEqual(
        (yield* Effect.promise(() => readClaudeThreadAccount(config.stateDir, target)))
          ?.providerIdentityId,
        "other@example.com",
      );
      yield* Effect.promise(() => writeFile(copiedTranscript, "new account continuation"));
      assert.strictEqual(yield* Effect.promise(() => readFile(transcript, "utf8")), text);
      assert.deepStrictEqual(
        yield* Effect.promise(() => readClaudeThreadAccount(config.stateDir, source)),
        sourceOwner,
      );
    }).pipe(
      Effect.provide(ProviderNativeStateMaterializerLive.pipe(Layer.provide(claudeDependencies))),
      Effect.provide(ProviderLaunchResolverLive.pipe(Layer.provide(claudeDependencies))),
      Effect.provide(claudeDependencies),
      Effect.provide(NodeServices.layer),
    ),
);
