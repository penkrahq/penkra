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
import { setThreadModel, setThreadConnection, setThreadWorkingDirectory } from "./threadStore.ts";
import { updateThreadLifecycle } from "./threadLifecycle.ts";

export const updateThreadFixture = (
  sql: SqlClient.SqlClient,
  input: Extract<
    CleanCoreThreadUpdate,
    { action: "model" | "connection" | "rename" | "archive" | "delete" | "workingDirectory" }
  >,
) => {
  const write =
    input.action === "model"
      ? setThreadModel(input)
      : input.action === "connection"
        ? setThreadConnection(input)
        : input.action === "workingDirectory"
          ? setThreadWorkingDirectory(input)
          : updateThreadLifecycle(input).pipe(
              Effect.provideService(ThreadPublisher, makeThreadPublisher()),
            );
  return write.pipe(Effect.provideService(SqlClient.SqlClient, sql));
};

import { OrchestrationThread, type OrchestrationReadModel, type ThreadId } from "@penkra/contracts";
import { Schema } from "effect";

export const seedThreadReadModelFixture = (
  model: OrchestrationReadModel,
  input: CleanCoreCreateThreadInput & {
    parentThreadId: ThreadId | null;
    sidebarSortOrder: number;
    deckSortOrder: number;
    isPinned: boolean;
  },
) =>
  Effect.sync(() => {
    const thread = Schema.decodeUnknownSync(OrchestrationThread)({
      id: input.threadId,
      folderId: input.folderId,
      deckId: input.deckId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      workingDirectory: input.workingDirectory,
      connectionId: input.connection.kind === "selected" ? input.connection.connectionId : null,
      parentThreadId: input.parentThreadId,
      sidebarSortOrder: input.sidebarSortOrder,
      deckSortOrder: input.deckSortOrder,
      isPinned: input.isPinned,
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

/** A migrated provider-native child may retain its original parent; new creation never writes it. */
export const seedLegacyThreadParentFixture = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  parentThreadId: ThreadId,
) =>
  sql`UPDATE threads SET parent_thread_id = ${parentThreadId}, created_by = 'provider_native' WHERE id = ${threadId}`;
