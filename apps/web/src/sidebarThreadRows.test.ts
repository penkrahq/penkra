import { expect, it, vi } from "vitest";
import { FolderId, ThreadId, type CleanCoreThreadSummary } from "@penkra/contracts";
import {
  buildSidebarThreadRows,
  selectFolderThreadRows,
  createSidebarThreadRowsSelector,
} from "./sidebarThreadRows";
import {
  sortThreadsForSidebar,
  resolveSidebarThreadSummaryStatus,
} from "./components/Sidebar.logic";
import type { SidebarThreadSummary } from "./types";
function row(queue: string, updatedAt: string): CleanCoreThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-51"),
    spaceId: "space" as CleanCoreThreadSummary["spaceId"],
    folderId: FolderId.makeUnsafe("folder"),
    title: "Outside the first page",
    provider: "codex",
    connectionId: null,
    model: "gpt-5.5",
    modelOptions: null,
    runtimeMode: "full-access",
    state: "running",
    activeTurnId: null,
    lastError: null,
    queue,
    createdBy: "user",
    createdByThreadId: null,
    sidebarSortOrder: null,
    lastActivityAt: null,
    lastMessagePreview: null,
    lastUserMessageAt: null,
    lastVisitedAt: null,
    openQuestionCount: 0,
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt,
  };
}

it("takes sidebar ordering, workspace and rollups exclusively from canonical rows", () => {
  const core = {
    ...row("[]", "2026-10-10T00:00:01.000Z"),
    folderId: FolderId.makeUnsafe("folder"),
    sidebarSortOrder: 3,
    lastMessagePreview: "canonical preview",
    lastActivityAt: "2026-10-10T00:00:01.000Z",
    lastUserMessageAt: "2026-10-10T00:00:01.000Z",
  };
  const detail = {
    id: core.id,
    folderId: core.folderId,
    title: "stale title",
    modelSelection: { provider: "codex" as const, model: "stale" },
    session: null,
    createdAt: core.createdAt,
    latestTurn: null,
    hasPendingUserInput: false,
  };
  const rows = buildSidebarThreadRows([core], { [core.id]: detail });
  expect(rows[0]).toMatchObject({
    title: core.title,
    sidebarSortOrder: 3,
    lastMessagePreview: "canonical preview",
    lastActivityAt: core.lastActivityAt,
    latestUserMessageAt: core.lastUserMessageAt,
  });
  const earlier = { ...core, id: ThreadId.makeUnsafe("earlier"), sidebarSortOrder: 0 };
  expect(
    sortThreadsForSidebar(buildSidebarThreadRows([earlier, core], {}), "created_at").map(
      (row) => row.id,
    ),
  ).toEqual([earlier.id, core.id]);
});
it("uses the canonical visit for unread completion even when the projection detail is older", () => {
  const completedAt = "2026-10-10T00:00:01.000Z";
  const core = {
    ...row("[]", completedAt),
    folderId: FolderId.makeUnsafe("folder"),
    state: "idle",
    lastActivityAt: completedAt,
  };
  const detail: SidebarThreadSummary = {
    id: core.id,
    folderId: core.folderId,
    title: core.title,
    modelSelection: { provider: "codex", model: core.model },
    session: null,
    createdAt: core.createdAt,
    latestTurn: {
      turnId: "turn" as NonNullable<SidebarThreadSummary["latestTurn"]>["turnId"],
      state: "completed",
      assistantMessageId: null,
      requestedAt: core.createdAt,
      startedAt: core.createdAt,
      completedAt,
    },
    hasPendingUserInput: false,
  };
  const unread = buildSidebarThreadRows([core], { [core.id]: detail })[0]!;
  expect(
    resolveSidebarThreadSummaryStatus({ thread: unread, lastVisitedAt: unread.lastVisitedAt })
      ?.label,
  ).toBe("Completed");
  const visited = buildSidebarThreadRows([{ ...core, lastVisitedAt: completedAt }], {
    [core.id]: detail,
  })[0]!;
  expect(
    resolveSidebarThreadSummaryStatus({ thread: visited, lastVisitedAt: visited.lastVisitedAt }),
  ).toBeNull();
});

it("derives folder tabs in sidebar order and hides archived threads, including published moves", () => {
  const folderId = FolderId.makeUnsafe("folder");
  const first = { ...row("[]", "2026-10-10T00:00:01.000Z"), folderId, sidebarSortOrder: 2 };
  const second = { ...first, id: ThreadId.makeUnsafe("second"), sidebarSortOrder: 1 };
  const archived = { ...first, id: ThreadId.makeUnsafe("archived"), archivedAt: first.updatedAt };
  const other = {
    ...first,
    id: ThreadId.makeUnsafe("other"),
    folderId: FolderId.makeUnsafe("other-folder"),
  };
  const rows = buildSidebarThreadRows([first, second, archived, other], {});
  expect(selectFolderThreadRows(rows, folderId).map((row) => row.id)).toEqual([
    second.id,
    first.id,
  ]);
  const moved = buildSidebarThreadRows(
    [{ ...first, folderId: other.folderId }, second, archived, other],
    {},
  );
  expect(selectFolderThreadRows(moved, folderId).map((row) => row.id)).toEqual([second.id]);
});

it("shares one row derivation and by-id lookup across consumers for each source snapshot", () => {
  const core = {
    ...row("[]", "2026-10-10T00:00:01.000Z"),
    folderId: FolderId.makeUnsafe("folder"),
    modelOptions: JSON.stringify({ reasoningEffort: "high" }),
  };
  const rows = [core];
  const details = {};
  const select = createSidebarThreadRowsSelector();
  const parse = vi.spyOn(JSON, "parse");
  try {
    const first = select(rows, details);
    for (let index = 0; index < 100; index++) {
      expect(select(rows, details)).toBe(first);
      expect(select(rows, details).byId.get(core.id)).toBe(first.rows[0]);
    }
    expect(parse).toHaveBeenCalledTimes(1);
    const next = select([{ ...core, title: "Renamed" }], details);
    expect(next).not.toBe(first);
    expect(next.byId.get(core.id)?.title).toBe("Renamed");
    expect(select([], details).byId.has(core.id)).toBe(false);
  } finally {
    parse.mockRestore();
  }
});

it("shows an unopened running row as Working without session or turn detail", () => {
  const thread = buildSidebarThreadRows([row("[]", "2026-10-10T00:00:00.000Z")], {})[0]!;
  expect(thread.session).toBeNull();
  expect(thread.latestTurn).toBeNull();
  expect(
    resolveSidebarThreadSummaryStatus({ thread, lastVisitedAt: thread.lastVisitedAt }),
  ).toMatchObject({ label: "Working", pulse: true });
});
