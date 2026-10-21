// Purpose: Keep the folder's App tabs in one row and broadcast each committed change.
import {
  CleanCoreFolderAppTabs,
  type CleanCoreFolderAppTabsResult,
  type CleanCoreGetFolderAppTabsInput,
  type CleanCoreUpdateFolderAppTabsInput,
  CleanCoreListFolderAppTabsInput,
  THREADS_PAGE_SIZE,
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
      folderTitle: string;
    }>`SELECT title AS "folderTitle", app_tabs AS tabs, updated_at AS "updatedAt" FROM projection_folders WHERE folder_id=${input.folderId} AND deleted_at IS NULL`;
    if (row === undefined) return null;
    const tabs = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(CleanCoreFolderAppTabs)(JSON.parse(row.tabs)),
      catch: (cause) => new Error("The folder's App tabs could not be read.", { cause }),
    });
    const result = {
      folderTitle: row.folderTitle,
      folderId: input.folderId,
      tabs,
      updatedAt: row.updatedAt,
    };
    return result satisfies CleanCoreFolderAppTabsResult;
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
              ? tabs.panes.map((pane) =>
                  pane.id === update.pane.id ? { ...pane, ...update.pane } : pane,
                )
              : [...tabs.panes, update.pane];
            next = { panes };
            break;
          }
          case "close": {
            next = {
              panes: tabs.panes.filter(
                (pane) =>
                  pane.id !== update.paneId ||
                  (update.inactiveBefore !== undefined &&
                    (pane.lastVisibleAt === undefined ||
                      pane.lastVisibleAt >= update.inactiveBefore)),
              ),
            };
            break;
          }
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
          case "navigate":
            if (!tabs.panes.some((pane) => pane.id === update.paneId))
              return yield* Effect.fail(new Error("The App tab is not open in this folder."));
            next = {
              ...tabs,
              panes: tabs.panes.map((pane) =>
                pane.id === update.paneId
                  ? (() => {
                      const { appState: _previousState, ...rest } = pane;
                      return {
                        ...rest,
                        appRoute: update.appRoute,
                        ...(update.appState === undefined ? {} : { appState: update.appState }),
                      };
                    })()
                  : pane,
              ),
            };
            break;
          case "present":
            if (!tabs.panes.some((pane) => pane.id === update.paneId))
              return yield* Effect.fail(new Error("The App tab is not open in this folder."));
            next = {
              ...tabs,
              panes: tabs.panes.map((pane) => {
                if (pane.id !== update.paneId) return pane;
                const { title: _previousTitle, ...rest } = pane;
                return { ...rest, ...(update.title === undefined ? {} : { title: update.title }) };
              }),
            };
            break;
          case "stamp": {
            const ids = new Set(update.paneIds);
            next = {
              ...tabs,
              panes: tabs.panes.map((pane) =>
                ids.has(pane.id) &&
                (pane.lastVisibleAt === undefined || pane.lastVisibleAt < update.at)
                  ? { ...pane, lastVisibleAt: update.at }
                  : pane,
              ),
            };
            break;
          }
        }
        if (JSON.stringify(next) === JSON.stringify(tabs))
          return { result: previous, changed: false };
        yield* sql`UPDATE projection_folders SET app_tabs=${JSON.stringify(next)}, updated_at=${input.updatedAt} WHERE folder_id=${input.folderId}`;
        return {
          result: {
            folderTitle: previous.folderTitle,
            folderId: input.folderId,
            tabs: next,
            updatedAt: input.updatedAt,
          },
          changed: true,
        };
      }),
    );
    if (changed) publisher.publishSidebar({ kind: "folder.appTabs", ...result });
    return result;
  });

export const listFolderAppTabs = (input: typeof CleanCoreListFolderAppTabsInput.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ids = yield* sql<{
      folderId: import("@penkra/contracts").FolderId;
    }>`SELECT folder_id AS "folderId" FROM projection_folders
    WHERE deleted_at IS NULL AND folder_id > ${input.afterFolderId ?? ""} ORDER BY folder_id LIMIT ${THREADS_PAGE_SIZE}`;
    const folders = [];
    for (const row of ids) {
      const folder = yield* getFolderAppTabs({ folderId: row.folderId });
      if (folder) folders.push(folder);
    }
    return { folders, nextCursor: ids.length === THREADS_PAGE_SIZE ? ids.at(-1)!.folderId : null };
  });
