// FILE: storeSelectors.ts
// Purpose: Stable Zustand selectors for entity lookups and lightweight sidebar projections.
// Exports: Selector factories used by routes and sidebar-heavy components.

import type { FolderId, ThreadId } from "@penkra/contracts";

import type { AppState } from "./storeState";
import { resolveThreadDisplayProvider } from "./lib/threadDisplayProvider";
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

export function createSidebarThreadSummariesSelector(): (
  state: AppState,
) => readonly SidebarThreadSummary[] {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousSummaryById: Record<string, SidebarThreadSummary> | undefined;
  let previousSummaries: readonly SidebarThreadSummary[] = [];

  return (state) => {
    const threadIds = state.threadIds;
    if (threadIds === previousThreadIds && state.sidebarThreadSummaryById === previousSummaryById) {
      return previousSummaries;
    }

    previousThreadIds = threadIds;
    previousSummaryById = state.sidebarThreadSummaryById;
    previousSummaries = (threadIds ?? []).flatMap((threadId) => {
      const summary = state.sidebarThreadSummaryById[threadId];
      return summary ? [summary] : [];
    });
    return previousSummaries;
  };
}

export function createComposerThreadMentionSourcesSelector(): (
  state: AppState,
) => readonly ComposerThreadMentionSource[] {
  let previousThreadIds: AppState["threadIds"] | undefined;
  let previousSummaryById: AppState["threadShellById"] | undefined;
  let previousSources: readonly ComposerThreadMentionSource[] = [];

  return (state) => {
    const threadIds = state.threadIds;
    const summaryById = state.threadShellById;
    if (threadIds === previousThreadIds && summaryById === previousSummaryById) {
      return previousSources;
    }
    previousThreadIds = threadIds;
    previousSummaryById = summaryById;

    const nextSources = (threadIds ?? []).flatMap((threadId) => {
      const thread = summaryById?.[threadId];
      return thread
        ? [
            {
              id: thread.id,
              folderId: thread.folderId,
              title: thread.title,
              provider: resolveThreadDisplayProvider(thread),
              createdAt: thread.createdAt,
              latestUserMessageAt: thread.latestUserMessageAt ?? null,
              ...(thread.archivedAt !== undefined ? { archivedAt: thread.archivedAt } : {}),
              ...(thread.lastVisitedAt !== undefined
                ? { lastVisitedAt: thread.lastVisitedAt }
                : {}),
            } satisfies ComposerThreadMentionSource,
          ]
        : [];
    });
    if (
      nextSources.length === previousSources.length &&
      nextSources.every((source, index) => {
        const previous = previousSources[index];
        return (
          source.id === previous?.id &&
          source.folderId === previous.folderId &&
          source.title === previous.title &&
          source.provider === previous.provider &&
          source.createdAt === previous.createdAt &&
          source.archivedAt === previous.archivedAt &&
          source.lastVisitedAt === previous.lastVisitedAt &&
          source.latestUserMessageAt === previous.latestUserMessageAt
        );
      })
    ) {
      return previousSources;
    }
    previousSources = nextSources;
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
