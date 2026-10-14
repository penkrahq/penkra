import { seedHistoricalFolderFixture } from "./historicalFolderFixture.ts";
import { assert, it } from "@effect/vitest";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  claudeNativeProjectRoot,
  claudeThreadHasConversation,
  claudeThreadProjectName,
} from "../../provider/claudeThreadNativeState.ts";
import {
  providerNativeStateRoot,
  providerOpaquePathKey,
} from "../../provider/providerNativeStatePaths.ts";
import { withClaudeNativeStateBackfill } from "../ClaudeNativeStateBackfill.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";

const fixture = Effect.gen(function* () {
  const stateDir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(Path.join(tmpdir(), "penkra-claude-backfill-"))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`INSERT INTO projection_folders (folder_id, title, space_id, created_at, updated_at)
    VALUES ('folder', 'Folder', 'penkra-personal', '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z')`;
  yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, runtime_mode, native_state_id, state, created_by, created_at, updated_at)
    VALUES ('a', 'penkra-personal', 'folder', 'A', 'claudeAgent', 'sonnet', 'full-access', 'native-a', 'idle', 'user', '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z'),
      ('b', 'penkra-personal', 'folder', 'B', 'claudeAgent', 'sonnet', 'full-access', 'native-b', 'idle', 'user', '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z')`;
  const source = (id: string) =>
    Path.join(stateDir, "provider-thread-native-state", claudeThreadProjectName(id));
  yield* Effect.promise(async () => {
    await mkdir(Path.join(source("a"), "project"), { recursive: true });
    await writeFile(
      Path.join(source("a"), "project", "session.jsonl"),
      '{"type":"user","message":{"content":"keep"}}\n',
    );
  });
  return { stateDir, sql, source };
});

it.effect("moves a thread-owned Claude folder into its native-state folder with all files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stateDir, sql, source } = yield* fixture;
      const root = providerNativeStateRoot(stateDir, "native-a");
      yield* Effect.promise(async () => {
        await mkdir(root, { recursive: true });
        await writeFile(Path.join(root, "claude-session.json"), '{"providerSessionId":"session"}');
        await writeFile(
          Path.join(source("a"), "account.json"),
          '{"authenticationMethodId":"claude-account","providerIdentityId":"a@example.com"}',
        );
      });
      const before = yield* sql`SELECT * FROM threads ORDER BY id`;
      const result = yield* withClaudeNativeStateBackfill(stateDir, Effect.succeed("migration"));
      assert.deepStrictEqual(result, {
        migrations: "migration",
        movedFolders: 1,
        retained: { rows: 0, moved: 0, missing: 0, bytesFreed: 0 },
      });
      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(Path.join(root, "claude", "project", "session.jsonl"), "utf8"),
        ),
        '{"type":"user","message":{"content":"keep"}}\n',
      );
      assert.strictEqual(
        yield* Effect.promise(() => readFile(Path.join(root, "claude-session.json"), "utf8")),
        '{"providerSessionId":"session"}',
      );
      assert.isFalse(
        yield* Effect.promise(() =>
          access(source("a")).then(
            () => true,
            () => false,
          ),
        ),
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM threads ORDER BY id`, before);
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("removes an unknown folder and stray file while moving the known conversation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stateDir, source } = yield* fixture;
      const oldParent = Path.join(stateDir, "provider-thread-native-state");
      const orphan = Path.join(oldParent, "unknown-thread");
      const stray = Path.join(oldParent, ".DS_Store");
      yield* Effect.promise(async () => {
        await mkdir(orphan);
        await writeFile(Path.join(orphan, "session.jsonl"), "orphan");
        await writeFile(stray, "stray");
      });
      const result = yield* withClaudeNativeStateBackfill(stateDir, Effect.succeed("migration"));
      assert.strictEqual(result.migrations, "migration");
      assert.strictEqual(result.movedFolders, 1);
      for (const removed of [orphan, stray, source("a"), oldParent]) {
        assert.isFalse(
          yield* Effect.promise(() =>
            access(removed).then(
              () => true,
              () => false,
            ),
          ),
        );
      }
      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(
            Path.join(
              providerNativeStateRoot(stateDir, "native-a"),
              "claude",
              "project",
              "session.jsonl",
            ),
            "utf8",
          ),
        ),
        '{"type":"user","message":{"content":"keep"}}\n',
      );
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("a failed move rolls back SQL and restores a folder already moved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stateDir, sql, source } = yield* fixture;
      const occupied = Path.join(providerNativeStateRoot(stateDir, "native-b"), "claude");
      yield* Effect.promise(async () => {
        await mkdir(Path.join(source("b"), "project"), { recursive: true });
        await writeFile(Path.join(source("b"), "project", "session-b.jsonl"), "second");
        await mkdir(Path.dirname(occupied), { recursive: true });
        await writeFile(occupied, "occupied");
      });
      const before = yield* sql`SELECT * FROM threads ORDER BY id`;
      const failed = yield* Effect.exit(
        withClaudeNativeStateBackfill(
          stateDir,
          sql`UPDATE threads SET title = 'changed' WHERE id = 'a'`,
        ),
      );
      assert.strictEqual(failed._tag, "Failure");
      assert.include(String(failed), source("b"));
      assert.include(String(failed), occupied);
      assert.deepStrictEqual(yield* sql`SELECT * FROM threads ORDER BY id`, before);
      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(Path.join(source("a"), "project", "session.jsonl"), "utf8"),
        ),
        '{"type":"user","message":{"content":"keep"}}\n',
      );
      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(Path.join(source("b"), "project", "session-b.jsonl"), "utf8"),
        ),
        "second",
      );
      assert.strictEqual(yield* Effect.promise(() => readFile(occupied, "utf8")), "occupied");
      assert.isFalse(
        yield* Effect.promise(() =>
          access(providerNativeStateRoot(stateDir, "native-a")).then(
            () => true,
            () => false,
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "the real 175-to-latest migration moves the active account-scoped conversation once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stateDir = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(Path.join(tmpdir(), "penkra-claude-real-success-"))),
          (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 175 });
        yield* seedHistoricalFolderFixture({
          folderId: "folder",
          title: "Folder",
          spaceId: "penkra-personal",
          createdAt: "2026-10-11T00:00:00Z",
        });
        yield* sql`INSERT INTO projection_threads (thread_id, folder_id, title, model_selection_json, created_at, updated_at)
      VALUES ('a', 'folder', 'A', '{"provider":"claudeAgent","model":"sonnet"}', '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z')`;
        yield* sql`INSERT INTO provider_native_state_generations (native_state_generation_id, owner_thread_id, harness_kind, adapter_schema_version, state_manifest_json, lifecycle, created_at)
      VALUES ('native-a', 'a', 'claudeAgent', 'managed-native-state-v1', '{}', 'active', '2026-10-11T00:00:00Z')`;
        const oldParent = Path.join(stateDir, "provider-thread-native-state");
        const oldRoot = Path.join(oldParent, claudeThreadProjectName("a"));
        const scopedPath = Path.join(
          "accounts",
          providerOpaquePathKey("claude-account:a@example.com"),
          "revision-8",
        );
        const account = JSON.stringify({
          authenticationMethodId: "claude-account",
          providerIdentityId: "a@example.com",
          projectRevision: 8,
        });
        const text = '{"type":"user","message":{"content":"active conversation"}}\n';
        yield* Effect.promise(async () => {
          await mkdir(Path.join(oldRoot, scopedPath, "project"), { recursive: true });
          await mkdir(Path.join(oldRoot, "project"), { recursive: true });
          await writeFile(Path.join(oldRoot, "account.json"), account);
          await writeFile(Path.join(oldRoot, scopedPath, "project", "session.jsonl"), text);
          await writeFile(Path.join(oldRoot, "project", "session.jsonl"), "stale conversation");
        });
        const first = yield* withClaudeNativeStateBackfill(stateDir, runMigrations());
        assert.strictEqual(first.movedFolders, 1);
        assert.deepStrictEqual(yield* sql`SELECT id, native_state_id FROM threads`, [
          { id: "a", native_state_id: "native-a" },
        ]);
        const nativeRoot = providerNativeStateRoot(stateDir, "native-a");
        const activeRoot = yield* Effect.promise(() => claudeNativeProjectRoot(nativeRoot));
        assert.strictEqual(activeRoot, Path.join(nativeRoot, "claude", scopedPath));
        assert.isTrue(
          yield* Effect.promise(() => claudeThreadHasConversation(stateDir, "native-a", "session")),
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(Path.join(activeRoot, "project", "session.jsonl"), "utf8"),
          ),
          text,
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(Path.join(nativeRoot, "claude", "account.json"), "utf8"),
          ),
          account,
        );
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
        const tracker = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const second = yield* withClaudeNativeStateBackfill(stateDir, runMigrations());
        assert.strictEqual(second.movedFolders, 0);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          tracker,
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(Path.join(activeRoot, "project", "session.jsonl"), "utf8"),
          ),
          text,
        );
        assert.isFalse(
          yield* Effect.promise(() =>
            access(oldParent).then(
              () => true,
              () => false,
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "a move failure rolls the real 175-to-latest migration back to the original schema and tracker",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stateDir = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(Path.join(tmpdir(), "penkra-claude-real-migration-"))),
          (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 175 });
        yield* seedHistoricalFolderFixture({
          folderId: "folder",
          title: "Folder",
          spaceId: "penkra-personal",
          createdAt: "2026-10-11T00:00:00Z",
        });
        for (const id of ["a", "b"]) {
          yield* sql`INSERT INTO projection_threads (thread_id, folder_id, title, model_selection_json, created_at, updated_at)
        VALUES (${id}, 'folder', ${id}, '{"provider":"claudeAgent","model":"sonnet"}', '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z')`;
          yield* sql`INSERT INTO provider_native_state_generations (native_state_generation_id, owner_thread_id, harness_kind, adapter_schema_version, state_manifest_json, lifecycle, created_at)
        VALUES (${`native-${id}`}, ${id}, 'claudeAgent', 'managed-native-state-v1', '{}', 'active', '2026-10-11T00:00:00Z')`;
        }
        const oldParent = Path.join(stateDir, "provider-thread-native-state");
        const occupied = Path.join(providerNativeStateRoot(stateDir, "native-b"), "claude");
        yield* Effect.promise(async () => {
          for (const id of ["a", "b"]) {
            const source = Path.join(oldParent, claudeThreadProjectName(id), "project");
            await mkdir(source, { recursive: true });
            await writeFile(Path.join(source, "session.jsonl"), `conversation-${id}`);
          }
          await mkdir(Path.dirname(occupied), { recursive: true });
          await writeFile(occupied, "occupied target");
        });
        const before = yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`;
        const tracker = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const failed = yield* Effect.exit(withClaudeNativeStateBackfill(stateDir, runMigrations()));
        assert.strictEqual(failed._tag, "Failure");
        assert.include(String(failed), occupied);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`,
          before,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          tracker,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'threads'`,
          [],
        );
        for (const id of ["a", "b"]) {
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(
                Path.join(oldParent, claudeThreadProjectName(id), "project", "session.jsonl"),
                "utf8",
              ),
            ),
            `conversation-${id}`,
          );
        }
        assert.strictEqual(
          yield* Effect.promise(() => readFile(occupied, "utf8")),
          "occupied target",
        );
      }),
    ).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
