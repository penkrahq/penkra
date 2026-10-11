// FILE: storeSelectors.ts
// Purpose: Stable Zustand selectors for entity lookups and lightweight sidebar projections.
// Exports: Selector factories used by routes and sidebar-heavy components.

import { Schema } from "effect";
import { ProviderKind, type CleanCoreThreadSummary } from "@penkra/contracts";

import type { FolderId, ThreadId } from "@penkra/contracts";

import type { AppState } from "./storeState";
import { collectByIds, getThreadFromState, getThreadsFromState } from "./threadDerivation";
import type {
  ComposerThreadMentionSource,
  Project,
  SidebarThreadSummary,
  Thread,
  ThreadShell,
} from "./types";

const EMPTY_THREAD_SHELLS: ThreadShell[] = [];

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

/** Shell-only projection of all threads, in `threadIds` order.
 *
 *  It reads only `threadIds` + `threadShellById`, so it never rebuilds for message/activity
 *  *content* changes — but it is NOT fully stable while a turn streams: `ThreadShell.updatedAt`
 *  is part of the shell, and `threadShellsEqual` compares it, so every delta that advances
 *  `updatedAt` writes a new shell and yields a new array here. That comparison has to stay:
 *  the shell is where `updatedAt` lives, and the sidebar both sorts by it
 *  (`components/Sidebar.logic.ts`) and renders it (`components/SidebarSearchPalette.tsx`).
 *
 */
export function createThreadShellsSelector(): (state: AppState) => readonly ThreadShell[] {
  return (state) => collectByIds(state.threadIds, state.threadShellById, EMPTY_THREAD_SHELLS);
}

/** True when no known thread has any messages (vacuously true with zero threads).
 *  Reads message id lists only, so streaming content updates do not invalidate it. */
export function createAllThreadsMessagelessSelector(): (state: AppState) => boolean {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousMessageIdsByThreadId: AppState["messageIdsByThreadId"] | undefined;
  let previousResult = true;

  return (state) => {
    if (
      previousThreadIds === state.threadIds &&
      previousMessageIdsByThreadId === state.messageIdsByThreadId
    ) {
      return previousResult;
    }

    previousThreadIds = state.threadIds;
    previousMessageIdsByThreadId = state.messageIdsByThreadId;
    previousResult = (state.threadIds ?? []).every(
      (threadId) => (state.messageIdsByThreadId?.[threadId]?.length ?? 0) === 0,
    );
    return previousResult;
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
