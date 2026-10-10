import {
  IsoDateTime,
  ModelSelection,
  ProviderConnectionId,
  NonNegativeInt,
  FolderId,
  RuntimeMode,
  ThreadDeckId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { Schema } from "effect";

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  deckId: ThreadDeckId,
  deckSortOrder: NonNegativeInt,
  folderId: FolderId,
  title: Schema.String,
  modelSelection: ModelSelection,
  connectionId: Schema.optional(Schema.NullOr(ProviderConnectionId)),
  runtimeMode: RuntimeMode,
  workingDirectory: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sidebarSortOrder: Schema.optional(NonNegativeInt).pipe(Schema.withDecodingDefault(() => 0)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  creationSource: Schema.optional(
    Schema.NullOr(Schema.Literals(["penkra_mcp", "provider_native"])),
  ).pipe(Schema.withDecodingDefault(() => null)),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceTurnId: Schema.optional(Schema.NullOr(TurnId)).pipe(Schema.withDecodingDefault(() => null)),
  gatewayOperationId: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  gatewayOperationIndex: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(Schema.String)),
  subagentNickname: Schema.optional(Schema.NullOr(Schema.String)),
  subagentRole: Schema.optional(Schema.NullOr(Schema.String)),
  latestTurnId: Schema.NullOr(TurnId),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  lastVisitedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  workStatus: Schema.optional(Schema.Literals(["idle", "running", "done", "attention"])).pipe(
    Schema.withDecodingDefault(() => "idle" as const),
  ),
  lastMessagePreview: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  lastActivityAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;
