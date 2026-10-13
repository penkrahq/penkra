// Purpose: One canonical thread-row presentation for server and browser consumers.
import {
  OrchestrationThreadShell,
  ModelSelection,
  type CleanCoreThreadSummary,
} from "@penkra/contracts";
import { Schema } from "effect";
type CanonicalShellRow = Pick<
  CleanCoreThreadSummary,
  | "id"
  | "spaceId"
  | "folderId"
  | "title"
  | "connectionId"
  | "model"
  | "modelOptions"
  | "latestTurn"
  | "openQuestionCount"
  | "lastActivityAt"
  | "lastVisitedAt"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "activeTurnId"
  | "lastError"
  | "createdByThreadId"
> & { provider: string; state: string; createdBy: string };
export const threadShellFromRow = (row: CanonicalShellRow): OrchestrationThreadShell =>
  Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id: row.id,
    spaceId: row.spaceId,
    folderId: row.folderId,
    title: row.title,
    modelSelection: Schema.decodeUnknownSync(ModelSelection)({
      provider: row.provider,
      model: row.model,
      ...(row.modelOptions === null ? {} : { options: JSON.parse(row.modelOptions) }),
    }),
    connectionId: row.connectionId,
    creationSource:
      row.createdBy === "agent"
        ? "penkra_mcp"
        : row.createdBy === "provider-native"
          ? "provider_native"
          : null,
    sourceThreadId: row.createdByThreadId,
    latestTurn:
      row.latestTurn === null
        ? null
        : {
            turnId: row.latestTurn.turnId,
            providerTurnId: null,
            state: row.latestTurn.status === "done" ? "completed" : row.latestTurn.status,
            requestedAt: row.latestTurn.startedAt,
            startedAt: row.latestTurn.startedAt,
            completedAt: row.latestTurn.endedAt,
            assistantMessageId: null,
          },
    hasPendingUserInput: row.openQuestionCount > 0,
    workStatus:
      row.state === "running"
        ? "running"
        : row.state === "error" || row.openQuestionCount > 0
          ? "attention"
          : row.lastActivityAt !== null &&
              (row.lastVisitedAt === null || row.lastActivityAt > row.lastVisitedAt)
            ? "done"
            : "idle",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    session: {
      threadId: row.id,
      status: row.state === "running" ? "running" : row.state === "error" ? "error" : "ready",
      providerName: row.provider,
      activeTurnId: row.activeTurnId,
      lastError: row.lastError,
      updatedAt: row.updatedAt,
    },
  });
