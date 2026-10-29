// FILE: DesktopThreadApiBridge.tsx
// Purpose: Project shell Thread state to hosted Apps; commands execute in the backend.

import type { AppThreadState } from "@penkra/sdk";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FolderId, ThreadId } from "@penkra/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  getDesktopThreadLiveHandlers,
  subscribeDesktopThreadLiveStateChanges,
} from "../desktopThreadApiBroker";
import { useStore } from "../store";
import { getThreadList, getThreadListById, subscribeThreadList } from "../threadListStore";
import { sortThreadsForSidebar } from "./Sidebar.logic";

export function folderStates(folderId: FolderId): ReadonlyArray<AppThreadState> {
  const rows = sortThreadsForSidebar(
    getThreadList().filter(
      (row) => row.folderId === folderId && row.archivedAt === null && row.deletedAt === null,
    ),
    "created_at",
  );
  const drafts = useComposerDraftStore.getState().draftsByThreadId;
  return rows.flatMap((row, index) => {
    const threadId = row.id;
    const draft = drafts[threadId];
    const live = getDesktopThreadLiveHandlers(threadId)?.read();
    const queuedCount = (JSON.parse(row.queue) as unknown[]).length;
    const hasDraft =
      !!draft &&
      Boolean(
        draft.prompt ||
        draft.files.length ||
        draft.images.length ||
        draft.pastedTexts.length ||
        draft.skills.length,
      );
    return [
      {
        threadId,
        folderId,
        title: row.title,
        order: index,
        archived: row.archivedAt != null,
        phase:
          live?.phase ??
          (row.openQuestionCount > 0
            ? "waiting"
            : row.state === "running"
              ? "running"
              : row.state === "error"
                ? "failed"
                : "idle"),
        activeTurnId: live === undefined ? row.activeTurnId : live.activeTurnId,
        pendingQuestion: live?.pendingUserInput ?? row.openQuestionCount > 0,
        composer: {
          empty: !hasDraft,
          owner: hasDraft ? ("human" as const) : ("none" as const),
          composeId: null,
        },
        queued: {
          count: live?.queuedCount ?? queuedCount,
          hasAppSubmission: false,
        },
        updatedAt: row.updatedAt,
      },
    ];
  });
}

function sameThreadStates(
  left: ReadonlyArray<AppThreadState>,
  right: ReadonlyArray<AppThreadState>,
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        item.threadId === other.threadId &&
        item.folderId === other.folderId &&
        item.title === other.title &&
        item.order === other.order &&
        item.archived === other.archived &&
        item.phase === other.phase &&
        item.activeTurnId === other.activeTurnId &&
        item.pendingQuestion === other.pendingQuestion &&
        item.updatedAt === other.updatedAt &&
        item.composer.empty === other.composer.empty &&
        item.composer.owner === other.composer.owner &&
        item.composer.composeId === other.composer.composeId &&
        item.queued.count === other.queued.count &&
        item.queued.hasAppSubmission === other.queued.hasAppSubmission
      );
    })
  );
}

export function DesktopThreadApiBridge() {
  const navigate = useNavigate();
  useEffect(
    () =>
      window.desktopBridge?.threadHome?.onSelect(({ threadId }) => {
        void navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.make(threadId) },
          search: () => ({}),
        });
      }),
    [navigate],
  );
  useEffect(() => {
    const bridge = window.desktopBridge?.threadApi;
    if (!bridge) return;
    let disposed = false;
    let scheduled = false;
    const published = new Map<
      string,
      { spaceId: string; threads: ReadonlyArray<AppThreadState> }
    >();
    const dirtyFolders = new Set<string>();
    let previousRows = getThreadListById();
    const schedule = (folderId: string | null | undefined) => {
      if (!folderId || disposed) return;
      dirtyFolders.add(folderId);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(publish);
    };
    const publish = () => {
      scheduled = false;
      if (disposed) return;
      const folders = new Map(
        useStore.getState().folders.map((folder) => [folder.id as string, folder]),
      );
      const dirty = [...dirtyFolders];
      dirtyFolders.clear();
      for (const folderId of dirty) {
        const folder = folders.get(folderId);
        if (!folder) {
          published.delete(folderId);
          continue;
        }
        try {
          const threads = folderStates(folder.id);
          const previous = published.get(folder.id);
          if (previous?.spaceId === folder.spaceId && sameThreadStates(previous.threads, threads))
            continue;
          bridge.publishState({ spaceId: folder.spaceId, folderId: folder.id, threads });
          published.set(folder.id, { spaceId: folder.spaceId, threads });
        } catch (error) {
          console.error("Failed to publish App thread state for folder", folder.id, error);
        }
      }
    };
    const unsubscribeStore = useStore.subscribe((state, previous) => {
      if (state.folders === previous.folders) return;
      const before = new Map(previous.folders.map((folder) => [folder.id as string, folder]));
      const after = new Map(state.folders.map((folder) => [folder.id as string, folder]));
      for (const [id, folder] of after) {
        if (!before.has(id) || before.get(id)?.spaceId !== folder.spaceId) schedule(id);
      }
      for (const id of before.keys()) if (!after.has(id)) schedule(id);
    });
    const unsubscribeThreads = subscribeThreadList(() => {
      const next = getThreadListById();
      if (next === previousRows) return;
      for (const [id, row] of next) {
        const old = previousRows.get(id);
        if (old !== row) {
          schedule(old?.folderId);
          schedule(row.folderId);
        }
      }
      for (const [id, old] of previousRows) if (!next.has(id)) schedule(old.folderId);
      previousRows = next;
    });
    const unsubscribeDrafts = useComposerDraftStore.subscribe((state, previous) => {
      const next = state.draftsByThreadId;
      const before = previous.draftsByThreadId;
      if (next === before) return;
      const rows = getThreadListById();
      for (const id of new Set([...Object.keys(before), ...Object.keys(next)])) {
        const threadId = ThreadId.make(id);
        if (before[threadId] !== next[threadId]) schedule(rows.get(id)?.folderId);
      }
    });
    const unsubscribeLive = subscribeDesktopThreadLiveStateChanges((threadId) => {
      schedule(getThreadListById().get(threadId)?.folderId);
    });
    for (const folder of useStore.getState().folders) schedule(folder.id);
    return () => {
      disposed = true;
      unsubscribeStore();
      unsubscribeThreads();
      unsubscribeDrafts();
      unsubscribeLive();
    };
  }, []);
  return null;
}
