import { FolderId, SpaceId, ThreadId, TurnId, singletonThreadDeckId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionFolderRepositoryLive } from "./ProjectionFolders.ts";
import { createThread, setThreadDeleted } from "../../cleanCore/threadStore.ts";
import { getThread } from "../../cleanCore/threadList.ts";
import { ProjectionStateRepositoryLive } from "./ProjectionState.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";
import { ProjectionFolderRepository } from "../Services/ProjectionFolders.ts";
import { ProjectionStateRepository } from "../Services/ProjectionState.ts";
import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionFolderRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionStateRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
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
        scripts: [],
        isPinned: false,
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

  it.effect("keeps projection cursors monotonic during concurrent catch-up", () =>
    Effect.gen(function* () {
      const states = yield* ProjectionStateRepository;

      yield* states.upsert({
        projector: "projection.hot",
        lastAppliedSequence: 20,
        updatedAt: "2026-07-09T00:00:20.000Z",
      });
      yield* states.upsert({
        projector: "projection.hot",
        lastAppliedSequence: 10,
        updatedAt: "2026-07-09T00:00:10.000Z",
      });

      const persisted = yield* states.getByProjector({
        projector: "projection.hot",
      });
      assert.deepStrictEqual(Option.getOrNull(persisted), {
        projector: "projection.hot",
        lastAppliedSequence: 20,
        updatedAt: "2026-07-09T00:00:20.000Z",
      });
    }),
  );

  it.effect("batches pinned turn state with current thread existence", () =>
    Effect.gen(function* () {
      const turns = yield* ProjectionTurnRepository;
      const now = "2026-07-19T00:00:00.000Z";
      for (const id of ["thread-wait-active", "thread-wait-deleted"]) {
        yield* createThread({
          id,
          spaceId: "space",
          folderId: "project-wait-snapshot",
          title: id,
          provider: "codex",
          model: "gpt-5.5",
          runtimeMode: "approval-required",
          createdBy: "user",
          createdAt: now,
        });
      }
      yield* setThreadDeleted("thread-wait-deleted", now, now);
      yield* turns.upsertByTurnId({
        threadId: ThreadId.makeUnsafe("thread-wait-active"),
        turnId: TurnId.makeUnsafe("turn-wait-active"),
        providerTurnId: null,
        pendingMessageId: null,
        assistantMessageId: null,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
      });
      yield* turns.upsertByTurnId({
        threadId: ThreadId.makeUnsafe("thread-wait-deleted"),
        turnId: TurnId.makeUnsafe("turn-wait-deleted"),
        providerTurnId: null,
        pendingMessageId: null,
        assistantMessageId: null,
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
      });

      const snapshot = yield* turns.getManyWaitSnapshot({
        threadIds: [
          ThreadId.makeUnsafe("thread-wait-active"),
          ThreadId.makeUnsafe("thread-wait-deleted"),
          ThreadId.makeUnsafe("thread-wait-missing"),
        ],
        turns: [
          {
            threadId: ThreadId.makeUnsafe("thread-wait-active"),
            turnId: TurnId.makeUnsafe("turn-wait-active"),
          },
          {
            threadId: ThreadId.makeUnsafe("thread-wait-deleted"),
            turnId: TurnId.makeUnsafe("turn-wait-deleted"),
          },
        ],
      });
      assert.deepStrictEqual(snapshot.existingThreadIds, [
        ThreadId.makeUnsafe("thread-wait-active"),
      ]);
      assert.deepStrictEqual(snapshot.turns, [
        {
          threadId: ThreadId.makeUnsafe("thread-wait-active"),
          turnId: TurnId.makeUnsafe("turn-wait-active"),
          assistantMessageId: null,
          state: "running",
        },
      ]);
    }),
  );
});
