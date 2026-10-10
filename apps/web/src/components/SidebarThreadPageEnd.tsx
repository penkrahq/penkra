import { useEffect, useRef } from "react";
import type { FolderId, SpaceId } from "@penkra/contracts";
import { loadNextThreadPage, threadListScopeKey, useThreadListPages } from "../threadListStore";
import { toastManager } from "./ui/toast";

/** Observe the end of this displayed list; no polling or timing guesses. */
export function SidebarThreadPageEnd({
  spaceId,
  folderId,
}: {
  spaceId: SpaceId;
  folderId: FolderId | null;
}) {
  const end = useRef<HTMLDivElement>(null);
  const page = useThreadListPages().get(threadListScopeKey(spaceId, folderId));
  useEffect(() => {
    const node = end.current;
    if (node === null || page === undefined || page.loading || page.nextCursor === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void loadNextThreadPage({ spaceId, folderId }).catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not load threads",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [spaceId, folderId, page]);
  return <div ref={end} aria-hidden="true" data-thread-page-end={folderId} />;
}
