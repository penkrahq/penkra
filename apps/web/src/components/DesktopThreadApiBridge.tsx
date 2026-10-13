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
import { deriveUnmountedThreadLiveState } from "../lib/desktopThreadState";
import { useStore } from "../store";
import { getThreadList, subscribeThreadList } from "../threadListStore";
import { sortThreadsForSidebar } from "./Sidebar.logic";

function folderStates(folderId: FolderId): ReadonlyArray<AppThreadState> {
  const state = useStore.getState();
  const rows = sortThreadsForSidebar(
    getThreadList().filter(
      (row) => row.folderId === folderId && row.archivedAt === null && row.deletedAt === null,
    ),
    "created_at",
  );
  const drafts = useComposerDraftStore.getState().draftsByThreadId;
  const queuedCountForThread = (threadId: ThreadId) => {
    const row = rows.find((row) => row.id === threadId);
    return row === undefined ? 0 : (JSON.parse(row.queue) as unknown[]).length;
  };
  return rows.flatMap((row, index) => {
    const threadId = row.id;
    const draft = drafts[threadId];
    const live =
      getDesktopThreadLiveHandlers(threadId)?.read() ??
      deriveUnmountedThreadLiveState(
        threadId,
        state.sidebarThreadSummaryById[threadId],
        queuedCountForThread(threadId),
      );
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
          (row.openQuestionCount > 0 ? "waiting" : row.state === "running" ? "running" : "idle"),
        activeTurnId:
          live?.activeTurnId ?? state.threadSessionById?.[threadId]?.activeTurnId ?? null,
        pendingQuestion: live?.pendingUserInput ?? row.openQuestionCount > 0,
        composer: {
          empty: !hasDraft,
          owner: hasDraft ? ("human" as const) : ("none" as const),
          composeId: null,
        },
        queued: {
          count: live?.queuedCount ?? queuedCountForThread(threadId),
          hasAppSubmission: false,
        },
        updatedAt: row.updatedAt,
      },
    ];
  });
}

export function DesktopThreadApiBridge() {
  const navigate = useNavigate();
  useEffect(
    () =>
      window.desktopBridge?.threadHome?.onSelect(({ threadId }) => {
        void navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.makeUnsafe(threadId) },
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
    const fingerprints = new Map<string, string>();
    const publish = () => {
      scheduled = false;
      if (disposed) return;
      for (const folder of useStore.getState().folders) {
        const threads = folderStates(folder.id);
        const fingerprint = JSON.stringify(threads);
        if (fingerprints.get(folder.id) === fingerprint) continue;
        fingerprints.set(folder.id, fingerprint);
        bridge.publishState({ spaceId: folder.spaceId, folderId: folder.id, threads });
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
