import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { providerNativeStateRoot, providerOpaquePathKey } from "../providerNativeStatePaths.ts";
import { ProviderNativeStateMaterializer } from "../Services/ProviderNativeStateMaterializer.ts";
import { ProviderNativeStateMaterializerLive } from "./ProviderNativeStateMaterializer.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "penkra-native-state-materializer-test-",
}).pipe(Layer.provide(NodeServices.layer));
const materializerLayer = ProviderNativeStateMaterializerLive.pipe(Layer.provide(configLayer));
const layer = it.layer(Layer.mergeAll(NodeServices.layer, configLayer, materializerLayer));

layer("ProviderNativeStateMaterializer", (it) => {
  it.effect("rejects cloning native state onto its source folder", () =>
    Effect.gen(function* () {
      const materializer = yield* ProviderNativeStateMaterializer;
      const nativeStateId = "same-native-state";
      const failed = yield* Effect.exit(
        materializer.clone({
          harness: "codex",
          providerSessionId: "session-secret",
          sourceNativeStateId: nativeStateId,
          targetNativeStateId: nativeStateId,
        }),
      );
      assert.strictEqual(failed._tag, "Failure");
    }),
  );

  it.effect("publishes one exact Codex clone and never reuses an existing target", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const materializer = yield* ProviderNativeStateMaterializer;
      const source = "materializer-source";
      const target = "materializer-target";
      const sourceRoot = providerNativeStateRoot(config.stateDir, source);
      yield* Effect.promise(() => mkdir(sourceRoot, { recursive: true, mode: 0o700 }));
      const sessionId = "codex-session-exact";
      const rollout = `${sourceRoot}/codex-rollouts/sessions/2026/08/09/rollout-now-${sessionId}.jsonl`;
      yield* Effect.promise(() => mkdir(Path.dirname(rollout), { recursive: true, mode: 0o700 }));
      yield* Effect.promise(() => writeFile(rollout, '{"session":"exact"}'));
      yield* Effect.promise(() => writeFile(`${sourceRoot}/profile-secret.json`, "secret"));

      const { root: targetRoot } = yield* materializer.clone({
        harness: "codex",
        providerSessionId: sessionId,
        sourceNativeStateId: source,
        targetNativeStateId: target,
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
          sourceNativeStateId: source,
          targetNativeStateId: target,
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

  it.effect(
    "copies a Claude conversation into a new native-state folder without changing the source",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const materializer = yield* ProviderNativeStateMaterializer;
        const sessionId = "550e8400-e29b-41d4-a716-446655440000";
        const source = "claude-switch-source";
        const target = "claude-switch-target";
        const sourceRoot = providerNativeStateRoot(config.stateDir, source);
        const transcript = Path.join(sourceRoot, "claude", "project", `${sessionId}.jsonl`);
        yield* Effect.promise(async () => {
          await mkdir(Path.dirname(transcript), { recursive: true });
          await writeFile(
            transcript,
            `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
          );
        });
        const { root: targetRoot, providerSessionId: copiedSessionId } = yield* materializer.clone({
          harness: "claudeAgent",
          providerSessionId: sessionId,
          sourceNativeStateId: source,
          targetNativeStateId: target,
        });
        assert.strictEqual(
          yield* Effect.promise(() => readFile(transcript, "utf8")),
          `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
        );
        const copiedTranscript = Path.join(targetRoot, "claude", "project", `${sessionId}.jsonl`);
        assert.strictEqual(
          yield* Effect.promise(() => readFile(copiedTranscript, "utf8")),
          yield* Effect.promise(() => readFile(transcript, "utf8")),
        );
        yield* Effect.promise(() => writeFile(copiedTranscript, "target-only continuation"));
        assert.strictEqual(
          yield* Effect.promise(() => readFile(transcript, "utf8")),
          `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
        );
        assert.strictEqual(copiedSessionId, sessionId);
        assert.strictEqual(
          yield* Effect.promise(() =>
            access(Path.join(targetRoot, "claude-session.json")).then(
              () => true,
              () => false,
            ),
          ),
          false,
        );
      }),
  );

  it.effect(
    "copies the active account-scoped Claude conversation rather than a stale top-level project",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const materializer = yield* ProviderNativeStateMaterializer;
        const source = "claude-scoped-source";
        const target = "claude-scoped-target";
        const root = Path.join(providerNativeStateRoot(config.stateDir, source), "claude");
        const owner = {
          authenticationMethodId: "claude-account",
          providerIdentityId: "source@example.com",
          projectRevision: 8,
        };
        const scopedRoot = Path.join(
          root,
          "accounts",
          providerOpaquePathKey("claude-account:source@example.com"),
          "revision-8",
        );
        const text = '{"type":"assistant","message":{"content":"active conversation"}}\n';
        yield* Effect.promise(async () => {
          await mkdir(Path.join(root, "project"), { recursive: true });
          await mkdir(Path.join(scopedRoot, "project"), { recursive: true });
          await mkdir(Path.join(scopedRoot, "tasks", "scoped-session"), { recursive: true });
          await writeFile(
            Path.join(root, "project", "scoped-session.jsonl"),
            "stale original account",
          );
          await writeFile(Path.join(scopedRoot, "project", "scoped-session.jsonl"), text);
          await writeFile(
            Path.join(scopedRoot, "tasks", "scoped-session", "task.json"),
            "active task",
          );
          await writeFile(Path.join(root, "account.json"), JSON.stringify(owner));
        });
        const { root: targetRoot } = yield* materializer.clone({
          harness: "claudeAgent",
          providerSessionId: "scoped-session",
          sourceNativeStateId: source,
          targetNativeStateId: target,
        });
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(Path.join(targetRoot, "claude", "project", "scoped-session.jsonl"), "utf8"),
          ),
          text,
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(
              Path.join(targetRoot, "claude", "tasks", "scoped-session", "task.json"),
              "utf8",
            ),
          ),
          "active task",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(Path.join(root, "project", "scoped-session.jsonl"), "utf8"),
          ),
          "stale original account",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(Path.join(scopedRoot, "project", "scoped-session.jsonl"), "utf8"),
          ),
          text,
        );
        assert.strictEqual(
          yield* Effect.promise(() => readFile(Path.join(root, "account.json"), "utf8")),
          JSON.stringify(owner),
        );
        assert.isFalse(
          yield* Effect.promise(() =>
            access(Path.join(targetRoot, "claude", "account.json")).then(
              () => true,
              () => false,
            ),
          ),
        );
      }),
  );

  for (const missing of ["folder", "session"] as const) {
    it.effect(
      `requests a fresh reconstructed Claude continuation when the ${missing} is missing`,
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const materializer = yield* ProviderNativeStateMaterializer;
          const source = `missing-${missing}-source`;
          if (missing === "session")
            yield* Effect.promise(() =>
              mkdir(providerNativeStateRoot(config.stateDir, source), { recursive: true }),
            );
          const target = yield* materializer.clone({
            harness: "claudeAgent",
            providerSessionId: "missing-session",
            sourceNativeStateId: source,
            targetNativeStateId: `missing-${missing}-target`,
          });
          assert.strictEqual(target.providerSessionId, null);
          assert.strictEqual(
            yield* Effect.promise(() => access(target.root).then(() => true)),
            true,
          );
          assert.strictEqual(
            yield* Effect.promise(() =>
              access(Path.join(target.root, "claude-session.json")).then(
                () => true,
                () => false,
              ),
            ),
            false,
          );
        }),
    );
  }

  it.effect("starts fresh when an existing Codex folder has no conversation", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const materializer = yield* ProviderNativeStateMaterializer;
      const source = "empty-codex-source";
      yield* Effect.promise(() =>
        mkdir(providerNativeStateRoot(config.stateDir, source), { recursive: true }),
      );
      const copied = yield* materializer.clone({
        harness: "codex",
        providerSessionId: "missing-session",
        sourceNativeStateId: source,
        targetNativeStateId: "empty-codex-target",
      });
      assert.strictEqual(copied.providerSessionId, null);
      yield* Effect.promise(() => access(copied.root));
      yield* Effect.promise(() => access(providerNativeStateRoot(config.stateDir, source)));
    }),
  );
});
