import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionFolderRepositoryLive } from "./ProjectionFolders.ts";
import { createThread, setThreadDeleted } from "../../cleanCore/threadStore.ts";
import { getThread } from "../../cleanCore/threadList.ts";
import { ProjectionFolderRepository } from "../Services/ProjectionFolders.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionFolderRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const folders = yield* ProjectionFolderRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* folders.upsert({
        folderId: FolderId.makeUnsafe("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        spaceId: SpaceId.makeUnsafe("penkra-personal"),
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_folders
        WHERE folder_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new Error("Expected projection_folders row to exist."));
      }

      assert.strictEqual(
        row.defaultModelSelection,
        JSON.stringify({
          provider: "codex",
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* folders.getById({
        folderId: FolderId.makeUnsafe("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        provider: "codex",
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores canonical thread model options without adding defaults", () =>
    Effect.gen(function* () {
      yield* seedThreadFolderFixture("folder", "space");
      yield* createThread({
        id: "thread-null-options",
        spaceId: "space",
        folderId: "folder",
        title: "Thread",
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        modelOptions: null,
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-03-24T00:00:00.000Z",
      });
      const row = yield* getThread(ThreadId.makeUnsafe("thread-null-options"));
      assert.equal(row.model, "claude-opus-4-6");
      assert.equal(row.modelOptions, null);
    }),
  );
});
