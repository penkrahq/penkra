import {
  IsoDateTime,
  ModelSelection,
  ProviderConnectionId,
  NonNegativeInt,
  FolderId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { Effect, Schema } from "effect";

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  folderId: FolderId,
  title: Schema.String,
  modelSelection: ModelSelection,
  connectionId: Schema.optional(Schema.NullOr(ProviderConnectionId)),
  creationSource: Schema.optional(
    Schema.NullOr(Schema.Literals(["penkra_mcp", "provider_native"])),
  ).pipe(Schema.withDecodingDefault(Effect.sync(() => null))),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  sourceTurnId: Schema.optional(Schema.NullOr(TurnId)).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  gatewayOperationId: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  gatewayOperationIndex: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(Schema.String)),
  subagentNickname: Schema.optional(Schema.NullOr(Schema.String)),
  subagentRole: Schema.optional(Schema.NullOr(Schema.String)),
  latestTurnId: Schema.NullOr(TurnId),
  pendingUserInputCount: NonNegativeInt,
  workStatus: Schema.optional(Schema.Literals(["idle", "running", "done", "attention"])).pipe(
    Schema.withDecodingDefault(Effect.sync(() => "idle" as const)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;
