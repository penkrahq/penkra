// FILE: useLoadThreadAncestors.ts
// Purpose: Read missing lineage ancestors by ID as canonical rows arrive.
// Layer: Web hooks

import { ThreadId, type CleanCoreThreadSummary } from "@penkra/contracts";
import { useEffect, useMemo } from "react";
import { loadThread } from "../threadListStore";
import { toastManager } from "../components/ui/toast";

export function useLoadThreadAncestors(
  threadId: ThreadId | null,
  rows: readonly Pick<CleanCoreThreadSummary, "id" | "parentThreadId">[],
): void {
  const missingAncestorKey = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const visited = new Set<ThreadId>();
    const missing = new Set<ThreadId>();
    let id = threadId;
    while (id !== null && !visited.has(id)) {
      visited.add(id);
      const row = byId.get(id);
      if (row === undefined) {
        missing.add(id);
        break;
      }
      id = row.parentThreadId;
    }
    return JSON.stringify([...missing].sort());
  }, [threadId, rows]);
  useEffect(() => {
    for (const id of JSON.parse(missingAncestorKey) as string[])
      void loadThread(ThreadId.makeUnsafe(id)).catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not load thread",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
  }, [missingAncestorKey]);
}
