import { assert, it } from "@effect/vitest";
import { ThreadId } from "@penkra/contracts";
import { Effect, Exit, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { createThread } from "../../cleanCore/threadStore.ts";
import { makeThreadReads } from "../../cleanCore/ThreadReads.ts";
import migrate from "./203_CanonicalUserItemData.ts";

it.effect("converts the null sender that broke mentioned-thread reads without losing PNGs", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 202 });
    yield* seedThreadFolderFixture("folder", "space");
    const at = "2026-10-13T13:24:05.178Z";
    yield* createThread({
      id: "strategy",
      folderId: "folder",
      spaceId: "space",
      title: "Strategy",
      provider: "claudeAgent",
      model: "model",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: at,
    });
    const sql = yield* SqlClient.SqlClient;
    const png = {
      type: "image" as const,
      id: "att_v2_png",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 2688,
    };
    const legacy = JSON.stringify({ senderThreadId: null, attachments: [png] });
    yield* sql`INSERT INTO thread_items (thread_id,seq,source_id,kind,status,text,data,created_at,updated_at)
      VALUES ('strategy',1,'historical-user','user','sent','Question',${legacy},${at},${at})`;
    const before = yield* makeThreadReads;
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(before.getThreadDetailById(ThreadId.makeUnsafe("strategy"))),
      ),
    );
    yield* migrate;
    const reads = yield* makeThreadReads;
    const result = yield* reads.getThreadDetailById(ThreadId.makeUnsafe("strategy"));
    assert.isTrue(Option.isSome(result));
    if (Option.isNone(result)) throw new Error("Missing Strategy");
    assert.deepStrictEqual(result.value.messages[0]!.origin, { _tag: "user" });
    assert.deepStrictEqual(result.value.messages[0]!.attachments, [png]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
