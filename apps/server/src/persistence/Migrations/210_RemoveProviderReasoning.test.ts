import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { createThread } from "../../cleanCore/threadStore.ts";

it.effect(
  "removes reasoning and Codex rs_ notices without deleting conversation or other notices",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 209 });
      const sql = yield* SqlClient.SqlClient;
      yield* seedThreadFolderFixture("reasoning-folder", "space");
      const at = "2026-10-18T00:00:00.000Z";
      for (const provider of ["codex", "claudeAgent", "opencode"]) {
        yield* createThread({
          id: provider,
          spaceId: "space",
          folderId: "reasoning-folder",
          title: provider,
          provider,
          model: "model",
          runtimeMode: "full-access",
          createdBy: "user",
          createdAt: at,
        });
        for (const [seq, id, kind] of [
          [1, "trace", "reasoning"],
          [2, "rs_notice", "notice"],
          [3, "rsXnotice", "notice"],
          [4, "rs_text", "text"],
          [5, "user", "user"],
        ] as const)
          yield* sql`INSERT INTO thread_items(thread_id,seq,source_id,kind,status,text,created_at,updated_at)
          VALUES (${provider},${seq},${id},${kind},'done','Preserve conversation',${at},${at})`;
      }
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT source_id FROM thread_items WHERE thread_id='codex' ORDER BY seq`,
        [{ source_id: "rsXnotice" }, { source_id: "rs_text" }, { source_id: "user" }],
      );
      for (const provider of ["claudeAgent", "opencode"])
        assert.deepStrictEqual(
          yield* sql`SELECT source_id FROM thread_items WHERE thread_id=${provider} ORDER BY seq`,
          [
            { source_id: "rs_notice" },
            { source_id: "rsXnotice" },
            { source_id: "rs_text" },
            { source_id: "user" },
          ],
        );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
