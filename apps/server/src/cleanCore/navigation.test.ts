import { assert, it } from "@effect/vitest";
import { FolderId, SpaceId, type CleanCoreNavigationUpdate } from "@penkra/contracts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient";
import { runMigrations } from "../persistence/Migrations";
import { ThreadPublisher } from "./ThreadPublisher";
import { createThread, makeThreadPublisher } from "./threadStore";
import { ensureDefaultSpaces, getNavigation, updateNavigation } from "./navigation";
const timestamp = "2026-10-12T00:00:00.000Z";
const personal = SpaceId.makeUnsafe("penkra-personal");
const work = SpaceId.makeUnsafe("penkra-work");
const folder = FolderId.makeUnsafe("test-folder");
const extra = SpaceId.makeUnsafe("test-space");
const withDb = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient | ThreadPublisher>) =>
  program.pipe(
    Effect.provideService(ThreadPublisher, makeThreadPublisher()),
    Effect.provide(NodeSqliteClient.layerMemory()),
  );
it.effect("creates first-run defaults once in canonical tables", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* ensureDefaultSpaces;
      yield* ensureDefaultSpaces;
      const nav = yield* getNavigation;
      assert.deepStrictEqual(
        nav.spaces.map((row) => [row.id, row.name, row.icon]),
        [
          [personal, "Personal", "home"],
          [work, "Work", "bag"],
        ],
      );
      assert.deepStrictEqual(
        nav.folders.map((row) => [row.id, row.title, row.spaceId, row.workspaceRoot]),
        [
          ["penkra-personal-default", "Default", personal, null],
          ["penkra-work-default", "Default", work, null],
        ],
      );
    }),
  ),
);
it.effect("does not recreate deleted defaults on restart", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* ensureDefaultSpaces;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_folders SET deleted_at=${timestamp}`;
      yield* sql`UPDATE projection_spaces SET deleted_at=${timestamp}`;
      yield* ensureDefaultSpaces;
      assert.deepStrictEqual(yield* getNavigation, { spaces: [], folders: [] });
      const [count] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM projection_spaces`;
      assert.equal(count!.count, 2);
    }),
  ),
);
const updates: CleanCoreNavigationUpdate[] = [
  { action: "space.create", spaceId: extra, name: "Extra", icon: "home", createdAt: timestamp },
  { action: "space.update", spaceId: extra, name: "Renamed" },
  { action: "space.archive", spaceId: extra },
  { action: "space.restore", spaceId: extra },
  { action: "space.delete", spaceId: extra },
  {
    action: "folder.create",
    folderId: folder,
    spaceId: personal,
    title: "Other",
    workspaceRoot: null,
    createdAt: timestamp,
  },
  { action: "folder.update", folderId: folder, title: "Changed", workspaceRoot: "/new" },
  { action: "folder.move", folderIds: [folder], spaceId: work },
  { action: "folder.delete", folderId: folder },
];
for (const update of updates)
  it.effect(`commits ${update.action} and emits one bare change`, () =>
    withDb(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* ensureDefaultSpaces;
        const publisher = yield* ThreadPublisher;
        const changes: unknown[] = [];
        publisher.subscribeSidebar((change) => changes.push(change));
        if (update.action.startsWith("space.") && update.action !== "space.create") {
          yield* updateNavigation({ update: updates[0]! });
          if (update.action === "space.restore") yield* updateNavigation({ update: updates[2]! });
        }
        if (update.action.startsWith("folder.") && update.action !== "folder.create")
          yield* updateNavigation({ update: updates[5]! });
        changes.length = 0;
        const result = yield* updateNavigation({ update });
        assert.deepStrictEqual(result, yield* getNavigation);
        assert.deepStrictEqual(changes, [{ kind: "navigation" }]);
        if (update.action === "space.create")
          assert.equal(result.spaces.find((row) => row.id === extra)?.name, "Extra");
        if (update.action === "space.update")
          assert.equal(result.spaces.find((row) => row.id === extra)?.name, "Renamed");
        if (update.action === "space.archive" || update.action === "space.delete")
          assert.equal(
            result.spaces.some((row) => row.id === extra),
            false,
          );
        if (update.action === "space.restore")
          assert.equal(
            result.spaces.some((row) => row.id === extra),
            true,
          );
        if (update.action === "folder.create")
          assert.equal(result.folders.find((row) => row.id === folder)?.title, "Other");
        if (update.action === "folder.update")
          assert.equal(result.folders.find((row) => row.id === folder)?.workspaceRoot, "/new");
        if (update.action === "folder.move")
          assert.equal(result.folders.find((row) => row.id === folder)?.spaceId, work);
        if (update.action === "folder.delete")
          assert.equal(
            result.folders.some((row) => row.id === folder),
            false,
          );
      }),
    ),
  );

it.effect("allows folders to share a directory", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* ensureDefaultSpaces;
      for (const id of ["first", "second"])
        yield* updateNavigation({
          update: {
            action: "folder.create",
            folderId: FolderId.makeUnsafe(id),
            spaceId: personal,
            title: id,
            workspaceRoot: "/same",
            createdAt: timestamp,
          },
        });
      assert.deepStrictEqual(
        (yield* getNavigation).folders
          .filter((row) => row.workspaceRoot === "/same")
          .map((row) => row.id),
        ["first", "second"],
      );
    }),
  ),
);
it.effect("allows a folder directory already used by a folder with saved chats", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* ensureDefaultSpaces;
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId: folder,
          spaceId: personal,
          title: "First",
          workspaceRoot: "/same",
          createdAt: timestamp,
        },
      });
      const sql = yield* SqlClient.SqlClient;
      yield* createThread({
        id: "chat",
        spaceId: personal,
        folderId: folder,
        title: "Chat",
        provider: "codex",
        model: "model",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: timestamp,
      });
      yield* updateNavigation({
        update: {
          action: "folder.create",
          folderId: FolderId.makeUnsafe("second"),
          spaceId: personal,
          title: "Second",
          workspaceRoot: "/same",
          createdAt: timestamp,
        },
      });
      assert.equal(
        (yield* getNavigation).folders.filter((row) => row.workspaceRoot === "/same").length,
        2,
      );
    }),
  ),
);

it.effect("deleted defaults stay deleted after the database is closed and reopened", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "penkra-nav-restart-"))),
    (dir) =>
      Effect.gen(function* () {
        const filename = path.join(dir, "state.sqlite");
        yield* Effect.gen(function* () {
          yield* runMigrations();
          yield* ensureDefaultSpaces;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE projection_folders SET deleted_at=${timestamp}`;
          yield* sql`UPDATE projection_spaces SET deleted_at=${timestamp}`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
        yield* Effect.gen(function* () {
          yield* runMigrations();
          yield* ensureDefaultSpaces;
          assert.deepStrictEqual(yield* getNavigation, { spaces: [], folders: [] });
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM projection_spaces`;
          assert.equal(row!.count, 2);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      }),
    (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
  ),
);

it.effect("requires project to have no remaining threads before delete", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* ensureDefaultSpaces;
      yield* updateNavigation({ update: updates[5]! });
      yield* createThread({
        id: "chat",
        spaceId: personal,
        folderId: folder,
        title: "Chat",
        provider: "codex",
        model: "model",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: timestamp,
      });
      const error = yield* Effect.flip(
        updateNavigation({ update: { action: "folder.delete", folderId: folder } }),
      );
      assert.include(error.message, "still has 1 threads");
      assert.isTrue((yield* getNavigation).folders.some((row) => row.id === folder));
    }),
  ),
);

it.effect("folders persist updated metadata from folder.update", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* ensureDefaultSpaces;
      yield* updateNavigation({ update: updates[5]! });
      const selection = {
        provider: "codex",
        model: "gpt-5",
        options: { reasoningEffort: "medium" },
      } as const;
      const iconDataUrl = "data:image/webp;base64,Y3VzdG9t";
      yield* updateNavigation({
        update: {
          action: "folder.update",
          folderId: folder,
          iconDataUrl,
          defaultModelSelection: selection,
        },
      });
      const row = (yield* getNavigation).folders.find((row) => row.id === folder);
      assert.deepStrictEqual(row?.defaultModelSelection, selection);
      assert.equal(row?.iconDataUrl, iconDataUrl);
    }),
  ),
);

it.effect("does not recreate archived defaults on restart", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* ensureDefaultSpaces;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_folders SET archived_at=${timestamp}`;
      yield* sql`UPDATE projection_spaces SET archived_at=${timestamp}`;
      yield* ensureDefaultSpaces;
      assert.deepStrictEqual(yield* getNavigation, { spaces: [], folders: [] });
      const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM projection_spaces`;
      assert.equal(row!.count, 2);
    }),
  ),
);

it.effect("moving a folder moves its saved chats and publishes each change after commit", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* ensureDefaultSpaces;
      yield* updateNavigation({ update: updates[5]! });
      for (const id of ["folder-move-chat", "folder-move-sibling"])
        yield* createThread({
          id,
          spaceId: personal,
          folderId: folder,
          title: "Saved chat",
          provider: "codex",
          model: "gpt-5",
          runtimeMode: "full-access",
          createdBy: "user",
          createdAt: timestamp,
        });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET archived_at=${timestamp} WHERE id='folder-move-sibling'`;
      const publisher = yield* ThreadPublisher;
      const changes: unknown[] = [];
      publisher.subscribeSidebar((change) => changes.push(change));
      yield* updateNavigation({ update: updates[7]! });
      const rows = yield* sql<{
        spaceId: string;
        archivedAt: string | null;
      }>`SELECT space_id AS "spaceId", archived_at AS "archivedAt" FROM threads ORDER BY id`;
      assert.deepStrictEqual(rows, [
        { spaceId: work, archivedAt: null },
        { spaceId: work, archivedAt: timestamp },
      ]);
      assert.deepStrictEqual(changes, [
        { kind: "navigation" },
        { kind: "thread", threadId: "folder-move-chat" },
        { kind: "thread", threadId: "folder-move-sibling" },
      ]);
    }),
  ),
);

it.effect("positioned navigation moves reorder folders and spaces", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* ensureDefaultSpaces;
      yield* updateNavigation({ update: updates[5]! });
      const result = yield* updateNavigation({
        update: {
          action: "folder.move",
          folderId: folder,
          spaceId: personal,
          position: { type: "before", itemId: "penkra-personal-default" },
        },
      });
      assert.deepStrictEqual(
        result.folders.filter((row) => row.spaceId === personal).map((row) => row.id),
        [folder, "penkra-personal-default"],
      );
      const reordered = yield* updateNavigation({
        update: {
          action: "space.move",
          spaceId: work,
          position: { type: "before", itemId: personal },
        },
      });
      assert.deepStrictEqual(
        reordered.spaces.map((row) => row.id),
        [work, personal],
      );
    }),
  ),
);
