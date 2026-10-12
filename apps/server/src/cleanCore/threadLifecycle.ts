import { rm } from "node:fs/promises";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerConfig } from "../config.ts";
import { providerNativeStateRoot } from "../provider/providerNativeStatePaths.ts";
import { ThreadSender } from "./ThreadSender.ts";
import { ThreadRunningError } from "./threadStore.ts";
import { ProviderTurnSelectionResolver } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import {
  ThreadId,
  type CleanCoreThreadSummary,
  type CleanCoreCreateThreadResult,
  type CleanCoreThreadUpdate,
  type CleanCoreCreateThreadInput,
} from "@penkra/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createThread, renameThread, setThreadArchived, setThreadDeleted } from "./threadStore.ts";
import { findThread, getThread } from "./threadList.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";

/** Folder validation, insertion and publication share one creation path. */
export const createThreadFromClient = (input: CleanCoreCreateThreadInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const publisher = yield* ThreadPublisher;
    const inserted = yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql`SELECT id FROM threads WHERE id = ${input.threadId}`;
        if (existing.length !== 0) return false;
        const folders = yield* sql<{
          spaceId: string;
        }>`SELECT space_id AS "spaceId" FROM projection_folders WHERE folder_id = ${input.folderId} AND deleted_at IS NULL`;
        const folder = folders[0];
        if (folder === undefined)
          return yield* Effect.fail(new Error("The folder does not exist."));
        const connectionId =
          input.connection.kind === "selected"
            ? input.connection.connectionId
            : yield* Effect.flatMap(Effect.service(ProviderTurnSelectionResolver), (resolver) =>
                resolver.resolveNewThreadConnection({ modelSelection: input.modelSelection }),
              );
        const fields = {
          id: input.threadId,
          spaceId: folder.spaceId,
          folderId: input.folderId,
          sidebarSortOrder: null,
          title: input.title,
          provider: input.modelSelection.provider,
          model: input.modelSelection.model,
          modelOptions:
            input.modelSelection.options === undefined
              ? null
              : JSON.stringify(input.modelSelection.options),
          connectionId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        };
        yield* createThread(
          input.creator.kind === "agent"
            ? { ...fields, createdBy: "agent", createdByThreadId: input.creator.threadId }
            : { ...fields, createdBy: input.creator.kind },
        );
        return true;
      }),
    );
    const row = yield* getThread(input.threadId);
    if (inserted) publisher.publishCreated({ threadId: input.threadId });
    return { thread: row, created: inserted };
  });

export const updateThreadLifecycle = (
  input:
    | { action: "rename"; threadId: ThreadId; title: string; updatedAt: string }
    | { action: "archive"; threadId: ThreadId; archivedAt: string | null; updatedAt: string }
    | { action: "delete"; threadId: ThreadId; deletedAt: string; updatedAt: string },
) =>
  Effect.gen(function* () {
    const publisher = yield* ThreadPublisher;
    const changed =
      input.action === "rename"
        ? yield* renameThread(input.threadId, input.title, input.updatedAt)
        : input.action === "archive"
          ? yield* setThreadArchived(input.threadId, input.archivedAt, input.updatedAt, null)
          : yield* setThreadDeleted(input.threadId, input.deletedAt, input.updatedAt);
    if (changed) publisher.publish({ threadId: input.threadId });
    return changed;
  });

export interface RetentionArchiveInput {
  readonly threadId: ThreadId;
  readonly archivedAt: string;
  readonly expectedUpdatedAt: string;
  readonly expectedLastVisitedAt: string | null;
}
export interface RetentionDeleteInput {
  readonly threadId: ThreadId;
  readonly deletedAt: string;
  readonly expectedArchivedAt: string;
}
type LifecycleUpdate = Extract<CleanCoreThreadUpdate, { action: "rename" | "archive" | "delete" }>;
type RetentionCondition =
  | { readonly kind: "inactive"; readonly updatedAt: string; readonly lastVisitedAt: string | null }
  | { readonly kind: "expired"; readonly archivedAt: string }
  | null;

/** The shared lifecycle service captures its database and publisher, not rows. */
export class ThreadLifecycle extends ServiceMap.Service<
  ThreadLifecycle,
  {
    readonly archiveInactive: (input: RetentionArchiveInput) => Effect.Effect<boolean, Error>;
    readonly deleteExpired: (input: RetentionDeleteInput) => Effect.Effect<boolean, Error>;
    readonly get: (threadId: ThreadId) => Effect.Effect<CleanCoreThreadSummary | null, Error>;
    readonly create: (
      input: CleanCoreCreateThreadInput,
    ) => Effect.Effect<CleanCoreCreateThreadResult, Error>;
    readonly update: (
      input: Extract<CleanCoreThreadUpdate, { action: "rename" | "archive" | "delete" }>,
    ) => Effect.Effect<void, Error>;
  }
>()("penkra/cleanCore/ThreadLifecycle") {}

export const makeThreadLifecycle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const publisher = yield* ThreadPublisher;
  const resolver = yield* ProviderTurnSelectionResolver;
  const sender = yield* ThreadSender;
  const provider = yield* ProviderService;
  const config = yield* ServerConfig;
  const update = (input: LifecycleUpdate, condition: RetentionCondition) =>
    sender.runExclusive(
      input.threadId,
      Effect.gen(function* () {
        if (condition?.kind === "inactive" && input.action === "archive") {
          const changed = yield* sql.withTransaction(
            Effect.gen(function* () {
              const applied = yield* setThreadArchived(
                input.threadId,
                input.archivedAt,
                input.updatedAt,
                condition,
              );
              if (!applied) return false;
              yield* provider.stopSession({ threadId: input.threadId });
              return true;
            }),
          );
          if (changed) publisher.publish({ threadId: input.threadId });
          return changed;
        }
        const row = yield* findThread(input.threadId);
        if (row === null || row.deletedAt !== null) return false;
        if (condition?.kind === "expired" && row.archivedAt !== condition.archivedAt) return false;
        const archiving = input.action === "archive" && input.archivedAt !== null;
        if (archiving && row.archivedAt !== null) return false;
        if (archiving && row.state === "running")
          return yield* Effect.fail(new ThreadRunningError());
        if (archiving || input.action === "delete") {
          yield* provider.stopSession({ threadId: input.threadId });
        }
        if (input.action === "delete") {
          const nativeRows = yield* sql<{
            nativeStateId: string | null;
          }>`SELECT native_state_id AS "nativeStateId" FROM threads WHERE id = ${input.threadId}`;
          const nativeStateId = nativeRows[0]!.nativeStateId;
          if (nativeStateId !== null) {
            const path = providerNativeStateRoot(config.stateDir, nativeStateId);
            yield* Effect.tryPromise({
              try: () => rm(path, { recursive: true, force: true }),
              catch: (cause) =>
                new Error(`Could not delete native state at ${path}: ${String(cause)}`, {
                  cause,
                }),
            });
          }
        }
        return yield* updateThreadLifecycle(input).pipe(
          Effect.provideService(ThreadPublisher, publisher),
        );
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
      ),
    );
  return {
    get: (threadId: ThreadId) =>
      findThread(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    create: (input: CleanCoreCreateThreadInput) =>
      createThreadFromClient(input).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ThreadPublisher, publisher),
        Effect.provideService(ProviderTurnSelectionResolver, resolver),
      ),
    update: (input: LifecycleUpdate) => update(input, null).pipe(Effect.asVoid),
    archiveInactive: (input: RetentionArchiveInput) =>
      update(
        {
          action: "archive",
          threadId: input.threadId,
          archivedAt: input.archivedAt,
          updatedAt: input.archivedAt,
        },
        {
          kind: "inactive",
          updatedAt: input.expectedUpdatedAt,
          lastVisitedAt: input.expectedLastVisitedAt,
        },
      ),
    deleteExpired: (input: RetentionDeleteInput) =>
      update(
        {
          action: "delete",
          threadId: input.threadId,
          deletedAt: input.deletedAt,
          updatedAt: input.deletedAt,
        },
        { kind: "expired", archivedAt: input.expectedArchivedAt },
      ),
  };
});

export const ThreadLifecycleLive = Layer.effect(ThreadLifecycle, makeThreadLifecycle);
