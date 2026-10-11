import type { CleanCoreCreateThreadInput } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderTurnSelectionResolver } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { makeThreadPublisher } from "./threadStore.ts";
import { createThreadFromClient } from "./threadLifecycle.ts";

/** Test setup uses the same canonical creation write as a client. */
export const createThreadFixture = (sql: SqlClient.SqlClient, input: CleanCoreCreateThreadInput) =>
  createThreadFromClient(input).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provideService(ThreadPublisher, makeThreadPublisher()),
    Effect.provideService(
      ProviderTurnSelectionResolver,
      {} as typeof ProviderTurnSelectionResolver.Service,
    ),
  );

import type { CleanCoreThreadUpdate } from "@penkra/contracts";
import { setThreadModel, setThreadConnection } from "./threadStore.ts";
import { updateThreadLifecycle } from "./threadLifecycle.ts";

export const updateThreadFixture = (
  sql: SqlClient.SqlClient,
  input: Extract<
    CleanCoreThreadUpdate,
    { action: "model" | "connection" | "rename" | "archive" | "delete" }
  >,
) => {
  const write =
    input.action === "model"
      ? setThreadModel(input)
      : input.action === "connection"
        ? setThreadConnection(input)
        : updateThreadLifecycle(input).pipe(
            Effect.provideService(ThreadPublisher, makeThreadPublisher()),
          );
  return write.pipe(Effect.provideService(SqlClient.SqlClient, sql));
};

import { OrchestrationThread, type OrchestrationReadModel } from "@penkra/contracts";
import { Schema } from "effect";

export const seedThreadReadModelFixture = (
  model: OrchestrationReadModel,
  input: CleanCoreCreateThreadInput & {
    sidebarSortOrder: number;
  },
) =>
  Effect.sync(() => {
    const thread = Schema.decodeUnknownSync(OrchestrationThread)({
      id: input.threadId,
      folderId: input.folderId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      connectionId: input.connection.kind === "selected" ? input.connection.connectionId : null,
      sidebarSortOrder: input.sidebarSortOrder,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      deletedAt: null,
      archivedAt: null,
      latestTurn: null,
      session: null,
      messages: [],
      activities: [],
      queuedMessageIds: [],
      pendingInteractions: [],
    });
    return { ...model, threads: [...model.threads, thread] };
  });

export const seedThreadFolderFixture = (folderId: string, spaceId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_folders
      (folder_id, title, space_id, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${folderId}, 'Fixture folder', ${spaceId}, NULL, '[]',
        '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`;
  });
