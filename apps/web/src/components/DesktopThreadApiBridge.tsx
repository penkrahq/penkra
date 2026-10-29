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
import { getThreadList, subscribeThreadList } from "../threadListStore";
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
    const publish = () => {
      scheduled = false;
      if (disposed) return;
      for (const folder of useStore.getState().folders) {
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
    const schedule = () => {
      if (scheduled || disposed) return;
      scheduled = true;
      queueMicrotask(publish);
    };
    const unsubscribeStore = useStore.subscribe(schedule);
    const unsubscribeThreads = subscribeThreadList(schedule);
    const unsubscribeDrafts = useComposerDraftStore.subscribe(schedule);
    const unsubscribeLive = subscribeDesktopThreadLiveStateChanges(schedule);
    schedule();
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
