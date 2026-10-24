import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { createThread } from "../../cleanCore/threadStore.ts";

it.effect("converts only null-data cutoff notices and preserves their identity and timing", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 210 });
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-10-18T00:00:00.000Z";
    yield* seedThreadFolderFixture("cutoff-folder", "space");
    for (const provider of ["codex", "claudeAgent", "opencode"] as const) {
      yield* createThread({
        id: provider,
        spaceId: "space",
        folderId: "cutoff-folder",
        title: provider,
        provider,
        model: "model",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: at,
      });
      yield* sql`INSERT INTO thread_items(thread_id,seq,source_id,kind,status,text,data,created_at,updated_at)
        VALUES (${provider},1,'provider-cutoff:old','notice','done','Old cutoff',NULL,${at},${at}),
        (${provider},2,'provider-cutoff:modern','notice','done','Modern','{"keep":true}',${at},${at}),
        (${provider},3,'unrelated','notice','done','Unrelated',NULL,${at},${at})`;
    }
    const before =
      yield* sql`SELECT thread_id,seq,source_id,status,text,created_at,updated_at FROM thread_items ORDER BY thread_id,seq`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT thread_id,seq,source_id,status,text,created_at,updated_at FROM thread_items ORDER BY thread_id,seq`,
      before,
    );
    for (const [provider, label] of [
      ["codex", "ChatGPT"],
      ["claudeAgent", "Claude"],
      ["opencode", "OpenCode"],
    ] as const) {
      const [row] = yield* sql<{
        data: string;
      }>`SELECT data FROM thread_items WHERE thread_id=${provider} AND seq=1`;
      assert.deepStrictEqual(JSON.parse(row!.data), {
        tone: "info",
        kind: "provider-stopped",
        summary: `${label} stopped before finishing`,
        payload: {},
      });
      assert.deepStrictEqual(
        yield* sql`SELECT data FROM thread_items WHERE thread_id=${provider} AND seq>1 ORDER BY seq`,
        [{ data: '{"keep":true}' }, { data: null }],
      );
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
