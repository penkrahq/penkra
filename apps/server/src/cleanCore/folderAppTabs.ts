// Purpose: Keep the folder's App tabs in one row and broadcast each committed change.
import {
  CleanCoreFolderAppTabs,
  type CleanCoreFolderAppTabsResult,
  type CleanCoreGetFolderAppTabsInput,
  type CleanCoreUpdateFolderAppTabsInput,
} from "@penkra/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadPublisher } from "./ThreadPublisher.ts";

export const getFolderAppTabs = (input: CleanCoreGetFolderAppTabsInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      tabs: string;
      updatedAt: string;
    }>`SELECT app_tabs AS tabs, updated_at AS "updatedAt" FROM projection_folders WHERE folder_id=${input.folderId} AND deleted_at IS NULL`;
    if (row === undefined) return null;
    const tabs = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(CleanCoreFolderAppTabs)(JSON.parse(row.tabs)),
      catch: (cause) => new Error("The folder's App tabs could not be read.", { cause }),
    });
    return {
      folderId: input.folderId,
      tabs,
      updatedAt: row.updatedAt,
    } satisfies CleanCoreFolderAppTabsResult;
  });

export const updateFolderAppTabs = (input: CleanCoreUpdateFolderAppTabsInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const publisher = yield* ThreadPublisher;
    const { result, changed } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const previous = yield* getFolderAppTabs(input);
        if (previous === null) return yield* Effect.fail(new Error("The folder is not available."));
        const tabs = previous.tabs;
        const update = input.update;
        let next: CleanCoreFolderAppTabs;
        switch (update.action) {
          case "open": {
            const exists = tabs.panes.some((pane) => pane.id === update.pane.id);
            const panes = exists
              ? tabs.panes.map((pane) => (pane.id === update.pane.id ? update.pane : pane))
              : [...tabs.panes, update.pane];
            next = update.preserveSelection
              ? { ...tabs, panes }
              : { open: true, panes, activePaneId: update.pane.id };
            break;
          }
          case "close": {
            const index = tabs.panes.findIndex((pane) => pane.id === update.paneId);
            if (index === -1) {
              next = tabs;
              break;
            }
            const panes = tabs.panes.filter((pane) => pane.id !== update.paneId);
            const activePaneId =
              tabs.activePaneId !== update.paneId
                ? tabs.activePaneId
                : (panes[index]?.id ?? panes[index - 1]?.id ?? null);
            next = { open: panes.length > 0 && tabs.open, panes, activePaneId };
            break;
          }
          case "select":
            if (!tabs.panes.some((pane) => pane.id === update.paneId))
              return yield* Effect.fail(new Error("The App tab is not open in this folder."));
            next = { ...tabs, open: true, activePaneId: update.paneId };
            break;
          case "reorder": {
            const panesById = new Map(tabs.panes.map((pane) => [pane.id, pane]));
            if (
              update.paneIds.length !== panesById.size ||
              new Set(update.paneIds).size !== panesById.size ||
              update.paneIds.some((id) => !panesById.has(id))
            )
              return yield* Effect.fail(
                new Error("Reordering must name every open App tab exactly once."),
              );
            next = { ...tabs, panes: update.paneIds.map((id) => panesById.get(id)!) };
            break;
          }
          case "show":
            next = { ...tabs, open: update.open && tabs.panes.length > 0 };
            break;
          case "navigate":
            if (!tabs.panes.some((pane) => pane.id === update.paneId))
              return yield* Effect.fail(new Error("The App tab is not open in this folder."));
            next = {
              ...tabs,
              panes: tabs.panes.map((pane) =>
                pane.id === update.paneId ? { ...pane, appRoute: update.appRoute } : pane,
              ),
            };
            break;
        }
        if (JSON.stringify(next) === JSON.stringify(tabs))
          return { result: previous, changed: false };
        yield* sql`UPDATE projection_folders SET app_tabs=${JSON.stringify(next)}, updated_at=${input.updatedAt} WHERE folder_id=${input.folderId}`;
        return {
          result: { folderId: input.folderId, tabs: next, updatedAt: input.updatedAt },
          changed: true,
        };
      }),
    );
    if (changed) publisher.publishSidebar({ kind: "folder.appTabs", ...result });
    return result;
  });
