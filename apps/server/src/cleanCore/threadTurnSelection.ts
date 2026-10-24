import { randomUUID } from "node:crypto";
import type {
  ModelSelection,
  ProviderConnectionId,
  ThreadId,
  RuntimeMode,
} from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { upsertThreadItem } from "./threadStore.ts";
import { threadItemActivityData } from "./threadItemData.ts";

/** Called inside turn admission's transaction, after copying any native state. */
export const commitThreadTurnSelection = (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection | undefined;
  readonly connectionId: ProviderConnectionId | null | undefined;
  readonly nativeState:
    | { readonly id: string; readonly providerSessionId: string | null }
    | undefined;
  readonly runtimeMode?: RuntimeMode;
  readonly updatedAt: string;
  readonly deliveryMessageId: string;
  readonly connectionLabel: string | null;
  readonly modelLabel: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [previous] = yield* sql<{
      connectionId: string | null;
      model: string | null;
    }>`SELECT connection_id AS "connectionId",model FROM threads WHERE id=${input.threadId}`;
    const priorTurns =
      yield* sql`SELECT 1 FROM thread_items WHERE thread_id=${input.threadId} AND kind='turn' LIMIT 1`;
    yield* sql`UPDATE threads SET
    runtime_mode = CASE WHEN ${Number(input.runtimeMode !== undefined)} THEN ${input.runtimeMode ?? null} ELSE runtime_mode END,
    connection_id = CASE WHEN ${Number(input.connectionId !== undefined)} THEN ${input.connectionId ?? null} ELSE connection_id END,
    model = CASE WHEN ${Number(input.modelSelection !== undefined)} THEN ${input.modelSelection?.model ?? null} ELSE model END,
    model_options = CASE WHEN ${Number(input.modelSelection !== undefined)} THEN ${input.modelSelection?.options === undefined ? null : JSON.stringify(input.modelSelection.options)} ELSE model_options END,
    native_state_id = CASE WHEN ${Number(input.nativeState !== undefined)} THEN ${input.nativeState?.id ?? null} ELSE native_state_id END,
    provider_session_id = CASE WHEN ${Number(input.nativeState !== undefined)} THEN ${input.nativeState?.providerSessionId ?? null} ELSE provider_session_id END,
    updated_at = ${input.updatedAt}
    WHERE id = ${input.threadId}`;
    if (!previous || !priorTurns.length) return;
    const changes: Array<{ kind: string; summary: string }> = [];
    if (input.connectionId != null && input.connectionId !== previous.connectionId)
      changes.push({
        kind: "connection-changed",
        summary: `Connection changed to ${input.connectionLabel}`,
      });
    if (
      previous.model !== null &&
      input.modelSelection !== undefined &&
      input.modelSelection.model !== previous.model
    )
      changes.push({ kind: "model-changed", summary: `Model changed to ${input.modelLabel}` });
    for (const change of changes)
      yield* upsertThreadItem({
        threadId: input.threadId,
        sourceId: `selection:${randomUUID()}`,
        kind: "notice",
        status: "done",
        text: change.summary,
        data: threadItemActivityData({
          tone: "info",
          ...change,
          payload: {},
          anchor: { messageId: input.deliveryMessageId },
        }),
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
      });
  });
