// FILE: threadSummary.ts
// Purpose: Share the canonical thread row schema with clean-core reads and startup snapshots.

import { Schema } from "effect";
import {
  ThreadId,
  SpaceId,
  FolderId,
  ProviderConnectionId,
  TurnId,
  IsoDateTime,
  NonNegativeInt,
} from "./baseSchemas";

export const CleanCoreLatestTurn = Schema.Struct({
  turnId: TurnId,
  status: Schema.Literals(["running", "done", "interrupted", "error"]),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type CleanCoreLatestTurn = typeof CleanCoreLatestTurn.Type;

export const CleanCoreThreadSummary = Schema.Struct({
  id: ThreadId,
  spaceId: SpaceId,
  folderId: FolderId,
  title: Schema.String,
  provider: Schema.String,
  connectionId: Schema.NullOr(ProviderConnectionId),
  model: Schema.String,
  modelOptions: Schema.NullOr(Schema.String),
  runtimeMode: Schema.String,
  state: Schema.String,
  activeTurnId: Schema.NullOr(TurnId),
  latestTurn: Schema.NullOr(CleanCoreLatestTurn),
  lastError: Schema.NullOr(Schema.String),
  queue: Schema.String,
  createdBy: Schema.String,
  createdByThreadId: Schema.NullOr(ThreadId),
  sidebarSortOrder: Schema.NullOr(Schema.Number),
  lastActivityAt: Schema.NullOr(IsoDateTime),
  lastMessagePreview: Schema.NullOr(Schema.String),
  lastUserMessageAt: Schema.NullOr(IsoDateTime),
  lastVisitedAt: Schema.NullOr(IsoDateTime),
  openQuestionCount: NonNegativeInt,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CleanCoreThreadSummary = typeof CleanCoreThreadSummary.Type;
