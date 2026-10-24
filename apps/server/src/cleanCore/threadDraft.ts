// FILE: threadDraft.ts
// Purpose: The clean-core composer draft (0.14.4 design 2.6): one draft per
// thread on threads.draft, last write wins by draft_updated_at.
// Layer: Server clean core
// Exports: ThreadDraft, getThreadDraft, setThreadDraft

import { Effect, Schema } from "effect";
import {
  ModelSelection,
  RuntimeMode,
  ProviderKind,
  ProviderConnectionId,
  type CleanCoreSendMessageInput,
} from "@penkra/contracts";
import * as SqlClient from "effect/sql/SqlClient";

import { updateThreadDraft, type ThreadPublisher } from "./threadStore.ts";

export interface ThreadDraft {
  readonly draft: string | null;
  readonly draftUpdatedAt: string | null;
}

export const getThreadDraft = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly draft: string | null; readonly updatedAt: string | null }>`
      SELECT draft, draft_updated_at AS "updatedAt" FROM threads WHERE id = ${threadId}
    `;
    return {
      draft: rows[0]?.draft ?? null,
      draftUpdatedAt: rows[0]?.updatedAt ?? null,
    } satisfies ThreadDraft;
  });

/**
 * Saves the draft; a write older than the stored draft_updated_at is ignored
 * (last write wins), so windows cannot clobber each other out of order.
 */
export const setThreadDraft = (
  publisher: ThreadPublisher,
  threadId: string,
  draft: string | null,
  updatedAt: string,
) =>
  Effect.gen(function* () {
    yield* updateThreadDraft(threadId, draft, updatedAt);
    // Other windows showing this thread update live.
    publisher.publish({ threadId });
    return yield* getThreadDraft(threadId);
  });

export const DraftSelection = Schema.Struct({
  runtimeMode: Schema.optionalKey(RuntimeMode),
  modelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  connectionSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(Schema.NullOr(ProviderConnectionId))),
  ),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
});

/** Consuming composer content keeps its selection for the next queue delivery. */
export function draftAfterSend(
  draft: string | null,
  provider: string,
  selection:
    | Pick<CleanCoreSendMessageInput, "modelSelection" | "connectionId" | "runtimeMode">
    | undefined,
): string | null {
  const current = draft === null ? {} : Schema.decodeUnknownSync(DraftSelection)(JSON.parse(draft));
  const modelSelectionByProvider = { ...current.modelSelectionByProvider };
  const connectionSelectionByProvider = { ...current.connectionSelectionByProvider };
  const harness = Schema.decodeUnknownSync(ProviderKind)(provider);
  if (selection?.modelSelection !== undefined)
    modelSelectionByProvider[harness] = selection.modelSelection;
  if (selection?.connectionId !== undefined)
    connectionSelectionByProvider[harness] = selection.connectionId;
  const activeProvider = selection?.modelSelection?.provider ?? current.activeProvider;
  if (
    Object.keys(modelSelectionByProvider).length === 0 &&
    Object.keys(connectionSelectionByProvider).length === 0 &&
    activeProvider == null &&
    current.runtimeMode === undefined &&
    selection?.runtimeMode === undefined
  )
    return null;
  return JSON.stringify({
    prompt: "",
    attachments: [],
    files: [],
    modelSelectionByProvider,
    connectionSelectionByProvider,
    ...(activeProvider === undefined ? {} : { activeProvider }),
    ...((selection?.runtimeMode ?? current.runtimeMode)
      ? { runtimeMode: selection?.runtimeMode ?? current.runtimeMode }
      : {}),
  });
}

/** Snapshot the selection when a message leaves the draft or queue. */
export function resolveDraftSendSelection(
  row: {
    draft: string | null;
    provider: string;
    model: string;
    modelOptions: string | null;
    connectionId: typeof ProviderConnectionId.Type | null;
    runtimeMode: string;
  },
  requested: Pick<
    CleanCoreSendMessageInput,
    "modelSelection" | "connectionId" | "runtimeMode"
  > = {},
) {
  const provider = Schema.decodeUnknownSync(ProviderKind)(row.provider);
  const draft =
    row.draft === null ? {} : Schema.decodeUnknownSync(DraftSelection)(JSON.parse(row.draft));
  const modelSelection =
    requested.modelSelection ??
    draft.modelSelectionByProvider?.[provider] ??
    Schema.decodeUnknownSync(ModelSelection)({
      provider,
      model: row.model,
      ...(row.modelOptions === null ? {} : { options: JSON.parse(row.modelOptions) }),
    });
  const draftConnection = draft.connectionSelectionByProvider?.[modelSelection.provider];
  const connectionId =
    requested.connectionId !== undefined
      ? requested.connectionId
      : draftConnection !== undefined
        ? draftConnection
        : row.connectionId;
  return {
    modelSelection,
    connectionId,
    runtimeMode: Schema.decodeUnknownSync(RuntimeMode)(
      requested.runtimeMode ?? draft.runtimeMode ?? row.runtimeMode,
    ),
  };
}
