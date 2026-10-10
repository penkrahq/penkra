// Canonical sidebar fields are derived only from threads rows, never projection rollups.
import {
  ModelSelection,
  RuntimeMode,
  type CleanCoreThreadSummary,
  type ThreadDeckId,
  type ThreadId,
} from "@penkra/contracts";
import { Schema } from "effect";
import { useStore } from "./store";
import { useThreadList } from "./threadListStore";
import type { SidebarThreadSummary } from "./types";

export interface SidebarThreadRow extends SidebarThreadSummary {
  deckId: ThreadDeckId | null;
  deckSortOrder: number;
  workingDirectory: string | null;
  sidebarSortOrder: number | undefined;
  isPinned: boolean;
  parentThreadId: ThreadId | null;
  lastVisitedAt: string | undefined;
  lastMessagePreview: string | null;
  lastActivityAt: string | null;
  latestUserMessageAt: string | null;
  runtimeMode: RuntimeMode;
}

export function buildSidebarThreadRows(
  rows: readonly CleanCoreThreadSummary[],
  details: Readonly<Record<string, SidebarThreadSummary>>,
): readonly SidebarThreadRow[] {
  return rows.flatMap((row) => {
    // The sidebar's folder lists contain assigned threads; unassigned rows are not folder members.
    if (row.folderId === null || row.deletedAt !== null) return [];
    const detail = details[row.id];
    return [
      {
        id: row.id,
        folderId: row.folderId,
        // Display scope remains shell metadata; database scope is used only for page queries.
        ...(detail?.spaceId === undefined ? {} : { spaceId: detail.spaceId }),
        title: row.title,
        modelSelection: Schema.decodeUnknownSync(ModelSelection)({
          provider: row.provider,
          model: row.model,
          ...(row.modelOptions === null ? {} : { options: JSON.parse(row.modelOptions) }),
        }),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        archivedAt: row.archivedAt,
        deckId: row.deckId,
        deckSortOrder: row.deckSortOrder,
        workingDirectory: row.workingDirectory,
        sidebarSortOrder: row.sidebarSortOrder === null ? undefined : row.sidebarSortOrder,
        isPinned: row.isPinned === 1,
        parentThreadId: row.parentThreadId,
        lastVisitedAt: row.lastVisitedAt === null ? undefined : row.lastVisitedAt,
        lastMessagePreview: row.lastMessagePreview,
        lastActivityAt: row.lastActivityAt,
        latestUserMessageAt: row.lastUserMessageAt,
        runtimeMode: Schema.decodeUnknownSync(RuntimeMode)(row.runtimeMode),
        session: detail?.session ?? null,
        latestTurn: detail?.latestTurn ?? null,
        ...(detail?.pendingTurnStartMessageId === undefined
          ? {}
          : { pendingTurnStartMessageId: detail.pendingTurnStartMessageId }),
        ...(detail?.subagentAgentId === undefined
          ? {}
          : { subagentAgentId: detail.subagentAgentId }),
        ...(detail?.subagentNickname === undefined
          ? {}
          : { subagentNickname: detail.subagentNickname }),
        ...(detail?.subagentRole === undefined ? {} : { subagentRole: detail.subagentRole }),
        hasPendingApprovals: detail?.hasPendingApprovals === true,
        hasPendingUserInput: row.openQuestionCount > 0,
        workStatus:
          row.state === "running"
            ? "running"
            : row.state === "error" || row.openQuestionCount > 0
              ? "attention"
              : row.lastActivityAt !== null &&
                  (row.lastVisitedAt === null || row.lastActivityAt > row.lastVisitedAt)
                ? "done"
                : "idle",
      } satisfies SidebarThreadRow,
    ];
  });
}

export function createSidebarThreadRowsSelector() {
  let previousRows: readonly CleanCoreThreadSummary[] | undefined;
  let previousDetails: Readonly<Record<string, SidebarThreadSummary>> | undefined;
  let snapshot: {
    rows: readonly SidebarThreadRow[];
    byId: ReadonlyMap<string, SidebarThreadRow>;
  } = { rows: [], byId: new Map() };
  return (
    rows: readonly CleanCoreThreadSummary[],
    details: Readonly<Record<string, SidebarThreadSummary>>,
  ) => {
    if (rows !== previousRows || details !== previousDetails) {
      previousRows = rows;
      previousDetails = details;
      const derived = buildSidebarThreadRows(rows, details);
      snapshot = { rows: derived, byId: new Map(derived.map((row) => [row.id, row])) };
    }
    return snapshot;
  };
}

// All consumers share one derivation of the current source snapshots.
const selectSidebarRows = createSidebarThreadRowsSelector();
function useSidebarRowsSnapshot() {
  const rows = useThreadList();
  const details = useStore((state) => state.sidebarThreadSummaryById);
  return selectSidebarRows(rows, details);
}

export function useSidebarThreadRows(): readonly SidebarThreadRow[] {
  return useSidebarRowsSnapshot().rows;
}

export function useSidebarThreadRowsById(): ReadonlyMap<string, SidebarThreadRow> {
  return useSidebarRowsSnapshot().byId;
}

export function selectDeckThreadRows(
  rows: readonly SidebarThreadRow[],
  deckId: ThreadDeckId,
): readonly SidebarThreadRow[] {
  return rows
    .filter((row) => row.deckId === deckId && row.archivedAt === null)
    .toSorted(
      (left, right) => left.deckSortOrder - right.deckSortOrder || left.id.localeCompare(right.id),
    );
}
