// Space lifecycle invariants exercised through the canonical write path.
import { assert, it } from "@effect/vitest";
import { FolderId, SpaceId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient";
import { runMigrations } from "../persistence/Migrations";
import { ensureDefaultSpaces, getNavigation, updateNavigation } from "../cleanCore/navigation";
import { ThreadPublisher } from "../cleanCore/ThreadPublisher";
import { createThread, makeThreadPublisher } from "../cleanCore/threadStore";
const at = "2026-10-12T00:00:00.000Z";
const personal = SpaceId.makeUnsafe("penkra-personal");
const work = SpaceId.makeUnsafe("penkra-work");
const extra = SpaceId.makeUnsafe("extra");
const folder = FolderId.makeUnsafe("ideas");
const write = updateNavigation;
const createSpace = (spaceId: SpaceId, name: string) =>
  write({ update: { action: "space.create", spaceId, name, icon: "home", createdAt: at } });
const createFolder = (folderId: FolderId, spaceId: SpaceId, title: string) =>
  write({
    update: {
      action: "folder.create",
      folderId,
      spaceId,
      title,
      workspaceRoot: null,
      createdAt: at,
    },
  });
const withDb = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient | ThreadPublisher>) =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* ensureDefaultSpaces;
    return yield* program;
  }).pipe(
    Effect.provideService(ThreadPublisher, makeThreadPublisher()),
    Effect.provide(NodeSqliteClient.layerMemory()),
  );
it.effect("requires every ordinary folder to be born in a persisted Space", () =>
  withDb(
    Effect.gen(function* () {
      yield* createFolder(folder, personal, "Ideas");
      assert.deepInclude(
        (yield* getNavigation).folders.find((row) => row.id === folder),
        { id: folder, spaceId: personal, workspaceRoot: null },
      );
    }),
  ),
);
it.effect("rejects dangling Space ids instead of degrading them", () =>
  withDb(
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createFolder(folder, SpaceId.makeUnsafe("missing"), "Ideas"),
      );
      assert.include(error.message, "not available");
    }),
  ),
);
it.effect("requires case-insensitively unique folder names within a Space", () =>
  withDb(
    Effect.gen(function* () {
      yield* createFolder(folder, personal, "Product");
      const error = yield* Effect.flip(
        createFolder(FolderId.makeUnsafe("second"), personal, " product "),
      );
      assert.include(error.message, "already exists in this Space");
    }),
  ),
);
it.effect("archives a non-empty Space while preserving its content assignments", () =>
  withDb(
    Effect.gen(function* () {
      yield* createFolder(folder, personal, "Ideas");
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT * FROM projection_folders WHERE space_id=${personal}`;
      yield* write({ update: { action: "space.archive", spaceId: personal } });
      assert.isFalse((yield* getNavigation).spaces.some((row) => row.id === personal));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM projection_folders WHERE space_id=${personal}`,
        before,
      );
    }),
  ),
);
it.effect("blocks delete while a Space owns live content", () =>
  withDb(
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        write({ update: { action: "space.delete", spaceId: personal } }),
      );
      assert.include(error.message, "Move every folder");
    }),
  ),
);
it.effect("allows deleting an empty Space without changing assignments", () =>
  withDb(
    Effect.gen(function* () {
      yield* createSpace(extra, "Extra");
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT * FROM projection_folders`;
      yield* write({ update: { action: "space.delete", spaceId: extra } });
      assert.isFalse((yield* getNavigation).spaces.some((row) => row.id === extra));
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_folders`, before);
    }),
  ),
);
it.effect("keeps at least one active Space", () =>
  withDb(
    Effect.gen(function* () {
      yield* write({ update: { action: "space.archive", spaceId: work } });
      const error = yield* Effect.flip(
        write({ update: { action: "space.archive", spaceId: personal } }),
      );
      assert.include(error.message, "At least one active Space");
    }),
  ),
);
it.effect("allows reuse of an archived name but requires a rename on restore", () =>
  withDb(
    Effect.gen(function* () {
      yield* write({ update: { action: "space.archive", spaceId: work } });
      yield* createSpace(extra, "Work");
      const error = yield* Effect.flip(
        write({ update: { action: "space.restore", spaceId: work } }),
      );
      assert.include(error.message, "already exists");
      yield* write({ update: { action: "space.restore", spaceId: work, name: "Other work" } });
      assert.equal(
        (yield* getNavigation).spaces.find((row) => row.id === work)?.name,
        "Other work",
      );
    }),
  ),
);
it.effect("moves folders atomically between real Spaces", () =>
  withDb(
    Effect.gen(function* () {
      yield* createFolder(folder, personal, "Ideas");
      const duplicate = FolderId.makeUnsafe("duplicate");
      yield* createFolder(duplicate, work, "Ideas");
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT * FROM projection_folders`;
      const error = yield* Effect.flip(
        write({
          update: {
            action: "folder.move",
            folderIds: [FolderId.makeUnsafe("penkra-personal-default"), folder],
            spaceId: work,
          },
        }),
      );
      assert.include(error.message, "already exists");
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_folders`, before);
      yield* write({ update: { action: "folder.delete", folderId: duplicate } });
      yield* write({ update: { action: "folder.move", folderIds: [folder], spaceId: work } });
      assert.equal((yield* getNavigation).folders.find((row) => row.id === folder)?.spaceId, work);
    }),
  ),
);
it.effect("archives and restores a folder without changing its threads", () =>
  withDb(
    Effect.gen(function* () {
      yield* createFolder(folder, personal, "Ideas");
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
        createdAt: at,
      });
      const before = yield* sql`SELECT * FROM threads`;
      yield* write({ update: { action: "folder.update", folderId: folder, archivedAt: at } });
      assert.isFalse((yield* getNavigation).folders.some((row) => row.id === folder));
      yield* write({ update: { action: "folder.update", folderId: folder, archivedAt: null } });
      assert.isTrue((yield* getNavigation).folders.some((row) => row.id === folder));
      assert.deepStrictEqual(yield* sql`SELECT * FROM threads`, before);
    }),
  ),
);
