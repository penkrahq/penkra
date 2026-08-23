import { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./persistence/Migrations.ts";
import * as NodeSqliteClient from "./persistence/NodeSqliteClient.ts";
import { getSpaceNavigationState, updateSpaceNavigationState } from "./spaceNavigationState.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("spaceNavigationState", (it) => {
  it.effect("round-trips the selected Space and remembered contexts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const initial = yield* getSpaceNavigationState(sql);
      assert.strictEqual(initial.activeSpaceId, SpaceId.makeUnsafe("penkra-personal"));
      assert.deepStrictEqual(initial.lastThreadIdBySpace, {});
      assert.deepStrictEqual(initial.lastFolderIdBySpace, {});
      assert.isNotNull(initial.updatedAt);

      const spaceId = SpaceId.makeUnsafe("space-personal");
      const threadId = ThreadId.makeUnsafe("thread-main");
      const folderId = FolderId.makeUnsafe("folder-main");
      const updated = yield* updateSpaceNavigationState(sql, {
        activeSpaceId: spaceId,
        lastThreadIdBySpace: { [spaceId]: threadId },
        lastFolderIdBySpace: { [spaceId]: folderId },
      });

      assert.strictEqual(updated.activeSpaceId, spaceId);
      assert.strictEqual(
        (updated.lastThreadIdBySpace as Record<string, typeof threadId>)[spaceId],
        threadId,
      );
      assert.strictEqual(
        (updated.lastFolderIdBySpace as Record<string, typeof folderId>)[spaceId],
        folderId,
      );
      assert.isNotNull(updated.updatedAt);
    }),
  );
});
