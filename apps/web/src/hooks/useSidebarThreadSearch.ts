// FILE: useSidebarThreadSearch.ts
// Purpose: Page server search results, discarding obsolete queries before applying rows.
// Layer: Web search controller

import {
  type CleanCoreThreadSearchCursor,
  type CleanCoreThreadSearchMatch,
  type SpaceId,
} from "@penkra/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ensureNativeApi } from "../nativeApi";
import { applyThreadRow } from "../threadListStore";
import { toastManager } from "../components/ui/toast";

type Match = Pick<CleanCoreThreadSearchMatch, "id" | "matchKind" | "messageId" | "messageText">;
type Page = {
  key: string;
  matches: readonly Match[];
  nextCursor: CleanCoreThreadSearchCursor | null;
  loading: boolean;
};

export function useSidebarThreadSearch(input: {
  spaceId: SpaceId | null;
  query: string;
  enabled: boolean;
}) {
  const key = JSON.stringify([input.spaceId, input.query, input.enabled]);
  const sessionRef = useRef<{
    active: boolean;
    loading: boolean;
    read: (cursor: CleanCoreThreadSearchCursor | null) => Promise<void>;
  } | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  useEffect(() => {
    if (!input.enabled || input.spaceId === null) return;
    const spaceId = input.spaceId;
    const session = {
      active: true,
      loading: false,
      read: async (cursor: CleanCoreThreadSearchCursor | null) => {
        if (!session.active || session.loading) return;
        session.loading = true;
        setPage((previous) => ({
          key,
          matches: previous?.key === key ? previous.matches : [],
          nextCursor: cursor,
          loading: true,
        }));
        try {
          const result = await ensureNativeApi().cleanCore.searchThreads({
            spaceId,
            query: input.query,
            cursor,
          });
          if (!session.active) return;
          const matches = result.threads.map(({ matchKind, messageId, messageText, ...thread }) => {
            applyThreadRow(thread);
            return { id: thread.id, matchKind, messageId, messageText };
          });
          setPage((previous) => ({
            key,
            matches: [
              ...(cursor !== null && previous?.key === key ? previous.matches : []),
              ...matches,
            ],
            nextCursor: result.nextCursor,
            loading: false,
          }));
        } catch (error) {
          if (!session.active) return;
          setPage((previous) => ({
            key,
            matches: previous?.key === key ? previous.matches : [],
            nextCursor: null,
            loading: false,
          }));
          toastManager.add({
            type: "error",
            title: "Could not search threads",
            description: error instanceof Error ? error.message : String(error),
          });
        } finally {
          session.loading = false;
        }
      },
    };
    sessionRef.current = session;
    void session.read(null);
    return () => {
      session.active = false;
    };
  }, [key, input.enabled, input.spaceId, input.query]);
  const current = page?.key === key ? page : null;
  const cursor = current?.nextCursor ?? null;
  const loadNextPage = useCallback(() => {
    if (cursor !== null) void sessionRef.current?.read(cursor);
  }, [cursor]);
  return {
    matches: current?.matches ?? [],
    hasNextPage: cursor !== null,
    loading: current?.loading === true,
    loadNextPage,
  };
}
