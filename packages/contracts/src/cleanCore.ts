import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TurnId } from "./baseSchemas";

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
