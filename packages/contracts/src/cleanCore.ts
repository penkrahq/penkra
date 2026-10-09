import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TurnId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderUserInputAnswers } from "./orchestration";

/** Clean-core bounded transcript read (0.14.4 design 2.1). */
export const CleanCoreListThreadItemsPageInput = Schema.Struct({
  threadId: ThreadId,
  beforeSeq: Schema.optional(NonNegativeInt),
});
export type CleanCoreListThreadItemsPageInput = typeof CleanCoreListThreadItemsPageInput.Type;

export const CleanCoreThreadItem = Schema.Struct({
  threadId: ThreadId,
  seq: NonNegativeInt,
  sourceId: Schema.String,
  turnId: Schema.NullOr(TurnId),
  kind: Schema.String,
  status: Schema.String,
  text: Schema.NullOr(Schema.String),
  data: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CleanCoreThreadItem = typeof CleanCoreThreadItem.Type;

export const CleanCoreListThreadItemsPageResult = Schema.Struct({
  items: Schema.Array(CleanCoreThreadItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type CleanCoreListThreadItemsPageResult = typeof CleanCoreListThreadItemsPageResult.Type;

/** One composer draft per thread (0.14.4 design 2.6). */
export const CleanCoreThreadDraft = Schema.Struct({
  draft: Schema.NullOr(Schema.String),
  draftUpdatedAt: Schema.NullOr(IsoDateTime),
});
export type CleanCoreThreadDraft = typeof CleanCoreThreadDraft.Type;

export const CleanCoreGetThreadDraftInput = Schema.Struct({
  threadId: ThreadId,
});
export type CleanCoreGetThreadDraftInput = typeof CleanCoreGetThreadDraftInput.Type;

export const CleanCoreSetThreadDraftInput = Schema.Struct({
  threadId: ThreadId,
  draft: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type CleanCoreSetThreadDraftInput = typeof CleanCoreSetThreadDraftInput.Type;

/** Live thread change signal for the push channel (0.14.4 design 2.2). */
export const CleanCoreThreadChange = Schema.Struct({ threadId: ThreadId });
export type CleanCoreThreadChange = typeof CleanCoreThreadChange.Type;

export const CleanCoreSubscribeThreadInput = Schema.Struct({ threadId: ThreadId });
export type CleanCoreSubscribeThreadInput = typeof CleanCoreSubscribeThreadInput.Type;

/**
 * A clean-core answer to an open `question` item (0.14.4 design 2.5). The item
 * row is updated in place by the provider stream consumer; this call delivers
 * the answer to the provider so the turn continues.
 */
export const CleanCoreAnswerThreadQuestionInput = Schema.Struct({
  threadId: ThreadId,
  requestId: Schema.String,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  answers: ProviderUserInputAnswers,
});
export type CleanCoreAnswerThreadQuestionInput = typeof CleanCoreAnswerThreadQuestionInput.Type;

/** Push channels for the clean-core live updates. */
export const CLEAN_CORE_WS_CHANNELS = {
  threadChange: "cleanCore.threadChange",
} as const;
