// FILE: SidebarThreadPageEnd.tsx
// Purpose: Observe the end of a sidebar or search list to load its next page.

import { useEffect, useRef } from "react";
import type { FolderId, SpaceId } from "@penkra/contracts";
import { loadNextThreadPage, threadListScopeKey, useThreadListPages } from "../threadListStore";
import { toastManager } from "./ui/toast";

/** Observe the end of this displayed list; no polling or timing guesses. */
export function SidebarThreadPageEnd(
  props:
    | { loading: boolean; onLoadNextPage: () => void }
    | { spaceId: SpaceId; folderId: FolderId | null },
) {
  const end = useRef<HTMLDivElement>(null);
  const pages = useThreadListPages();
  const page =
    "spaceId" in props ? pages.get(threadListScopeKey(props.spaceId, props.folderId)) : null;
  useEffect(() => {
    const node = end.current;
    if (node === null) return;
    if (
      "spaceId" in props
        ? page === undefined || page === null || page.loading || page.nextCursor === null
        : props.loading
    )
      return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      if ("onLoadNextPage" in props) {
        props.onLoadNextPage();
      } else {
        void loadNextThreadPage({ spaceId: props.spaceId, folderId: props.folderId }).catch(
          (error: unknown) =>
            toastManager.add({
              type: "error",
              title: "Could not load threads",
              description: error instanceof Error ? error.message : String(error),
            }),
        );
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [props, page]);
  return (
    <div
      ref={end}
      aria-hidden="true"
      data-thread-page-end={"folderId" in props ? props.folderId : "search"}
    />
  );
}
