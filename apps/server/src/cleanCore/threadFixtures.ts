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

import type {
  ModelSelection,
  ProviderConnectionId,
  ThreadId,
  CleanCoreThreadUpdate,
} from "@penkra/contracts";
import { updateThreadLifecycle } from "./threadLifecycle.ts";

/** Seeds admitted runtime selections directly; composer picks belong to the draft. */
export const updateThreadFixture = (
  sql: SqlClient.SqlClient,
  input:
    | Extract<CleanCoreThreadUpdate, { action: "rename" | "archive" | "delete" }>
    | {
        action: "connection";
        threadId: ThreadId;
        connectionId: ProviderConnectionId | null;
        updatedAt: string;
      }
    | {
        action: "model";
        threadId: ThreadId;
        modelSelection: ModelSelection;
        connection:
          | { kind: "keep" }
          | { kind: "selected"; connectionId: ProviderConnectionId | null };
        updatedAt: string;
      },
) => {
  const write =
    input.action === "model"
      ? Effect.gen(function* () {
          const rows = yield* sql<{
            provider: string;
            connectionId: string | null;
          }>`SELECT provider, connection_id AS "connectionId" FROM threads WHERE id = ${input.threadId}`;
          const row = rows[0]!;
          if (row.provider !== input.modelSelection.provider)
            return yield* Effect.fail(
              new Error(
                "This thread uses a different provider. To use another provider, start a new thread.",
              ),
            );
          const connectionId =
            input.connection.kind === "keep" ? row.connectionId : input.connection.connectionId;
          yield* sql`UPDATE threads SET model = ${input.modelSelection.model}, model_options = ${input.modelSelection.options === undefined ? null : JSON.stringify(input.modelSelection.options)}, connection_id = ${connectionId}, updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`;
          return true;
        })
      : input.action === "connection"
        ? sql`UPDATE threads SET connection_id = ${input.connectionId}, updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`.pipe(
            Effect.as(true),
          )
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
      (folder_id, title, space_id, workspace_root, created_at, updated_at)
      VALUES (${folderId}, 'Fixture folder', ${spaceId}, NULL,
        '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`;
  });
