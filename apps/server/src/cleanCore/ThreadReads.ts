import { threadShellFromRow } from "@penkra/shared/threadView";
import { decodeUserItemData } from "@penkra/shared/userItemData";
export type * from "./threadReadTypes.ts";
// FILE: ThreadReads.ts
// Purpose: Indexed canonical thread and navigation reads for gateway and view consumers.
import {
  FolderId,
  SpaceId,
  ThreadId,
  ModelSelection,
  MessageId,
  TurnId,
  OrchestrationThread,
  OrchestrationThreadShell,
  OrchestrationFolder,
  type OrchestrationFolderShell,
  type OrchestrationSpaceShell,
  type OrchestrationMessage,
  OrchestrationThreadActivity,
  type OrchestrationGetThreadTurnsPageInput,
} from "@penkra/contracts";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  findThread,
  THREAD_SUMMARY_COLUMNS,
  decodeThreadSummary,
  type RawThreadSummaryRecord,
} from "./threadList.ts";
import { listThreadItemsPage, type ThreadItemRecord } from "./threadItemsPage.ts";
import {} from "./navigation.ts";
import type {
  ProjectionFolderPageCursor,
  ProjectionThreadShellPageInput,
  ProjectionTranscriptSearchInput,
  ProjectionTranscriptSearchResult,
  ProjectionThreadMessageContextInput,
} from "./threadReadTypes.ts";

export interface ThreadTranscriptPage {
  readonly threadId: ThreadId;
  readonly conversationTurnCount: number;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly userStatuses: ReadonlyMap<string, string>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly pendingInteractions: NonNullable<typeof OrchestrationThread.Type.pendingInteractions>;
  readonly hasOlder: boolean;
  readonly nextCursor: string | null;
}

function transcriptRows(items: ReadonlyArray<ThreadItemRecord>) {
  const messages: OrchestrationMessage[] = [];
  const userStatuses = new Map<string, string>();
  const activities: OrchestrationThreadActivity[] = [];
  const pendingInteractions: NonNullable<
    typeof OrchestrationThread.Type.pendingInteractions
  >[number][] = [];
  for (const item of items.toSorted((a, b) => a.seq - b.seq)) {
    const data = item.data === null ? {} : JSON.parse(item.data);
    if (item.kind === "user" && decodeUserItemData(data).origin._tag === "recovery") continue;
    if (item.kind === "user") userStatuses.set(item.sourceId, item.status);
    if (item.kind === "user" || item.kind === "text") {
      messages.push({
        id: MessageId.makeUnsafe(item.sourceId),
        role: item.kind === "user" ? "user" : "assistant",
        text: item.text ?? "",
        turnId: item.turnId === null ? null : TurnId.makeUnsafe(item.turnId),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        streaming: item.status === "streaming",
        source: "native",
        ...(item.kind === "user" ? decodeUserItemData(data) : {}),
      });
    } else if (item.kind !== "turn") {
      activities.push(
        Schema.decodeUnknownSync(OrchestrationThreadActivity)({
          id: item.sourceId,
          tone: data.tone ?? "info",
          kind: data.kind ?? item.kind,
          summary: data.summary ?? item.text ?? item.kind,
          payload: data.payload ?? data,
          turnId: item.turnId,
          sequence: item.seq,
          createdAt: item.createdAt,
        }),
      );
      if (item.kind === "question" && item.status === "open")
        pendingInteractions.push({
          interactionKind: "userInput",
          requestId: item.sourceId,
          threadId: ThreadId.makeUnsafe(item.threadId),
          turnId: item.turnId === null ? null : TurnId.makeUnsafe(item.turnId),
          lifecycleGeneration: data.lifecycleGeneration ?? null,
          status: "pending",
          responseCommandId: null,
          responseRequestedAt: null,
          createdAt: item.createdAt,
          resolvedAt: null,
        });
    }
  }
  return { messages, userStatuses, activities, pendingInteractions };
}

export const makeThreadReads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const getThreadShellById = (threadId: ThreadId) =>
    run(
      findThread(threadId).pipe(
        Effect.map((row) =>
          row === null || row.deletedAt !== null
            ? Option.none<OrchestrationThreadShell>()
            : Option.some(threadShellFromRow(row)),
        ),
      ),
    );
  const readDetail = (threadId: ThreadId, complete: boolean) =>
    run(
      Effect.gen(function* () {
        const row = yield* findThread(threadId);
        if (row === null || row.deletedAt !== null) return Option.none<OrchestrationThread>();
        const items: ThreadItemRecord[] = [];
        let beforeSeq: number | undefined;
        do {
          const page = yield* listThreadItemsPage({ threadId, beforeSeq });
          items.unshift(...page.items);
          if (!complete || page.nextCursor === null) break;
          beforeSeq = page.nextCursor;
        } while (true);
        return Option.some(
          Schema.decodeUnknownSync(OrchestrationThread)({
            ...threadShellFromRow(row),
            deletedAt: row.deletedAt,
            ...transcriptRows(items),
            queuedMessageIds: JSON.parse(row.queue).map(
              (message: { messageId: string }) => message.messageId,
            ),
          }),
        );
      }),
    );
  const getThreadTurnsPage = (input: OrchestrationGetThreadTurnsPageInput) =>
    run(
      Effect.gen(function* () {
        const page = yield* listThreadItemsPage({
          threadId: input.threadId,
          ...(input.before === undefined ? {} : { beforeSeq: Number(input.before) }),
        });
        const rows = transcriptRows(page.items);
        return {
          threadId: input.threadId,
          ...rows,
          conversationTurnCount: rows.messages.filter((message) => message.role === "user").length,
          hasOlder: page.nextCursor !== null,
          nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
        } satisfies ThreadTranscriptPage;
      }),
    );
  const getFolderShellById = (folderId: FolderId) =>
    run(
      Effect.gen(function* () {
        const rows = yield* sql<
          Omit<OrchestrationFolderShell, "defaultModelSelection"> & {
            defaultModelSelection: string | null;
          }
        >`SELECT folder_id AS id,title,workspace_root AS "workspaceRoot",default_model_selection_json AS "defaultModelSelection",icon_data_url AS "iconDataUrl",space_id AS "spaceId",sidebar_sort_order AS "sidebarSortOrder",created_at AS "createdAt",updated_at AS "updatedAt",archived_at AS "archivedAt" FROM projection_folders WHERE folder_id=${folderId} AND deleted_at IS NULL`;
        if (!rows[0]) return Option.none<OrchestrationFolderShell>();
        const row = rows[0];
        return Option.some({
          ...row,
          defaultModelSelection:
            row.defaultModelSelection === null
              ? null
              : Schema.decodeUnknownSync(ModelSelection)(JSON.parse(row.defaultModelSelection)),
        } as OrchestrationFolderShell);
      }),
    );
  const readItems = (
    items: ReadonlyArray<ThreadItemRecord>,
    threadId: ThreadId,
    nextCursor: number | null,
  ): ThreadTranscriptPage => {
    const rows = transcriptRows(items);
    return {
      threadId,
      ...rows,
      conversationTurnCount: rows.messages.filter((message) => message.role === "user").length,
      hasOlder: nextCursor !== null,
      nextCursor: nextCursor === null ? null : String(nextCursor),
    };
  };
  return {
    queueLength: (threadId: ThreadId) =>
      run(
        sql<{
          count: number;
        }>`SELECT json_array_length(queue) AS count FROM threads WHERE id=${threadId}`.pipe(
          Effect.map((rows) => rows[0]?.count ?? 0),
        ),
      ),
    getThreadShellById,
    getTurnPage: (input: { threadId: ThreadId; turnId: TurnId; before?: string }) =>
      run(
        Effect.gen(function* () {
          const rows =
            yield* sql<ThreadItemRecord>`SELECT thread_id AS "threadId",seq,source_id AS "sourceId",turn_id AS "turnId",kind,status,text,data,created_at AS "createdAt",updated_at AS "updatedAt" FROM thread_items WHERE thread_id=${input.threadId} AND turn_id=${input.turnId} AND (${input.before === undefined ? 1 : 0}=1 OR seq<${input.before === undefined ? null : Number(input.before)}) ORDER BY seq DESC LIMIT 51`;
          const page = rows.slice(0, 50).toReversed();
          return readItems(page, input.threadId, rows.length > 50 ? page[0]!.seq : null);
        }),
      ),
    getThreadMessageContext: (input: ProjectionThreadMessageContextInput) =>
      run(
        Effect.gen(function* () {
          const [anchor] = yield* sql<{
            seq: number;
            turnId: string | null;
          }>`SELECT seq,turn_id AS "turnId" FROM thread_items WHERE thread_id=${input.threadId} AND source_id=${input.messageId}`;
          if (!anchor) return Option.none<ThreadTranscriptPage>();
          const before = yield* sql<{
            seq: number;
          }>`SELECT seq FROM thread_items WHERE thread_id=${input.threadId} AND kind='turn' AND seq<=${anchor.seq} ORDER BY seq DESC LIMIT ${input.beforeTurns + 1}`;
          const after = yield* sql<{
            seq: number;
          }>`SELECT seq FROM thread_items WHERE thread_id=${input.threadId} AND kind='turn' AND seq>${anchor.seq} ORDER BY seq LIMIT ${input.afterTurns + 1}`;
          const lower = before.length ? before.at(-1)!.seq : 0;
          const upper = after.length === input.afterTurns + 1 ? after.at(-1)!.seq : null;
          const rows =
            yield* sql<ThreadItemRecord>`SELECT thread_id AS "threadId",seq,source_id AS "sourceId",turn_id AS "turnId",kind,status,text,data,created_at AS "createdAt",updated_at AS "updatedAt" FROM thread_items WHERE thread_id=${input.threadId} AND (seq>=${lower} OR source_id=${input.messageId}) AND (${upper} IS NULL OR seq<${upper}) ORDER BY abs(seq-${anchor.seq}),seq LIMIT 51`;
          const selected = rows.slice(0, 50).sort((a, b) => a.seq - b.seq);
          return Option.some(
            readItems(selected, input.threadId, rows.length > 50 ? selected[0]!.seq : null),
          );
        }),
      ),
    searchThreadMessages: (input: ProjectionTranscriptSearchInput) =>
      run(
        Effect.gen(function* () {
          const indexed = input.queries.every((query) => query.length >= 3);
          const match = input.queries
            .map((query) => '"' + query.replaceAll('"', '""') + '"')
            .join(input.queryMode === "all" ? " AND " : " OR ");
          const literal = input.queries
            .map((query) => `instr(lower(i.text),lower('${query.replaceAll("'", "''")}'))>0`)
            .join(input.queryMode === "all" ? " AND " : " OR ");
          const direction = input.order === "recent" ? "DESC" : "ASC";
          const compare = input.order === "recent" ? "<" : ">";
          const rows = yield* sql<
            ProjectionTranscriptSearchResult["messages"][number]
          >`SELECT i.thread_id AS "threadId",i.source_id AS "messageId",i.turn_id AS "turnId",CASE WHEN i.kind='user' THEN 'user' ELSE 'assistant' END AS role,t.title AS "threadTitle",t.provider AS "threadProvider",i.text,i.created_at AS "createdAt" FROM thread_items i JOIN threads t ON t.id=i.thread_id
        WHERE t.space_id=${input.spaceId} AND t.deleted_at IS NULL AND i.kind IN ('user','text') AND (i.kind<>'user' OR COALESCE(json_extract(i.data,'$.origin._tag'),'')<>'recovery')
        AND (${input.folderId} IS NULL OR t.folder_id=${input.folderId}) AND (${input.threadId} IS NULL OR i.thread_id=${input.threadId})
        AND (${input.turnId ?? null} IS NULL OR i.turn_id=${input.turnId ?? null})
        AND (${input.createdAfter ?? null} IS NULL OR i.created_at>=${input.createdAfter ?? null}) AND (${input.createdBefore ?? null} IS NULL OR i.created_at<=${input.createdBefore ?? null})
        AND (${input.roles === undefined ? 1 : 0}=1 OR CASE WHEN i.kind='user' THEN 'user' ELSE 'assistant' END IN (SELECT value FROM json_each(${JSON.stringify(input.roles ?? [])})))
        AND ${indexed ? sql`i.rowid IN (SELECT rowid FROM thread_items_search WHERE thread_items_search MATCH ${match})` : sql.literal("(" + literal + ")")}
        AND (${input.anchor === undefined ? 1 : 0}=1 OR (i.created_at,i.thread_id,i.source_id) ${sql.literal(compare)} (${input.anchor?.createdAt ?? null},${input.anchor?.threadId ?? null},${input.anchor?.messageId ?? null}))
        ORDER BY i.created_at ${sql.literal(direction)},i.thread_id ${sql.literal(direction)},i.source_id ${sql.literal(direction)} LIMIT 51`;
          return {
            messages: rows.slice(0, 50),
            hasMore: rows.length > 50,
            path: indexed ? ("indexed" as const) : ("short-query-fallback" as const),
          };
        }),
      ),

    getThreadDetailById: (threadId: ThreadId) => readDetail(threadId, false),
    getThreadDetailForExportById: (threadId: ThreadId) => readDetail(threadId, true),
    getThreadTurnsPage,
    getFolderShellById,
    getFolderShellsByIds: (folderIds: ReadonlyArray<FolderId>) =>
      run(
        Effect.gen(function* () {
          if (folderIds.length > 50)
            return yield* Effect.fail(new Error("Folder reads are limited to 50 ids."));
          const rows = yield* Effect.forEach(folderIds, getFolderShellById);
          return rows.flatMap((row) => (Option.isSome(row) ? [row.value] : []));
        }),
      ),
    getSpaceShellById: (spaceId: SpaceId) =>
      run(
        sql<OrchestrationSpaceShell>`SELECT space_id AS id,name,icon,sort_order AS "sortOrder",created_at AS "createdAt",updated_at AS "updatedAt",archived_at AS "archivedAt" FROM projection_spaces WHERE space_id=${spaceId} AND deleted_at IS NULL`.pipe(
          Effect.map((rows) => Option.fromNullishOr(rows[0])),
        ),
      ),
    getActiveFolderByWorkspaceRoot: (root: string) =>
      run(
        Effect.gen(function* () {
          const rows = yield* sql<{
            id: FolderId;
          }>`SELECT folder_id AS id FROM projection_folders WHERE workspace_root=${root} AND archived_at IS NULL AND deleted_at IS NULL ORDER BY created_at,folder_id LIMIT 1`;
          if (!rows[0]) return Option.none<OrchestrationFolder>();
          const shell = yield* getFolderShellById(rows[0].id);
          return Option.map(shell, (folder) =>
            Schema.decodeUnknownSync(OrchestrationFolder)({ ...folder, deletedAt: null }),
          );
        }),
      ),
    getFirstActiveThreadIdByFolderId: (folderId: FolderId) =>
      run(
        sql<{
          id: ThreadId;
        }>`SELECT id FROM threads WHERE folder_id=${folderId} AND archived_at IS NULL AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1`.pipe(
          Effect.map((rows) => Option.fromNullishOr(rows[0]?.id)),
        ),
      ),
    hasActiveProviderThread: (provider: string) =>
      run(
        sql`SELECT 1 FROM threads WHERE provider=${provider} AND (state='running' OR EXISTS (SELECT 1 FROM thread_items WHERE thread_id=threads.id AND kind='user' AND status='sending')) AND deleted_at IS NULL LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
      ),
    getCounts: () =>
      run(
        sql<{
          threadCount: number;
          folderCount: number;
        }>`SELECT (SELECT count(*) FROM threads WHERE deleted_at IS NULL) AS "threadCount",(SELECT count(*) FROM projection_folders WHERE deleted_at IS NULL) AS "folderCount"`.pipe(
          Effect.map((rows) => rows[0]!),
        ),
      ),
    countThreadMessages: (threadId: ThreadId) =>
      run(
        sql<{
          count: number;
        }>`SELECT count(*) AS count FROM thread_items WHERE thread_id=${threadId} AND kind IN ('user','text') AND (kind<>'user' OR COALESCE(json_extract(data,'$.origin._tag'),'')<>'recovery')`.pipe(
          Effect.map((rows) => rows[0]!.count),
        ),
      ),
    listFolderShellPage: (after: ProjectionFolderPageCursor | null) =>
      run(
        Effect.gen(function* () {
          const rows = yield* sql<{
            id: FolderId;
            createdAt: string;
            spaceTitle: string | null;
          }>`SELECT f.folder_id AS id,f.created_at AS "createdAt",s.name AS "spaceTitle" FROM projection_folders f LEFT JOIN projection_spaces s ON s.space_id=f.space_id WHERE f.deleted_at IS NULL AND f.archived_at IS NULL AND (${after === null ? 1 : 0}=1 OR f.created_at>${after?.createdAt ?? null} OR (f.created_at=${after?.createdAt ?? null} AND f.folder_id>${after?.folderId ?? null})) ORDER BY f.created_at,f.folder_id LIMIT 51`;
          const folders = yield* Effect.forEach(rows.slice(0, 50), (row) =>
            getFolderShellById(row.id).pipe(
              Effect.map((folder) => ({
                ...Option.getOrThrow(folder),
                spaceTitle: row.spaceTitle,
              })),
            ),
          );
          const tail = rows[49];
          return {
            folders,
            nextCursor:
              rows.length > 50 ? { createdAt: tail!.createdAt, folderId: tail!.id } : null,
          };
        }),
      ),
    listThreadShellPage: (input: ProjectionThreadShellPageInput) =>
      run(
        Effect.gen(function* () {
          const rows =
            yield* sql<RawThreadSummaryRecord>`SELECT ${sql.literal(THREAD_SUMMARY_COLUMNS)} FROM threads
        WHERE space_id=${input.spaceId} AND deleted_at IS NULL AND (${input.includeArchived ? 1 : 0}=1 OR archived_at IS NULL)
        AND (${input.threadIds === null ? 1 : 0}=1 OR id IN (SELECT value FROM json_each(${JSON.stringify(input.threadIds)})))
        AND (${input.folderId} IS NULL OR folder_id=${input.folderId}) AND (${input.provider} IS NULL OR provider=${input.provider})
        AND (${input.model} IS NULL OR model=${input.model}) AND (${input.createdBy} IS NULL OR created_by=${input.createdBy === "human" ? "user" : input.createdBy === "penkra-mcp" ? "agent" : input.createdBy})
        AND (${input.updatedAfter} IS NULL OR updated_at>=${input.updatedAfter}) AND (${input.updatedBefore} IS NULL OR updated_at<=${input.updatedBefore})
        AND (${input.titleContains} IS NULL OR instr(lower(title),lower(${input.titleContains}))>0)
        AND (${input.status} IS NULL OR CASE WHEN state='running' THEN 'working' WHEN state='error' THEN 'error' WHEN (SELECT COUNT(*) FROM thread_items q WHERE q.thread_id=threads.id AND q.kind='question' AND q.status='open')>0 THEN 'waiting-for-user-input' ELSE 'idle' END=${input.status})
        AND (${input.after === null ? 1 : 0}=1 OR updated_at<${input.after?.updatedAt ?? null} OR (updated_at=${input.after?.updatedAt ?? null} AND id>${input.after?.threadId ?? null}))
        ORDER BY updated_at DESC,id LIMIT 51`;
          const tail = rows[49];
          return {
            threads: rows.slice(0, 50).map(decodeThreadSummary).map(threadShellFromRow),
            nextCursor:
              rows.length > 50 ? { updatedAt: tail!.updatedAt, threadId: tail!.id } : null,
          };
        }),
      ),
  };
});
export type ThreadReadsShape = Effect.Success<typeof makeThreadReads>;
export class ThreadReads extends ServiceMap.Service<ThreadReads, ThreadReadsShape>()(
  "penkra/cleanCore/ThreadReads",
) {}
export const ThreadReadsLive = Layer.effect(ThreadReads, makeThreadReads);
