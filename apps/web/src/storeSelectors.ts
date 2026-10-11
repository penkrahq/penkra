// FILE: storeSelectors.ts
// Purpose: Stable Zustand selectors for entity lookups and lightweight sidebar projections.
// Exports: Selector factories used by routes and sidebar-heavy components.

import { Schema } from "effect";
import { ProviderKind, type CleanCoreThreadSummary } from "@penkra/contracts";

import type { FolderId, ThreadId } from "@penkra/contracts";

import type { AppState } from "./storeState";
import { getThreadFromState, getThreadsFromState } from "./threadDerivation";
import type { ComposerThreadMentionSource, Project, Thread } from "./types";

function createStableEntitySelector<T extends { id: string }>(
  selectItems: (state: AppState) => readonly T[],
  id: string | null | undefined,
): (state: AppState) => T | undefined {
  let previousItems: readonly T[] | undefined;
  let previousMatch: T | undefined;

  return (state) => {
    if (!id) {
      return undefined;
    }

    const items = selectItems(state);
    if (items === previousItems) {
      return previousMatch;
    }

    previousItems = items;
    previousMatch = items.find((item) => item.id === id);
    return previousMatch;
  };
}

export function createProjectSelector(
  folderId: FolderId | null | undefined,
): (state: AppState) => Project | undefined {
  return createStableEntitySelector((state) => state.folders, folderId);
}

export function createThreadSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  return (state) => (threadId ? getThreadFromState(state, threadId) : undefined);
}

export function createAllThreadsSelector(): (state: AppState) => readonly Thread[] {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousThreadShellById = {} as AppState["threadShellById"];
  let previousThreadSessionById = {} as AppState["threadSessionById"];
  let previousThreadTurnStateById = {} as AppState["threadTurnStateById"];
  let previousMessageIdsByThreadId = {} as AppState["messageIdsByThreadId"];
  let previousMessageByThreadId = {} as AppState["messageByThreadId"];
  let previousActivityIdsByThreadId = {} as AppState["activityIdsByThreadId"];
  let previousActivityByThreadId = {} as AppState["activityByThreadId"];
  let previousThreads: readonly Thread[] = [];

  return (state) => {
    if (
      previousThreadIds === state.threadIds &&
      previousThreadShellById === state.threadShellById &&
      previousThreadSessionById === state.threadSessionById &&
      previousThreadTurnStateById === state.threadTurnStateById &&
      previousMessageIdsByThreadId === state.messageIdsByThreadId &&
      previousMessageByThreadId === state.messageByThreadId &&
      previousActivityIdsByThreadId === state.activityIdsByThreadId &&
      previousActivityByThreadId === state.activityByThreadId
    ) {
      return previousThreads;
    }

    previousThreadIds = state.threadIds;
    previousThreadShellById = state.threadShellById;
    previousThreadSessionById = state.threadSessionById;
    previousThreadTurnStateById = state.threadTurnStateById;
    previousMessageIdsByThreadId = state.messageIdsByThreadId;
    previousMessageByThreadId = state.messageByThreadId;
    previousActivityIdsByThreadId = state.activityIdsByThreadId;
    previousActivityByThreadId = state.activityByThreadId;
    previousThreads = getThreadsFromState(state);
    return previousThreads;
  };
}

export function createThreadFolderIdSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => FolderId | null {
  return (state) => {
    if (!threadId) {
      return null;
    }
    return state.threadShellById?.[threadId]?.folderId ?? null;
  };
}

export function createThreadExistsSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => boolean {
  return (state) => (threadId ? Boolean(state.threadShellById?.[threadId]) : false);
}

export function isPersistedThreadOpenable(
  state: Pick<AppState, "threadShellById">,
  threadId: ThreadId,
): boolean {
  const shell = state.threadShellById?.[threadId];
  return shell !== undefined && shell.archivedAt == null;
}

export function createComposerThreadMentionSourcesSelector(): (
  rows: readonly CleanCoreThreadSummary[],
) => readonly ComposerThreadMentionSource[] {
  let previousRows: readonly CleanCoreThreadSummary[] | undefined;
  let previousSources: readonly ComposerThreadMentionSource[] = [];
  return (rows) => {
    if (rows === previousRows) return previousSources;
    previousRows = rows;
    previousSources = rows
      .filter((row) => row.deletedAt === null)
      .map((row) => ({
        id: row.id,
        folderId: row.folderId,
        title: row.title,
        provider: Schema.decodeUnknownSync(ProviderKind)(row.provider),
        createdAt: row.createdAt,
        archivedAt: row.archivedAt,
        latestUserMessageAt: row.lastUserMessageAt,
        lastVisitedAt: row.lastVisitedAt === null ? undefined : row.lastVisitedAt,
      }));
    return previousSources;
  };
}

export function createFirstProjectSelector(): (state: AppState) => Project | undefined {
  let previousFolders: readonly Project[] | undefined;
  let previousFirstProject: Project | undefined;

  return (state) => {
    if (state.folders === previousFolders) {
      return previousFirstProject;
    }

    previousFolders = state.folders;
    previousFirstProject = state.folders[0];
    return previousFirstProject;
  };
}
