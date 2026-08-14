import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderConnectionId, ProviderNativeStateGenerationId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  providerConnectionProfileRoot,
  providerNativeStateRoot,
} from "../providerNativeStatePaths.ts";
import { ProviderNativeStateMaterializer } from "../Services/ProviderNativeStateMaterializer.ts";
import { ProviderNativeStateMaterializerLive } from "./ProviderNativeStateMaterializer.ts";
import { ProviderConnectionRepositoryLive } from "../../persistence/Layers/ProviderConnections.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "penkra-native-state-materializer-test-",
}).pipe(Layer.provide(NodeServices.layer));
const sqliteLayer = NodeSqliteClient.layerMemory();
const connectionLayer = ProviderConnectionRepositoryLive.pipe(Layer.provide(sqliteLayer));
const materializerLayer = ProviderNativeStateMaterializerLive.pipe(
  Layer.provide(connectionLayer),
  Layer.provide(configLayer),
);
const layer = it.layer(
  Layer.mergeAll(NodeServices.layer, sqliteLayer, configLayer, connectionLayer, materializerLayer),
);

const createClaudeConnections = (
  sourceConnectionId: ProviderConnectionId | null,
  targetConnectionId: ProviderConnectionId,
) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const connections = yield* ProviderConnectionRepository;
    const createdAt = new Date().toISOString();
    for (const connectionId of [sourceConnectionId, targetConnectionId]) {
      if (connectionId === null) continue;
      yield* connections.create({
        id: connectionId,
        harness: "claudeAgent",
        authenticationTargetId: "anthropic-first-party",
        authenticationMethodId: "account",
        label: `Claude ${connectionId}`,
        credentialRef: null,
        profileRef: `provider-profile:${connectionId}`,
        providerIdentityId: null,
        createdAt,
      });
    }
  });

layer("ProviderNativeStateMaterializer", (it) => {
  it.effect("publishes one exact Codex clone and never reuses an existing target", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const materializer = yield* ProviderNativeStateMaterializer;
      const source = ProviderNativeStateGenerationId.makeUnsafe("materializer-source");
      const target = ProviderNativeStateGenerationId.makeUnsafe("materializer-target");
      const sourceRoot = providerNativeStateRoot(config.stateDir, source);
      yield* Effect.promise(() => mkdir(sourceRoot, { recursive: true, mode: 0o700 }));
      const sessionId = "codex-session-exact";
      const rollout = `${sourceRoot}/codex-rollouts/sessions/2026/08/09/rollout-now-${sessionId}.jsonl`;
      yield* Effect.promise(() => mkdir(Path.dirname(rollout), { recursive: true, mode: 0o700 }));
      yield* Effect.promise(() => writeFile(rollout, '{"session":"exact"}'));
      yield* Effect.promise(() => writeFile(`${sourceRoot}/profile-secret.json`, "secret"));

      const targetRoot = yield* materializer.clone({
        harness: "codex",
        providerSessionId: sessionId,
        sourceStorage: "generation",
        sourceConnectionId: null,
        targetConnectionId: null,
        sourceGenerationId: source,
        targetGenerationId: target,
      });
      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(
            `${targetRoot}/codex-rollouts/sessions/2026/08/09/rollout-now-${sessionId}.jsonl`,
            "utf8",
          ),
        ),
        '{"session":"exact"}',
      );
      assert.strictEqual(
        yield* Effect.promise(() =>
          access(`${targetRoot}/profile-secret.json`).then(
            () => true,
            () => false,
          ),
        ),
        false,
      );
      const duplicate = yield* Effect.exit(
        materializer.clone({
          harness: "codex",
          providerSessionId: sessionId,
          sourceStorage: "generation",
          sourceConnectionId: null,
          targetConnectionId: null,
          sourceGenerationId: source,
          targetGenerationId: target,
        }),
      );
      assert.strictEqual(duplicate._tag, "Failure");

      yield* materializer.discard(target);
      const discarded = yield* Effect.exit(
        Effect.promise(() =>
          readFile(
            `${targetRoot}/codex-rollouts/sessions/2026/08/09/rollout-now-${sessionId}.jsonl`,
            "utf8",
          ),
        ),
      );
      assert.strictEqual(discarded._tag, "Failure");
    }),
  );

  it.effect("copies only the exact Claude session artifacts", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const materializer = yield* ProviderNativeStateMaterializer;
      const source = ProviderNativeStateGenerationId.makeUnsafe("materializer-claude-source");
      const target = ProviderNativeStateGenerationId.makeUnsafe("materializer-claude-target");
      const sourceConnectionId = ProviderConnectionId.makeUnsafe("claude-source-connection");
      const targetConnectionId = ProviderConnectionId.makeUnsafe("claude-target-connection");
      yield* createClaudeConnections(sourceConnectionId, targetConnectionId);
      const sourceProfile = providerConnectionProfileRoot(config.stateDir, sourceConnectionId);
      const targetProfile = providerConnectionProfileRoot(config.stateDir, targetConnectionId);
      const sessionId = "550e8400-e29b-41d4-a716-446655440000";
      const projectRoot = `${sourceProfile}/claude-config/projects/-workspace`;
      yield* Effect.promise(() => mkdir(projectRoot, { recursive: true, mode: 0o700 }));
      yield* Effect.promise(() => writeFile(`${projectRoot}/${sessionId}.jsonl`, "session"));
      yield* Effect.promise(() =>
        writeFile(`${sourceProfile}/claude-config/.credentials.json`, "secret"),
      );

      const targetRoot = yield* materializer.clone({
        harness: "claudeAgent",
        providerSessionId: sessionId,
        sourceStorage: "connection-profile",
        sourceConnectionId,
        targetConnectionId,
        sourceGenerationId: source,
        targetGenerationId: target,
      });
      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(`${targetProfile}/claude-config/projects/-workspace/${sessionId}.jsonl`, "utf8"),
        ),
        "session",
      );
      assert.strictEqual(
        yield* Effect.promise(() =>
          access(`${targetProfile}/claude-config/.credentials.json`).then(
            () => true,
            () => false,
          ),
        ),
        false,
      );
      assert.deepStrictEqual(
        JSON.parse(
          yield* Effect.promise(() => readFile(`${targetRoot}/claude-session.json`, "utf8")),
        ),
        { providerSessionId: sessionId },
      );
    }),
  );

  it.effect("replaces a stale Claude session exactly and rolls it back until finalized", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const materializer = yield* ProviderNativeStateMaterializer;
      const sourceConnectionId = ProviderConnectionId.makeUnsafe("claude-current-connection");
      const targetConnectionId = ProviderConnectionId.makeUnsafe("claude-stale-connection");
      yield* createClaudeConnections(sourceConnectionId, targetConnectionId);
      const sourceProfile = providerConnectionProfileRoot(config.stateDir, sourceConnectionId);
      const targetProfile = providerConnectionProfileRoot(config.stateDir, targetConnectionId);
      const sessionId = "550e8400-e29b-41d4-a716-446655440010";
      const relativeSession = `claude-config/projects/-workspace/${sessionId}.jsonl`;
      const sourceSession = `${sourceProfile}/${relativeSession}`;
      const targetSession = `${targetProfile}/${relativeSession}`;
      yield* Effect.promise(() =>
        Promise.all([
          mkdir(Path.dirname(sourceSession), { recursive: true, mode: 0o700 }),
          mkdir(Path.dirname(targetSession), { recursive: true, mode: 0o700 }),
        ]),
      );
      yield* Effect.promise(() => writeFile(sourceSession, "current"));
      yield* Effect.promise(() => writeFile(targetSession, "stale"));
      yield* Effect.promise(() =>
        writeFile(`${targetProfile}/claude-config/.credentials.json`, "target-secret"),
      );

      const discardedGeneration = ProviderNativeStateGenerationId.makeUnsafe(
        "materializer-claude-replaced-discarded",
      );
      yield* materializer.clone({
        harness: "claudeAgent",
        providerSessionId: sessionId,
        sourceStorage: "connection-profile",
        sourceConnectionId,
        targetConnectionId,
        sourceGenerationId: ProviderNativeStateGenerationId.makeUnsafe("unused-source"),
        targetGenerationId: discardedGeneration,
      });
      assert.strictEqual(yield* Effect.promise(() => readFile(targetSession, "utf8")), "current");
      yield* materializer.discard(discardedGeneration);
      assert.strictEqual(yield* Effect.promise(() => readFile(targetSession, "utf8")), "stale");

      const finalizedGeneration = ProviderNativeStateGenerationId.makeUnsafe(
        "materializer-claude-replaced-finalized",
      );
      yield* materializer.clone({
        harness: "claudeAgent",
        providerSessionId: sessionId,
        sourceStorage: "connection-profile",
        sourceConnectionId,
        targetConnectionId,
        sourceGenerationId: ProviderNativeStateGenerationId.makeUnsafe("unused-source"),
        targetGenerationId: finalizedGeneration,
      });
      yield* materializer.finalize(finalizedGeneration);
      yield* materializer.discard(finalizedGeneration);
      assert.strictEqual(yield* Effect.promise(() => readFile(targetSession, "utf8")), "current");
      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(`${targetProfile}/claude-config/.credentials.json`, "utf8"),
        ),
        "target-secret",
      );
    }),
  );

  it.effect("adopts an exact legacy Claude generation into the target Connection profile", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const materializer = yield* ProviderNativeStateMaterializer;
      const source = ProviderNativeStateGenerationId.makeUnsafe("materializer-legacy-claude");
      const target = ProviderNativeStateGenerationId.makeUnsafe(
        "materializer-legacy-claude-target",
      );
      const targetConnectionId = ProviderConnectionId.makeUnsafe("legacy-claude-target-connection");
      yield* createClaudeConnections(null, targetConnectionId);
      const sourceRoot = providerNativeStateRoot(config.stateDir, source);
      const targetProfile = providerConnectionProfileRoot(config.stateDir, targetConnectionId);
      const sessionId = "550e8400-e29b-41d4-a716-446655440001";
      const sourceProjectRoot = `${sourceRoot}/claude-config/projects/-legacy-workspace`;
      yield* Effect.promise(() => mkdir(sourceProjectRoot, { recursive: true, mode: 0o700 }));
      yield* Effect.promise(() => writeFile(`${sourceProjectRoot}/${sessionId}.jsonl`, "legacy"));
      yield* Effect.promise(() =>
        writeFile(`${sourceRoot}/claude-config/.credentials.json`, "legacy-secret"),
      );

      const targetRoot = yield* materializer.clone({
        harness: "claudeAgent",
        providerSessionId: sessionId,
        sourceStorage: "generation",
        sourceConnectionId: null,
        targetConnectionId,
        sourceGenerationId: source,
        targetGenerationId: target,
      });

      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(
            `${targetProfile}/claude-config/projects/-legacy-workspace/${sessionId}.jsonl`,
            "utf8",
          ),
        ),
        "legacy",
      );
      assert.strictEqual(
        yield* Effect.promise(() =>
          access(`${targetProfile}/claude-config/.credentials.json`).then(
            () => true,
            () => false,
          ),
        ),
        false,
      );
      assert.deepStrictEqual(
        JSON.parse(
          yield* Effect.promise(() => readFile(`${targetRoot}/claude-session.json`, "utf8")),
        ),
        { providerSessionId: sessionId },
      );
    }),
  );

  it.effect("copies OpenCode conversation state without profile authentication", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const materializer = yield* ProviderNativeStateMaterializer;
      const source = ProviderNativeStateGenerationId.makeUnsafe("materializer-opencode-source");
      const target = ProviderNativeStateGenerationId.makeUnsafe("materializer-opencode-target");
      const sourceRoot = providerNativeStateRoot(config.stateDir, source);
      yield* Effect.promise(() =>
        mkdir(`${sourceRoot}/xdg-data/opencode/storage`, { recursive: true, mode: 0o700 }),
      );
      yield* Effect.promise(() => writeFile(`${sourceRoot}/opencode.db`, "database"));
      yield* Effect.promise(() =>
        writeFile(`${sourceRoot}/xdg-data/opencode/storage/session.json`, "session"),
      );
      yield* Effect.promise(() => writeFile(`${sourceRoot}/xdg-data/opencode/auth.json`, "secret"));

      const targetRoot = yield* materializer.clone({
        harness: "opencode",
        providerSessionId: "ses_exact",
        sourceStorage: "generation",
        sourceConnectionId: null,
        targetConnectionId: null,
        sourceGenerationId: source,
        targetGenerationId: target,
      });
      assert.strictEqual(
        yield* Effect.promise(() => readFile(`${targetRoot}/opencode.db`, "utf8")),
        "database",
      );
      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(`${targetRoot}/xdg-data/opencode/storage/session.json`, "utf8"),
        ),
        "session",
      );
      assert.strictEqual(
        yield* Effect.promise(() =>
          access(`${targetRoot}/xdg-data/opencode/auth.json`).then(
            () => true,
            () => false,
          ),
        ),
        false,
      );
    }),
  );
});
