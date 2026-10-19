import { assert, it } from "@effect/vitest";
import { CleanCoreGetBootstrapResult, SpaceId } from "@penkra/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient";
import { runMigrations } from "../persistence/Migrations";
import { getBootstrap } from "./bootstrap";
import { seedThreadFolderFixture } from "./threadFixtures";
import { createThread } from "./threadStore";

it.effect("startup reads navigation and running threads as one canonical snapshot", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-10-19T00:00:00.000Z";
    yield* sql`INSERT INTO projection_spaces (space_id,name,icon,sort_order,created_at,updated_at)
      VALUES ('startup-space','Work','bag',0,${at},${at})`;
    yield* seedThreadFolderFixture("startup-folder", "startup-space");
    for (const id of ["working", "idle"]) {
      yield* createThread({
        id,
        spaceId: SpaceId.makeUnsafe("startup-space"),
        folderId: "startup-folder",
        title: id,
        provider: "codex",
        model: "model",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: at,
      });
    }
    yield* sql`UPDATE threads SET state='running' WHERE id='working'`;
    const snapshot = yield* getBootstrap;
    assert.isTrue(Schema.is(CleanCoreGetBootstrapResult)(snapshot));
    assert.deepStrictEqual(
      snapshot.navigation.spaces.map((row) => row.id),
      ["startup-space"],
    );
    assert.deepStrictEqual(
      snapshot.navigation.folders.map((row) => row.id),
      ["startup-folder"],
    );
    assert.deepStrictEqual(
      snapshot.runningThreads.map((row) => row.id),
      ["working"],
    );
    // A later reconnect gets current navigation from the same operation, not a second request.
    yield* sql`UPDATE projection_folders SET title='Renamed' WHERE folder_id='startup-folder'`;
    assert.equal((yield* getBootstrap).navigation.folders[0]?.title, "Renamed");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
