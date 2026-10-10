// FILE: SidebarThreadPageEnd.tsx
// Purpose: Observe the end of a sidebar or search list to load its next page.

import { useEffect, useRef } from "react";

/** Observe the end of this displayed list; no polling or timing guesses. */
export function SidebarThreadPageEnd({
  loading,
  hasNextPage,
  onLoadNextPage,
}: {
  loading: boolean;
  hasNextPage: boolean;
  onLoadNextPage: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = end.current;
    if (node === null || loading || !hasNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      onLoadNextPage();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, hasNextPage, onLoadNextPage]);
  return <div ref={end} aria-hidden="true" data-thread-page-end />;
}
