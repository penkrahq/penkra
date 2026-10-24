import { observePublisher } from "./threadPublisherTestHelpers.ts";
import { assert, it } from "@effect/vitest";
import { FolderId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { makeThreadPublisher } from "./threadStore.ts";
import { getFolderAppTabs, updateFolderAppTabs, listFolderAppTabs } from "./folderAppTabs.ts";

const folderId = FolderId.make("app-folder");
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
it.effect("round-trips route state and titles, explicitly clears them, and stamps visibility", () =>
  withDb(
    Effect.gen(function* () {
      yield* fixture;
      const write = (update: Parameters<typeof updateFolderAppTabs>[0]["update"]) =>
        updateFolderAppTabs({ folderId, updatedAt, update });
      yield* write({ action: "open", pane });
      yield* write({
        action: "navigate",
        paneId: pane.id,
        appRoute: "/open",
        appState: { url: "https://example.com", location: { path: "/tmp" } },
      });
      yield* write({ action: "present", paneId: pane.id, title: "Example" });
      yield* write({ action: "stamp", paneIds: [pane.id], at: updatedAt });
      const stored = (yield* getFolderAppTabs({ folderId }))!.tabs.panes[0]!;
      assert.deepStrictEqual(stored.appState, {
        url: "https://example.com",
        location: { path: "/tmp" },
      });
      assert.equal(stored.title, "Example");
      assert.equal(stored.lastVisibleAt, updatedAt);
      const reopened = yield* write({ action: "open", pane: { ...pane, appRoute: "/open" } });
      assert.deepStrictEqual(reopened.tabs.panes[0]!.appState, stored.appState);
      assert.equal(reopened.tabs.panes[0]!.title, "Example");
      yield* write({ action: "navigate", paneId: pane.id, appRoute: "/" });
      yield* write({ action: "present", paneId: pane.id });
      const cleared = (yield* getFolderAppTabs({ folderId }))!.tabs.panes[0]!;
      assert.equal("appState" in cleared, false);
      assert.equal("title" in cleared, false);
      assert.equal(cleared.lastVisibleAt, updatedAt);
    }),
  ),
);
const withDb = <A, E>(
  program: Effect.Effect<
    A,
    E,
    SqlClient.SqlClient | import("effect/Scope").Scope | ThreadPublisher
  >,
) =>
  program.pipe(
    Effect.provideService(ThreadPublisher, makeThreadPublisher()),
    Effect.provide(NodeSqliteClient.layerMemory()),
  );

it.effect("pages every folder once across the existing read-page boundary", () =>
  withDb(
    Effect.gen(function* () {
      yield* fixture;
      for (let index = 0; index < 51; index++)
        yield* seedThreadFolderFixture(
          FolderId.make(`page-${String(index).padStart(3, "0")}`),
          "space-1",
        );
      const seen: string[] = [];
      let cursor: typeof folderId | undefined;
      do {
        const result = yield* listFolderAppTabs(
          cursor === undefined ? {} : { afterFolderId: cursor },
        );
        assert.isAtMost(result.folders.length, 50);
        seen.push(...result.folders.map((entry) => entry.folderId));
        cursor = result.nextCursor ?? undefined;
      } while (cursor !== undefined);
      assert.equal(new Set(seen).size, seen.length);
      assert.equal(seen.filter((id) => id.startsWith("page-")).length, 51);
    }),
  ),
);

it.effect("opens, updates, reorders and closes App tabs with one broadcast per write", () =>
  withDb(
    Effect.gen(function* () {
      yield* fixture;
      const publisher = yield* ThreadPublisher;
      const changes: unknown[] = [];
      const unsubscribe = yield* observePublisher(publisher.sidebarChanges, (change) =>
        changes.push(change),
      );
      const write = (update: Parameters<typeof updateFolderAppTabs>[0]["update"]) =>
        updateFolderAppTabs({ folderId, updatedAt, update });
      assert.deepStrictEqual((yield* getFolderAppTabs({ folderId }))?.tabs, {
        panes: [],
      });
      yield* write({ action: "open", pane });
      yield* write({ action: "open", pane: { ...pane, id: "tab-y" } });
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
      assert.equal(closed.tabs.panes.length, 1);
      assert.equal(changes.length, 5);
      yield* write({ action: "close", paneId: pane.id });
      assert.equal(changes.length, 5);
      yield* write({ action: "close", paneId: "tab-y" });
      const empty = yield* getFolderAppTabs({ folderId });
      assert.deepStrictEqual(empty?.tabs, { panes: [] });
      assert.equal(changes.length, 6);
      unsubscribe();
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
        update: { action: "open", pane },
      });
      assert.deepStrictEqual(result.tabs, { panes: [pane] });
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        tabs: string;
      }>`SELECT app_tabs AS tabs FROM projection_folders WHERE folder_id=${folderId}`;
      assert.deepStrictEqual(JSON.parse(row!.tabs), result.tabs);
    }),
  ),
);

it.effect("rejects invalid reorder without changing the folder row", () =>
  withDb(
    Effect.gen(function* () {
      yield* fixture;
      yield* updateFolderAppTabs({
        folderId,
        updatedAt,
        update: { action: "open", pane },
      });
      const before = yield* getFolderAppTabs({ folderId });
      const failed = yield* Effect.result(
        updateFolderAppTabs({ folderId, updatedAt, update: { action: "reorder", paneIds: [] } }),
      );
      assert.equal(failed._tag, "Failure");
      assert.deepStrictEqual(yield* getFolderAppTabs({ folderId }), before);
    }),
  ),
);

it.effect("never closes a recently stamped tab based on a stale sweep read", () =>
  withDb(
    Effect.gen(function* () {
      yield* fixture;
      const write = (update: Parameters<typeof updateFolderAppTabs>[0]["update"]) =>
        updateFolderAppTabs({ folderId, updatedAt, update });
      yield* write({
        action: "open",
        pane: { ...pane, lastVisibleAt: "2026-10-01T00:00:00.000Z" },
      });
      yield* write({ action: "stamp", paneIds: [pane.id], at: "2026-10-20T00:00:00.000Z" });
      yield* write({ action: "stamp", paneIds: [pane.id], at: "2026-10-02T00:00:00.000Z" });
      const retained = yield* write({
        action: "close",
        paneId: pane.id,
        inactiveBefore: "2026-10-19T00:00:00.000Z",
      });
      assert.equal(retained.tabs.panes[0]!.lastVisibleAt, "2026-10-20T00:00:00.000Z");
      const expired = yield* write({
        action: "close",
        paneId: pane.id,
        inactiveBefore: "2026-10-22T00:00:00.000Z",
      });
      assert.equal(expired.tabs.panes.length, 0);
    }),
  ),
);
