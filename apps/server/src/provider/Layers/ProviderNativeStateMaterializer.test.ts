import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderConnectionId, ProviderNativeStateGenerationId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { providerNativeStateRoot } from "../providerNativeStatePaths.ts";
import { claudeThreadTranscriptPath } from "../claudeThreadNativeState.ts";
import { ProviderNativeStateMaterializer } from "../Services/ProviderNativeStateMaterializer.ts";
import { ProviderNativeStateMaterializerLive } from "./ProviderNativeStateMaterializer.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "penkra-native-state-materializer-test-",
}).pipe(Layer.provide(NodeServices.layer));
const materializerLayer = ProviderNativeStateMaterializerLive.pipe(Layer.provide(configLayer));
const layer = it.layer(Layer.mergeAll(NodeServices.layer, configLayer, materializerLayer));

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

  it.effect("switches a Claude Thread without copying its conversation into either profile", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const materializer = yield* ProviderNativeStateMaterializer;
      const threadId = "claude-switch-thread";
      const sessionId = "550e8400-e29b-41d4-a716-446655440000";
      const source = ProviderNativeStateGenerationId.makeUnsafe("claude-switch-source");
      const target = ProviderNativeStateGenerationId.makeUnsafe("claude-switch-target");
      const transcript = claudeThreadTranscriptPath(config.stateDir, threadId, sessionId);
      yield* Effect.promise(async () => {
        await mkdir(Path.dirname(transcript), { recursive: true });
        await writeFile(
          transcript,
          `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
        );
      });
      const targetRoot = yield* materializer.clone({
        harness: "claudeAgent",
        providerSessionId: sessionId,
        sourceStorage: "connection-profile",
        sourceConnectionId: ProviderConnectionId.makeUnsafe("deleted-source"),
        targetConnectionId: ProviderConnectionId.makeUnsafe("new-target"),
        sourceGenerationId: source,
        targetGenerationId: target,
        sourceThreadId: threadId,
        targetThreadId: threadId,
      });
      assert.strictEqual(
        yield* Effect.promise(() => readFile(transcript, "utf8")),
        `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
      );
      assert.deepStrictEqual(
        JSON.parse(
          yield* Effect.promise(() => readFile(`${targetRoot}/claude-session.json`, "utf8")),
        ),
        { providerSessionId: sessionId },
      );
    }),
  );

  it.effect("marks a missing Claude file so switch reconstructs from Penkra", () =>
    Effect.gen(function* () {
      const materializer = yield* ProviderNativeStateMaterializer;
      const root = yield* materializer.clone({
        harness: "claudeAgent",
        providerSessionId: "550e8400-e29b-41d4-a716-446655440099",
        sourceStorage: "connection-profile",
        sourceConnectionId: ProviderConnectionId.makeUnsafe("deleted-source-missing"),
        targetConnectionId: ProviderConnectionId.makeUnsafe("new-target-missing"),
        sourceGenerationId: ProviderNativeStateGenerationId.makeUnsafe("missing-source"),
        targetGenerationId: ProviderNativeStateGenerationId.makeUnsafe("missing-target"),
        sourceThreadId: "missing-thread",
        targetThreadId: "missing-thread",
      });
      assert.deepStrictEqual(
        JSON.parse(yield* Effect.promise(() => readFile(`${root}/claude-session.json`, "utf8"))),
        {
          providerSessionId: "550e8400-e29b-41d4-a716-446655440099",
          requiresReconstruction: true,
        },
      );
    }),
  );

  it.effect(
    "copies an exact Claude fork into a different Thread and removes an uncommitted fork",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const materializer = yield* ProviderNativeStateMaterializer;
        const sourceThreadId = "claude-fork-source-thread";
        const targetThreadId = "claude-fork-target-thread";
        const sessionId = "550e8400-e29b-41d4-a716-446655440001";
        const sourceTranscript = claudeThreadTranscriptPath(
          config.stateDir,
          sourceThreadId,
          sessionId,
        );
        const targetTranscript = claudeThreadTranscriptPath(
          config.stateDir,
          targetThreadId,
          sessionId,
        );
        yield* Effect.promise(async () => {
          await mkdir(Path.dirname(sourceTranscript), { recursive: true });
          await writeFile(
            sourceTranscript,
            '{"type":"assistant","message":{"role":"assistant","content":"source"}}\n',
          );
        });
        const generation = ProviderNativeStateGenerationId.makeUnsafe(
          "claude-fork-target-generation",
        );
        yield* materializer.clone({
          harness: "claudeAgent",
          providerSessionId: sessionId,
          sourceStorage: "connection-profile",
          sourceConnectionId: null,
          targetConnectionId: null,
          sourceGenerationId: ProviderNativeStateGenerationId.makeUnsafe(
            "claude-fork-source-generation",
          ),
          targetGenerationId: generation,
          sourceThreadId,
          targetThreadId,
        });
        assert.strictEqual(
          yield* Effect.promise(() => readFile(targetTranscript, "utf8")),
          yield* Effect.promise(() => readFile(sourceTranscript, "utf8")),
        );
        yield* materializer.discard(generation);
        assert.isFalse(
          yield* Effect.promise(() =>
            access(targetTranscript).then(
              () => true,
              () => false,
            ),
          ),
        );
        assert.isTrue(
          yield* Effect.promise(() =>
            access(sourceTranscript).then(
              () => true,
              () => false,
            ),
          ),
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
        mkdir(`${sourceRoot}/xdg-data/opencode/storage`, {
          recursive: true,
          mode: 0o700,
        }),
      );
      yield* Effect.sync(() => {
        const database = new DatabaseSync(`${sourceRoot}/opencode.db`);
        database.exec(
          "PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('session');",
        );
        database.close();
      });
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
      assert.isFalse(
        yield* Effect.promise(() =>
          access(`${targetRoot}/opencode.db-wal`).then(
            () => true,
            () => false,
          ),
        ),
      );
      assert.strictEqual(
        yield* Effect.sync(() => {
          const database = new DatabaseSync(`${targetRoot}/opencode.db`, {
            readOnly: true,
          });
          try {
            return database.prepare("SELECT id FROM sessions").get()?.id;
          } finally {
            database.close();
          }
        }),
        "session",
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
