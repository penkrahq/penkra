import type {
  FolderId,
  MessageId,
  SpaceId,
  ThreadId,
  TurnId,
  ProviderKind,
} from "@penkra/contracts";
export type ProjectionTranscriptSearchOrder = "recent" | "oldest";

export interface ProjectionTranscriptSearchAnchor {
  readonly createdAt: string;
  readonly threadId: string;
  readonly messageId: string;
}

export interface ProjectionTranscriptSearchInput {
  readonly spaceId: SpaceId;
  readonly folderId: FolderId | null;
  readonly threadId: ThreadId | null;
  readonly queries: ReadonlyArray<string>;
  readonly queryMode: "any" | "all";
  readonly roles?: ReadonlyArray<string>;
  readonly turnId?: TurnId;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly order: ProjectionTranscriptSearchOrder;
  readonly anchor?: ProjectionTranscriptSearchAnchor;
}

export interface ProjectionTranscriptSearchMessage {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly turnId: TurnId | null;
  readonly role: string;
  readonly threadTitle: string;
  readonly threadProvider: ProviderKind;
  readonly text: string;
  readonly createdAt: string;
}

export interface ProjectionTranscriptSearchResult {
  readonly messages: ReadonlyArray<ProjectionTranscriptSearchMessage>;
  readonly hasMore: boolean;
  readonly path: "indexed" | "short-query-fallback";
}

export interface ProjectionThreadMessageContextInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly beforeTurns: number;
  readonly afterTurns: number;
}

export interface ProjectionFolderPageCursor {
  readonly createdAt: string;
  readonly folderId: FolderId;
}

export interface ProjectionThreadShellPageInput {
  readonly spaceId: SpaceId;
  readonly threadIds: ReadonlyArray<string> | null;
  readonly folderId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly createdBy: string | null;
  readonly updatedAfter: string | null;
  readonly updatedBefore: string | null;
  readonly titleContains: string | null;
  readonly status: string | null;
  readonly includeArchived: boolean;
  readonly after: { readonly updatedAt: string; readonly threadId: string } | null;
}
