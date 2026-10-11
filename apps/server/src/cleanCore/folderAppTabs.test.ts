import { assert, it } from "@effect/vitest";
import { FolderId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { makeThreadPublisher } from "./threadStore.ts";
import { getFolderAppTabs, updateFolderAppTabs } from "./folderAppTabs.ts";

const folderId = FolderId.makeUnsafe("app-folder");
const updatedAt = "2026-10-11T00:00:00.000Z";
const pane = {
  id: "tab-x",
  kind: "app" as const,
  appId: "com.penkra.explorer",
  appSpaceId: "space-1",
  appSlug: "explorer",
  appName: "Explorer",
  appRoute: "/",
};
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  yield* seedThreadFolderFixture(folderId, "space-1");
});
const withDb = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient | ThreadPublisher>) =>
  program.pipe(
    Effect.provideService(ThreadPublisher, makeThreadPublisher()),
    Effect.provide(NodeSqliteClient.layerMemory()),
  );

it.effect(
  "opens, activates, updates, reorders and closes App tabs with one broadcast per write",
  () =>
    withDb(
      Effect.gen(function* () {
        yield* fixture;
        const publisher = yield* ThreadPublisher;
        const changes: unknown[] = [];
        const unsubscribe = publisher.subscribeSidebar((change) => changes.push(change));
        const write = (update: Parameters<typeof updateFolderAppTabs>[0]["update"]) =>
          updateFolderAppTabs({ folderId, updatedAt, update });
        assert.deepStrictEqual((yield* getFolderAppTabs({ folderId }))?.tabs, {
          open: false,
          panes: [],
          activePaneId: null,
        });
        yield* write({ action: "open", pane, preserveSelection: false });
        yield* write({ action: "open", pane: { ...pane, id: "tab-y" }, preserveSelection: false });
        const selected = yield* write({ action: "select", paneId: pane.id });
        assert.equal(selected.tabs.activePaneId, pane.id);
        const navigated = yield* write({
          action: "navigate",
          paneId: pane.id,
          appRoute: "/files/readme",
        });
        assert.equal(navigated.tabs.panes[0]?.appRoute, "/files/readme");
        const reordered = yield* write({ action: "reorder", paneIds: ["tab-y", pane.id] });
        assert.deepStrictEqual(
          reordered.tabs.panes.map((p) => p.id),
          ["tab-y", pane.id],
        );
        const closed = yield* write({ action: "close", paneId: pane.id });
        assert.equal(closed.tabs.activePaneId, "tab-y");
        assert.equal(closed.tabs.panes.length, 1);
        assert.equal(changes.length, 6);
        yield* write({ action: "close", paneId: pane.id });
        assert.equal(changes.length, 6);
        yield* write({ action: "close", paneId: "tab-y" });
        const empty = yield* write({ action: "show", open: true });
        assert.deepStrictEqual(empty.tabs, { open: false, panes: [], activePaneId: null });
        assert.equal(changes.length, 7);
        unsubscribe();
      }),
    ),
);

it.effect("restores App X while preserving App Y selection and a closed dock", () =>
  withDb(
    Effect.gen(function* () {
      yield* fixture;
      const write = (update: Parameters<typeof updateFolderAppTabs>[0]["update"]) =>
        updateFolderAppTabs({ folderId, updatedAt, update });
      yield* write({ action: "open", pane, preserveSelection: false });
      yield* write({ action: "open", pane: { ...pane, id: "tab-y" }, preserveSelection: false });
      for (const open of [true, false]) {
        yield* write({ action: "show", open });
        const restored = yield* write({ action: "open", pane, preserveSelection: true });
        assert.equal(restored.tabs.open, open);
        assert.equal(restored.tabs.activePaneId, "tab-y");
        assert.equal(restored.tabs.panes.length, 2);
      }
    }),
  ),
);

it.effect("discovers a retained pane without selecting it or opening its dock", () =>
  withDb(
    Effect.gen(function* () {
      yield* fixture;
      const result = yield* updateFolderAppTabs({
        folderId,
        updatedAt,
        update: { action: "open", pane, preserveSelection: true },
      });
      assert.deepStrictEqual(result.tabs, { open: false, panes: [pane], activePaneId: null });
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        tabs: string;
      }>`SELECT app_tabs AS tabs FROM projection_folders WHERE folder_id=${folderId}`;
      assert.deepStrictEqual(JSON.parse(row!.tabs), result.tabs);
    }),
  ),
);

it.effect("rejects invalid selection and reorder without changing the folder row", () =>
  withDb(
    Effect.gen(function* () {
      yield* fixture;
      yield* updateFolderAppTabs({
        folderId,
        updatedAt,
        update: { action: "open", pane, preserveSelection: false },
      });
      const before = yield* getFolderAppTabs({ folderId });
      const failed = yield* Effect.result(
        updateFolderAppTabs({ folderId, updatedAt, update: { action: "reorder", paneIds: [] } }),
      );
      assert.equal(failed._tag, "Failure");
      const select = yield* Effect.result(
        updateFolderAppTabs({
          folderId,
          updatedAt,
          update: { action: "select", paneId: "closed" },
        }),
      );
      assert.equal(select._tag, "Failure");
      assert.deepStrictEqual(yield* getFolderAppTabs({ folderId }), before);
    }),
  ),
);
